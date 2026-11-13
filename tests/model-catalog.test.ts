import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Store } from '../src/server/db.js';
import { ModelCatalogService, parseModelCatalog, readModelCatalog } from '../src/server/model-catalog.js';
import { AppError, type Actor } from '../src/server/policy.js';
import type { ModelBinding, ModelCatalogState } from '../src/shared/types.js';

const TIMESTAMP = '2026-11-12T12:00:00.000Z';
const KEY = 'CATALOG_FIXTURE_CREDENTIAL_CANARY_NOT_REAL';
const HEADER = 'CATALOG_FIXTURE_HEADER_CANARY_NOT_REAL';
const URL_CANARY = 'https://catalog-fixture.invalid/private-v1';
const human: Actor = { type: 'user', id: 'fixture-human' };
const status = (expected: number) => (error: unknown) => error instanceof AppError && error.status === expected;
// Intentionally mutable synthetic JSON, including unknown/malformed shapes under test.
function config(): any {
  const provider = (providerId: string, modelIds: string[]) => ({ providerId, providerName: `Provider ${providerId}`, templateId: 'ignored-template',
    config: { group: 'standard-personal', access: { type: 'api-key', apiKey: KEY }, api: { type: 'openai-compatible', baseUrl: URL_CANARY, headers: { Authorization: HEADER } }, personalModelIds: modelIds, modelOrder: [...modelIds].reverse() } });
  return { schemaVersion: 1, privateExtension: { apiKey: KEY, headers: { authorization: HEADER }, baseUrl: URL_CANARY }, config: {
    providerOrder: ['beta', 'alpha', 'empty', 'bigmodel'], providerConfigRules: { providerRules: [
      provider('alpha', ['model-a', 'vendor/model-b', 'model-off', 'model-plain']), provider('beta', ['model-a']),
      { ...provider('empty', ['model-c']), config: { ...provider('empty', ['model-c']).config, access: { type: 'oauth', token: KEY } } },
      { providerId: 'bigmodel', templateId: 'bigmodel', config: { group: 'standard-personal', access: { apiKey: KEY }, modelOrder: ['never-invent-me'] } },
    ] }, modelConfigRules: { providerModelRules: [
      { providerId: 'alpha', modelId: 'model-a', config: { properties: { name: 'Model A', description: KEY, baseUrl: URL_CANARY }, optionSpecs: { reasoningLevel: { values: ['low', 'high'] }, ignored: { headers: { secret: HEADER } } } } },
      { providerId: 'alpha', modelId: 'vendor/model-b', config: { properties: { name: 'Nested Model' }, optionSpecs: { reasoningLevel: { values: ['medium'] } } } },
      { providerId: 'alpha', modelId: 'model-off', config: { enabled: false } },
      { providerId: 'alpha', modelId: 'model-plain', config: { properties: { reasoningLevels: ['do-not-infer'], reasoning: true } } },
    ], manualProviderModelRules: [] },
  } };
}
function safe(value: unknown, extra: string[] = []) {
  const output = JSON.stringify(value);
  for (const forbidden of [KEY, HEADER, URL_CANARY, ...extra]) assert.equal(output.includes(forbidden), false, 'Only a whitelist projection may escape');
}
function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ai-company-model-catalog-'));
  const configPath = path.join(directory, 'fixture-personal.json');
  const write = (value: unknown = config()) => fs.writeFileSync(configPath, JSON.stringify(value));
  write();
  const store = new Store(':memory:');
  store.sql.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(human.id, 'fixture-admin', 'not-real', 'not-real', TIMESTAMP);
  const service = new ModelCatalogService(store, { configPath });
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, configPath, store, service, write };
}
function request(state: ModelCatalogState, modelId = 'alpha/model-a', reasoningLevel: string | null = null) {
  return { modelId, reasoningLevel, expectedRevision: state.selectionRevision, expectedCatalogRevision: state.catalog.catalogRevision! };
}
function save(service: ModelCatalogService, modelId = 'alpha/model-a', reasoningLevel: string | null = null, onChanged?: () => void) {
  return service.select(human, request(service.read(), modelId, reasoningLevel), onChanged);
}

// These tests never import createApp, run a service, or read the user's real config.
test('projection preserves explicit identities/order/options, never invents built-ins, and never claims execution', () => {
  const value = config(), original = JSON.stringify(value);
  const result = parseModelCatalog(value, TIMESTAMP);
  assert.equal(JSON.stringify(value), original);
  assert.equal(result.refreshedAt, TIMESTAMP);
  assert.equal(result.coverage, 'partial');
  assert.deepEqual(result.models.map(model => model.id), ['beta/model-a', 'alpha/model-plain', 'alpha/model-off', 'alpha/vendor/model-b', 'alpha/model-a', 'empty/model-c']);
  const model = result.models.find(model => model.id === 'alpha/model-a')!;
  assert.equal(model.label, 'Model A'); assert.equal(model.providerLabel, 'Provider alpha');
  assert.deepEqual(model.reasoningLevels, ['low', 'high']);
  assert.deepEqual(result.models.find(model => model.modelId === 'model-plain')!.reasoningLevels, []);
  assert.equal(result.models.find(model => model.modelId === 'model-off')!.enabled, false);
  assert.equal(result.models.find(model => model.providerId === 'empty')!.availabilityConfigured, false);
  assert.ok(model.availabilityConfigured);
  assert.ok(result.models.every(model => model.executionSupport === 'session-adapter' && model.reason.includes('原生 ZCode app-server')));
  assert.equal(result.configuredDefault, null);
  assert.equal(result.catalogRevision, parseModelCatalog(value).catalogRevision);
  value.config.defaultModelSelection = { providerId: 'alpha', modelId: 'vendor/model-b', options: { reasoningLevel: 'medium' } };
  assert.deepEqual(parseModelCatalog(value).configuredDefault, { providerId: 'alpha', modelId: 'vendor/model-b' });
  safe(result);
});

test('unsafe literals/names, wildcards, duplicate rules and unknown defaults are conservative and diagnostic-free', () => {
  const value = config();
  value.config.providerConfigRules.providerRules[0].providerName = KEY;
  value.config.modelConfigRules.providerModelRules[0].config.properties.name = URL_CANARY;
  value.config.modelConfigRules.providerModelRules[0].config.optionSpecs.reasoningLevel.values = ['low', '*', {}, 'high', 'high', 'x'.repeat(25), KEY, URL_CANARY];
  value.config.providerConfigRules.providerRules[0].config.personalModelIds.push('*', { match: KEY }, '../escape', 'a//b', URL_CANARY, KEY);
  value.config.providerConfigRules.providerRules.push({ providerId: 'slash/provider', config: { group: 'standard-personal', personalModelIds: ['model'] } }, { providerId: { match: '*' }, config: { apiKey: KEY } });
  value.config.modelConfigRules.providerModelRules.push({ providerId: '*', modelId: '*', config: { enabled: false } }, { providerId: 'alpha', modelId: { wildcard: KEY }, config: {} }, { providerId: 'bigmodel', modelId: 'never-invent-me', config: {} });
  value.config.modelConfigRules.manualProviderModelRules.push({ providerId: 'manual', modelId: 'never-invent-me', apiKey: KEY });
  value.config.providerOrder.push(URL_CANARY);
  const result = parseModelCatalog(value);
  assert.equal(result.models.length, 6);
  const model = result.models.find(model => model.id === 'alpha/model-a')!;
  assert.equal(model.providerLabel, 'alpha'); assert.equal(model.label, 'model-a');
  assert.deepEqual(model.reasoningLevels, []);
  assert.equal(model.reasoningSupport, 'unknown', 'malformed option lists must not silently discard unknown entries');
  assert.match(result.reason, /忽略/); safe(result);
  for (const chosen of [
    { providerId: 'bigmodel', modelId: 'never-invent-me' }, { providerId: 'alpha', modelId: 'model-off' },
    { providerId: 'empty', modelId: 'model-c' }, { providerId: 'alpha', modelId: 'model-a', options: { reasoningLevel: 'invented' } }, { providerId: '*', modelId: KEY },
  ]) {
    value.config.defaultModelSelection = chosen;
    const catalog = parseModelCatalog(value); assert.equal(catalog.configuredDefault, null); assert.match(catalog.reason, /默认模型/); safe(catalog);
  }
  value.config.modelConfigRules.providerModelRules.push({ providerId: 'alpha', modelId: 'model-a', config: {} });
  assert.ok(!parseModelCatalog(value).models.some(model => model.id === 'alpha/model-a'));
  value.config.providerConfigRules.providerRules.push({ ...value.config.providerConfigRules.providerRules[1] });
  assert.ok(!parseModelCatalog(value).models.some(model => model.providerId === 'beta'));
  const unsupported = [null, [], {}, { ...config(), schemaVersion: 2 }, { schemaVersion: 1, config: {} }];
  let invoked = false;
  unsupported.push(Object.defineProperty({}, 'schemaVersion', { get() { invoked = true; return 1; } }));
  for (const invalid of unsupported) { const catalog = parseModelCatalog(invalid, KEY); assert.equal(catalog.coverage, 'unavailable'); assert.equal(catalog.catalogRevision, null); safe(catalog); }
  assert.equal(invoked, false);
});

test('reader uses one bounded read, hashes exact bytes, and never writes, spawns or contacts a network', t => {
  const f = fixture(t), before = fs.readFileSync(f.configPath), metadata = fs.statSync(f.configPath);
  const forbidden: string[] = [];
  const deny = (label: string) => () => { forbidden.push(label); throw new Error('Forbidden fixture operation'); };
  for (const method of ['writeFileSync', 'appendFileSync', 'copyFileSync', 'renameSync', 'mkdirSync', 'unlinkSync', 'chmodSync', 'truncateSync'] as const) t.mock.method(fs, method, deny(method));
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) t.mock.method(childProcess, method, deny(method));
  t.mock.method(globalThis, 'fetch', deny('fetch')); t.mock.method(net, 'connect', deny('connect'));
  for (const module of [http, https]) { t.mock.method(module, 'request', deny('request')); t.mock.method(module, 'get', deny('get')); }
  const originalOpen = fs.openSync, originalRead = fs.readSync;
  let reads = 0, opens = 0;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    assert.equal(args[0], f.configPath); assert.equal(typeof args[1], 'number');
    assert.equal((args[1] as number) & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC), 0);
    opens++; return originalOpen(...args);
  });
  t.mock.method(fs, 'readSync', (...args: any[]) => { reads++; return (originalRead as any)(...args); });
  syncBuiltinESMExports();
  const catalog = readModelCatalog({ configPath: f.configPath });
  assert.equal(catalog.coverage, 'partial'); assert.equal(reads, 1); assert.equal(opens, 1);
  assert.equal(catalog.catalogRevision, createHash('sha256').update(before).digest('hex'));
  safe(catalog, [f.directory]); assert.deepEqual(forbidden, []);
  t.mock.restoreAll(); syncBuiltinESMExports();
  assert.deepEqual(fs.readFileSync(f.configPath), before);
  assert.equal(fs.statSync(f.configPath).mtimeMs, metadata.mtimeMs);
});

test('reader bounds malformed files and unsafe paths and resolves only the explicit/environment/default fixture file', t => {
  const f = fixture(t);
  const bad = (configPath: string) => { const result = readModelCatalog({ configPath }); assert.equal(result.coverage, 'unavailable'); assert.equal(result.catalogRevision, null); safe(result, [f.directory, configPath]); };
  for (const file of [path.join(f.directory, 'missing.json'), f.directory, 'relative.json', '//remote.invalid/private.json', '\\\\remote.invalid\\private.json', `${f.directory}/../escape.json`, `${f.directory}\0fixture.json`, '/'.repeat(4097)]) bad(file);
  fs.writeFileSync(f.configPath, `{"apiKey":"${KEY}", invalid`); bad(f.configPath);
  fs.writeFileSync(f.configPath, Buffer.from([0xff, 0xfe])); bad(f.configPath);
  fs.truncateSync(f.configPath, 4 * 1024 * 1024 + 1); bad(f.configPath);
  f.write();
  const target = path.join(f.directory, 'target'), link = path.join(f.directory, 'linked');
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'config.json'), JSON.stringify(config()));
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); bad(path.join(link, 'config.json'));
  const envNames = ['ZCODE_PERSONAL_PROVIDER_CONFIG_FILE', 'ZCODE_DATA_BASE_DIR'] as const;
  const old = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of envNames) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } });
  const home = path.join(f.directory, 'home'), dataBase = path.join(f.directory, 'data-base');
  t.mock.method(os, 'homedir', () => home); syncBuiltinESMExports();
  for (const base of [home, dataBase]) { const file = path.join(base, '.zcode', 'v2', 'provider_config.json'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(config())); }
  delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE; delete process.env.ZCODE_DATA_BASE_DIR;
  assert.equal(readModelCatalog().coverage, 'partial');
  process.env.ZCODE_DATA_BASE_DIR = dataBase;
  assert.equal(readModelCatalog().coverage, 'partial');
  process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = path.join(f.directory, 'missing-override.json');
  assert.equal(readModelCatalog().coverage, 'unavailable', 'Never fall back when an explicit file is absent');
  assert.equal(readModelCatalog({ configPath: f.configPath }).coverage, 'partial');
  process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = f.configPath;
  assert.equal(readModelCatalog().catalogRevision, readModelCatalog({ configPath: f.configPath }).catalogRevision);
});

test('selection is persisted-human-only, requires exact fields/revisions and validates declared reasoning', t => {
  const f = fixture(t), initial = f.service.read(), input = request(initial);
  assert.equal(initial.selectionStatus, 'unset'); assert.equal(initial.selectionRevision, 0); assert.equal(initial.selection, null);
  for (const actor of [{ type: 'agent', id: human.id }, { type: 'user', id: 'missing-user' }, { type: 'user', id: '' }] as Actor[]) assert.throws(() => f.service.select(actor, input), status(403));
  for (const invalid of [null, [], {}, { ...input, providerId: 'beta' }, { ...input, apiKey: KEY }, { ...input, baseUrl: URL_CANARY }, { ...input, expectedRevision: -1 }, { ...input, expectedRevision: 0.5 }, { ...input, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { ...input, expectedCatalogRevision: KEY }, { ...input, reasoningLevel: undefined }, { ...input, modelId: {} }, { ...input, modelId: URL_CANARY }]) assert.throws(() => f.service.select(human, invalid), status(400));
  let invoked = false;
  const accessor = Object.defineProperty({ ...input }, 'modelId', { get() { invoked = true; return 'alpha/model-a'; } });
  assert.throws(() => f.service.select(human, accessor), status(400)); assert.equal(invoked, false);
  for (const modelId of ['alpha/missing', 'alpha/model-off', 'empty/model-c', 'bigmodel/never-invent-me']) assert.throws(() => f.service.select(human, { ...input, modelId }), status(400));
  for (const reasoningLevel of ['medium', 'invented', 'high/extra']) assert.throws(() => f.service.select(human, { ...input, reasoningLevel }), status(400));
  assert.throws(() => f.service.select(human, { ...input, modelId: 'alpha/model-plain', reasoningLevel: 'high' }), status(400));
  assert.throws(() => f.service.resolveSelectedModel(), status(409));
  assert.equal(f.store.all('modelSelections').length, 0); assert.equal(f.store.all('audit').length, 0);
});

test('an unsupported model can be saved as app-only configuration, resolved without executing, and same-value saves are no-ops', t => {
  const f = fixture(t), source = fs.readFileSync(f.configPath);
  let callbacks = 0;
  const state = save(f.service, 'alpha/model-a', 'high', () => { callbacks++; assert.equal(f.store.get('modelSelections', 'app-default')?.selectionRevision, 1); });
  assert.equal(state.selectionStatus, 'configured'); assert.equal(state.selectionRevision, 1); assert.equal(callbacks, 1);
  assert.equal(state.selection?.reasoningLevel, 'high'); assert.equal(state.selection?.updatedBy, human.id);
  assert.deepEqual(Object.keys(f.store.get('modelSelections', 'app-default')!).sort(), ['id', 'providerId', 'modelId', 'catalogId', 'providerLabel', 'label', 'reasoningLevel', 'selectionRevision', 'catalogRevision', 'selectionFingerprint', 'updatedAt', 'updatedBy'].sort());
  const resolved = f.service.resolveSelectedModel();
  assert.deepEqual(Object.keys(resolved).sort(), ['providerId', 'modelId', 'catalogId', 'reasoningLevel', 'selectionRevision', 'catalogRevision', 'selectionFingerprint'].sort());
  assert.deepEqual(f.service.resolveSelectedModel(resolved), resolved);
  assert.equal(f.service.bindingSupport(resolved).ready, false); assert.equal(f.service.bindingSupport().ready, false); assert.equal(state.bindingSupport.ready, false);
  const noOp = save(f.service, 'alpha/model-a', 'high', () => { callbacks++; });
  assert.deepEqual(noOp.selection, state.selection); assert.equal(callbacks, 1); assert.equal(f.store.all('audit').length, 1);
  assert.equal(f.store.all('audit')[0].detail, 'alpha/model-a');
  assert.deepEqual(fs.readFileSync(f.configPath), source);
  assert.deepEqual(new ModelCatalogService(f.store, { configPath: f.configPath }).resolveSelectedModel(), resolved);
  safe({ state, resolved, saved: f.store.all('modelSelections'), audit: f.store.all('audit') }, [f.directory]);
});

test('credential-only/config changes make selections stale; same-ID reselect bumps revision and invalid defaults never substitute', t => {
  const f = fixture(t), first = save(f.service, 'alpha/model-a', 'high'), oldBinding = f.service.resolveSelectedModel();
  const currentConfig = config(); currentConfig.config.providerConfigRules.providerRules[0].config.access.apiKey = `${KEY}_ROTATED`;
  f.write(currentConfig);
  assert.equal(f.service.read().selectionStatus, 'stale'); assert.throws(() => f.service.resolveSelectedModel(), status(409));
  assert.throws(() => f.service.select(human, request(first)), status(409));
  let changed = 0;
  const renewed = save(f.service, 'alpha/model-a', 'high', () => { changed++; });
  assert.equal(changed, 1); assert.equal(renewed.selectionRevision, 2); assert.equal(renewed.selectionStatus, 'configured');
  assert.notEqual(renewed.selection?.catalogRevision, first.selection?.catalogRevision);
  assert.throws(() => f.service.resolveSelectedModel(oldBinding), status(409));
  const variants = [
    (value: any) => { value.config.modelConfigRules.providerModelRules[0].config.enabled = false; },
    (value: any) => { value.config.providerConfigRules.providerRules[0].config.personalModelIds = ['model-plain']; },
    (value: any) => { value.config.providerConfigRules.providerRules[0].config.access = { type: 'api-key', apiKey: '  ' }; },
    (value: any) => { value.config.modelConfigRules.providerModelRules[0].config.optionSpecs.reasoningLevel.values = ['low']; },
    (value: any) => { value.schemaVersion = 99; },
  ];
  for (const mutate of variants) {
    const next = structuredClone(currentConfig); mutate(next); f.write(next);
    const stale = f.service.read(); assert.equal(stale.selectionStatus, 'stale'); assert.equal(stale.selectionRevision, 2);
    assert.throws(() => f.service.resolveSelectedModel(), status(409)); safe(stale, [f.directory, `${KEY}_ROTATED`]);
  }
  fs.unlinkSync(f.configPath); assert.equal(f.service.read().selectionStatus, 'stale');
  f.write(currentConfig); assert.equal(f.service.read().selectionStatus, 'configured');
  const unsetStore = new Store(':memory:');
  try {
    currentConfig.config.defaultModelSelection = { providerId: 'alpha', modelId: 'model-a' }; f.write(currentConfig);
    const service = new ModelCatalogService(unsetStore, { configPath: f.configPath });
    assert.ok(service.read().catalog.configuredDefault); assert.equal(service.read().selectionStatus, 'unset'); assert.throws(() => service.resolveSelectedModel(), status(409));
  } finally { unsetStore.close(); }
});

test('A-to-B-to-A and reasoning changes are monotonic, old requests/bindings fail, and corrupt stored fingerprints are stale', t => {
  const f = fixture(t), first = save(f.service), a = f.service.resolveSelectedModel();
  const other = new ModelCatalogService(f.store, { configPath: f.configPath });
  const second = save(other, 'alpha/vendor/model-b', 'medium'), b = other.resolveSelectedModel();
  const third = save(f.service), again = f.service.resolveSelectedModel();
  assert.deepEqual([first.selectionRevision, second.selectionRevision, third.selectionRevision], [1, 2, 3]);
  assert.notEqual(a.selectionFingerprint, again.selectionFingerprint);
  assert.throws(() => f.service.resolveSelectedModel(a), status(409)); assert.throws(() => f.service.resolveSelectedModel(b), status(409));
  assert.throws(() => f.service.select(human, request(first)), status(409));
  assert.throws(() => f.service.resolveSelectedModel({ ...again, modelId: 'model-plain' }), status(409));
  const high = save(f.service, 'alpha/model-a', 'high'); assert.equal(high.selectionRevision, 4); assert.notEqual(high.selection?.selectionFingerprint, again.selectionFingerprint);
  assert.equal(f.service.bindingSupport({ ...again, modelId: 'forged' }).ready, false);
  f.store.put('modelSelections', { ...high.selection!, selectionFingerprint: '0'.repeat(64) });
  assert.equal(f.service.read().selectionStatus, 'stale'); assert.throws(() => f.service.resolveSelectedModel(), status(409));
  f.store.put('modelSelections', { ...high.selection!, selectionRevision: Number.MAX_SAFE_INTEGER });
  assert.throws(() => save(f.service), status(409));
});

test('selection, audit and callback writes roll back together; optimistic checks happen inside the transaction', t => {
  const f = fixture(t), initial = request(f.service.read());
  assert.throws(() => f.service.select(human, initial, () => { f.store.audit(human.id, 'fixture-revoke', null, 'no sensitive data'); throw new Error('fixture callback failure'); }), /fixture callback failure/);
  assert.equal(f.store.all('modelSelections').length, 0); assert.equal(f.store.all('audit').length, 0);
  let callbacks = 0;
  f.store.sql.exec("CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON records WHEN NEW.collection='audit' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;");
  assert.throws(() => f.service.select(human, initial, () => { callbacks++; }));
  assert.equal(callbacks, 0); assert.equal(f.store.all('modelSelections').length, 0);
  f.store.sql.exec('DROP TRIGGER fixture_audit_failure');
  const transaction = f.store.transaction.bind(f.store);
  t.mock.method(f.store, 'transaction', <T>(fn: () => T): T => transaction(() => {
    const changed = config(); changed.config.providerConfigRules.providerRules[0].config.access.apiKey = `${KEY}_CONCURRENT`;
    f.write(changed); return fn();
  }));
  assert.throws(() => f.service.select(human, initial, () => { callbacks++; }), status(409));
  assert.equal(callbacks, 0); assert.equal(f.store.all('modelSelections').length, 0);
  t.mock.restoreAll();
  f.write();
  f.service.select(human, initial, () => { f.store.audit(human.id, 'fixture-revoke', null, 'revoked'); });
  const before = f.store.get('modelSelections', 'app-default'), audits = f.store.all('audit');
  assert.throws(() => save(f.service, 'beta/model-a', null, () => {
    f.store.audit(human.id, 'fixture-revoke', null, 'rolled back');
    const changed = config(); changed.config.providerConfigRules.providerRules[0].config.access.apiKey = `${KEY}_DURING_CALLBACK`; f.write(changed);
  }), status(409));
  assert.deepEqual(f.store.get('modelSelections', 'app-default'), before); assert.deepEqual(f.store.all('audit'), audits);
});

test('a changing file, denied open or linked file fails closed without path/error leakage', t => {
  const f = fixture(t), read = fs.readSync, lstat = fs.lstatSync;
  const mutated = Buffer.from(JSON.stringify(config()) + ' ');
  t.mock.method(fs, 'readSync', (...args: any[]) => {
    const count = (read as any)(...args);
    fs.writeFileSync(f.configPath, mutated);
    return count;
  });
  const changed = readModelCatalog({ configPath: f.configPath });
  assert.equal(changed.coverage, 'unavailable'); safe(changed, [f.configPath]);
  t.mock.restoreAll(); f.write();
  let opened = false;
  t.mock.method(fs, 'lstatSync', (...args: any[]) => {
    const stat = (lstat as any)(...args);
    if (args[0] === f.configPath) stat.isSymbolicLink = () => true;
    return stat;
  });
  t.mock.method(fs, 'openSync', () => { opened = true; throw new Error(KEY + f.configPath + URL_CANARY); });
  assert.equal(readModelCatalog({ configPath: f.configPath }).coverage, 'unavailable'); assert.equal(opened, false);
  t.mock.restoreAll();
  t.mock.method(fs, 'openSync', () => { throw new Error(KEY + f.configPath + URL_CANARY); });
  const denied = readModelCatalog({ configPath: f.configPath }); assert.equal(denied.coverage, 'unavailable'); safe(denied, [f.configPath]);
});
