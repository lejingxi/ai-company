import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../src/server/api.js';
import type { AppConfig } from '../src/server/config.js';
import { AppError } from '../src/server/policy.js';
import { fingerprintCurrentZcode, ZcodeRunner } from '../src/server/runners/zcode.js';
import type { AgentOutput, AuthState, Capabilities, ExecutionCheck, ModelBinding, ModelCatalogState, Project, RunnerInput, Task } from '../src/shared/types.js';

const CANARY = 'TEST_SECRET_CANARY';
const URL_CANARY = 'https://never.invalid/v1';
const POLICY = 'selected-model-zcode-v2';
function providerConfig() {
  return { schemaVersion: 1, config: {
    providerOrder: ['provider-a'],
    providerConfigRules: { providerRules: [{ providerId: 'provider-a', providerName: 'test', config: {
      group: 'standard-personal', access: { type: 'api-key', apiKey: CANARY },
      api: { type: 'openai-chat-completions', baseUrl: URL_CANARY },
      personalModelIds: ['model-a', 'model-b'], modelOrder: ['model-a', 'model-b'],
    } }] },
    modelConfigRules: { providerModelRules: [{ providerId: 'provider-a', modelId: 'model-a', config: {
      enabled: true, optionSpecs: { reasoningLevel: { values: ['low', 'high'] } },
    } }], manualProviderModelRules: [] },
  } };
}
function removeTree(directory: string) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fs.unlinkSync(file);
    else if (entry.isDirectory()) removeTree(file);
    else { fs.chmodSync(file, 0o600); fs.unlinkSync(file); }
  }
  fs.rmdirSync(directory);
}
function snapshot(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false);
    return entry.isDirectory() ? snapshot(file) : [`${file}:${fs.readFileSync(file).toString('base64')}`];
  }).sort();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const conflict = (error: unknown) => error instanceof AppError && error.status === 409;

// Only a fresh temporary SQLite DB, fake home/config, and ephemeral loopback listener.
// GET/save/check use the real catalog service and cannot spawn or contact a provider.
async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'zhiyansi-model-selection-'));
  const home = path.join(dir, 'home'), catalogFile = path.join(home, '.zcode', 'v2', 'provider_config.json');
  fs.mkdirSync(path.dirname(catalogFile), { recursive: true });
  const writeCatalog = (value: unknown) => fs.writeFileSync(catalogFile, JSON.stringify(value));
  writeCatalog(providerConfig());
  const cliConfig = path.join(home, '.zcode', 'cli', 'config.json');
  fs.mkdirSync(path.dirname(cliConfig), { recursive: true });
  fs.writeFileSync(cliConfig, JSON.stringify({ untouched: CANARY }));
  const env: NodeJS.ProcessEnv = {
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'config'), LOCALAPPDATA: path.join(home, 'local'),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'),
    HOMEDRIVE: path.parse(home).root.slice(0, 2), HOMEPATH: home.slice(2),
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: catalogFile, ZCODE_DATA_BASE_DIR: home,
  };
  const originalEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const config: AppConfig = {
    port: 0, dataDir: path.join(dir, 'data'), workspaceRoot: path.join(dir, 'workspaces'), modelCatalogPath: catalogFile,
    realExecutionEnabled: true, monitoringEnabled: false,
    zcode: { electronPath: path.join(dir, 'never-execute-node.exe'), cliPath: path.join(dir, 'never-execute-cli.cjs'),
      enabled: true, environmentMode: 'existing-user', isolationVerified: true, timeoutMs: 100 },
    docker: { executable: path.join(dir, 'never-execute-docker.exe'), image: 'fixture-node:24', timeoutMs: 100 },
  };
  for (const file of [config.zcode.electronPath, config.zcode.cliPath]) fs.writeFileSync(file, 'inert test file');
  const forbidden: string[] = [];
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
    t.mock.method(childProcess, method, () => { forbidden.push(method); throw new Error('No subprocess is permitted in model-selection API tests'); });
  }
  const runner = t.mock.method(ZcodeRunner.prototype, 'run', async () => {
    forbidden.push('model runner'); throw new Error('No paid model invocation is permitted');
  });
  let app!: ReturnType<typeof createApp>, open = false, base = '', cookie = '', csrf = '';
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== base) { forbidden.push('external fetch'); throw new Error('Only this test loopback listener is permitted'); }
    return realFetch(input, { ...init, redirect: 'error', signal: init?.signal ?? AbortSignal.timeout(5000) });
  }) as typeof fetch);
  const connect = net.Socket.prototype.connect;
  t.mock.method(net.Socket.prototype, 'connect', function (this: net.Socket, ...args: unknown[]) {
    const normalized = Array.isArray(args[0]) ? args[0] : args;
    const options = normalized[0];
    const target = options && typeof options === 'object' ? options as { host?: string; port?: number | string; path?: string }
      : { host: typeof normalized[1] === 'string' ? normalized[1] : 'localhost', port: options as number };
    const allowed = base && !target.path && target.host === '127.0.0.1' && String(target.port) === new URL(base).port;
    if (!allowed) { forbidden.push('external socket'); throw new Error('Only this test loopback socket is permitted'); }
    return Reflect.apply(connect, this, args);
  });
  syncBuiltinESMExports();
  t.after(async () => {
    try {
      if (open) { open = false; await app.close(); }
      assert.deepEqual(forbidden, [], 'No model, CLI, Docker or non-loopback connection may be attempted');
    } finally {
      t.mock.restoreAll(); syncBuiltinESMExports();
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      removeTree(dir);
    }
  });
  const start = async () => {
    app = createApp(config); open = true;
    await new Promise<void>((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', () => { app.server.off('error', reject); resolve(); });
    });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  };
  const request = async <T = any>(route: string, method = 'GET', value?: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(base + route, { method, headers: {
      Origin: base, Cookie: cookie, 'X-CSRF-Token': csrf,
      ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra,
    }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, headers: response.headers, body: await response.json() as T };
  };
  const read = async () => {
    const response = await request<ModelCatalogState>('/api/execution/models');
    assert.equal(response.status, 200); return response.body;
  };
  const payload = (state: ModelCatalogState, modelId = 'model-a', reasoningLevel: string | null = null) => {
    const model = state.catalog.models.find(item => item.modelId === modelId);
    assert.ok(model, `Fixture must contain ${modelId}`);
    assert.ok(state.catalog.catalogRevision);
    return { modelId: model.id, reasoningLevel, expectedRevision: state.selectionRevision, expectedCatalogRevision: state.catalog.catalogRevision };
  };
  const select = async (modelId = 'model-a', reasoningLevel: string | null = null) => {
    const response = await request<ModelCatalogState>('/api/execution/model', 'PATCH', payload(await read(), modelId, reasoningLevel));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.selection); return response.body;
  };
  await start();
  const setup = await request<AuthState>('/api/auth/setup', 'POST', { username: 'model-test-admin', password: 'Model-Test-Password-Only-2026!' });
  assert.equal(setup.status, 200); assert.ok(setup.body.user); assert.ok(setup.body.csrfToken);
  cookie = setup.headers.get('set-cookie')!.split(';')[0]; csrf = setup.body.csrfToken;
  const restart = async () => { open = false; await app.close(); await start(); };
  const task = (taskId = 'model-task', p?: Project) => {
    const project = p ?? app.store.put('projects', {
      id: 'model-project', name: 'Model fixture', description: 'Never real work',
      workspace: app.workflow.workspaces.createProject('model-project'), leadId: null, stack: 'node',
      testCommand: ['node', '--test', 'tests'], dockerImage: config.docker.image, createdAt: new Date().toISOString(),
    });
    const employees = app.store.all('employees');
    for (const employee of employees) app.store.put('employees', { ...employee, projectIds: [project.id] });
    const value: Task = { id: taskId, title: 'Model fixture', goal: 'No external execution', projectId: project.id,
      leaderId: employees.find(e => e.role === 'lead')!.id, developerId: employees.find(e => e.role === 'developer')!.id,
      qaId: employees.find(e => e.role === 'qa')!.id, status: 'draft', mode: null, version: 1, modelBinding: null,
      contentHash: null, plan: null, blockedReason: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    return { project, task: app.store.put('tasks', value) };
  };
  return { get app() { return app; }, config, home, dir, catalogFile, writeCatalog, request, read, select, payload, restart, task, runner, userId: setup.body.user.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function assertNoSecrets(value: unknown, f: Fixture) {
  const serialized = JSON.stringify(value);
  for (const secret of [CANARY, URL_CANARY, 'never.invalid', f.home, f.catalogFile]) assert.equal(serialized.includes(secret), false, 'No source secret, URL or private path may escape');
}
function evidence(f: Fixture, binding: ModelBinding, id = 'fixture-check'): ExecutionCheck {
  return f.app.store.put('executionChecks', { id, target: 'zcode', status: 'ready', environmentMode: 'existing-user', policyVersion: POLICY,
    fingerprint: fingerprintCurrentZcode({ ...f.config.zcode, modelBinding: binding }), checkedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), checkedBy: f.userId, processInstanceId: f.app.workflow.execution.instanceId,
    projectId: null, taskId: null, image: null, imageDigest: null, result: 'Synthetic evidence only', model: binding.modelId,
    observedTools: ['Read', 'Write'], sessionId: 'fixture-check-session', modelBinding: binding });
}

test('model metadata is a strict safe whitelist; GET never probes, selects or leaks provider secrets', async t => {
  const f = await fixture(t), files = snapshot(f.home);
  const state = await f.read();
  assert.deepEqual(Object.keys(state).sort(), ['bindingSupport', 'catalog', 'selection', 'selectionRevision', 'selectionStatus']);
  assert.deepEqual(Object.keys(state.catalog).sort(), ['catalogRevision', 'configuredDefault', 'coverage', 'models', 'reason', 'refreshedAt', 'source']);
  assert.equal(state.catalog.coverage, 'partial'); assert.equal(state.catalog.source, 'zcode-personal-config');
  assert.match(state.catalog.catalogRevision!, /^[a-f0-9]{64}$/);
  assert.deepEqual(state.catalog.models.map(model => model.modelId), ['model-a', 'model-b']);
  for (const model of state.catalog.models) {
    assert.deepEqual(Object.keys(model).sort(), ['availabilityConfigured', 'enabled', 'executionSupport', 'id', 'label', 'modelId', 'providerId', 'providerLabel', 'reason', 'reasoningDefault', 'reasoningLevels', 'reasoningSource', 'reasoningSupport', 'source']);
    assert.equal(model.providerId, 'provider-a'); assert.equal(model.providerLabel, 'test');
    assert.equal(model.enabled, true); assert.equal(model.availabilityConfigured, true);
    assert.equal(model.executionSupport, 'session-adapter'); assert.equal(model.source, 'personal-config');
  }
  assert.deepEqual(state.catalog.models[0].reasoningLevels, ['low', 'high']);
  assert.deepEqual(state.catalog.models[1].reasoningLevels, []);
  assert.equal(state.selection, null); assert.equal(state.selectionRevision, 0); assert.equal(state.selectionStatus, 'unset');
  assert.equal(state.bindingSupport.ready, false);
  assertNoSecrets([state, (await f.request('/api/execution')).body, (await f.request('/api/dashboard')).body], f);
  assert.equal(f.app.store.all('modelSelections').length, 0); assert.equal(f.app.store.all('executionChecks').length, 0);
  assert.equal(f.app.store.all('runs').length, 0); assert.equal(f.runner.mock.callCount(), 0);
  assert.deepEqual(snapshot(f.home), files);
});

test('model endpoints require authentication/CSRF and reject malformed, unknown or undeclared selections', async t => {
  const f = await fixture(t), state = await f.read(), valid = f.payload(state);
  assert.equal((await f.request('/api/execution/models', 'GET', undefined, { Cookie: '' })).status, 401);
  assert.equal((await f.request('/api/execution/model', 'PATCH', valid, { Cookie: '' })).status, 401);
  assert.equal((await f.request('/api/execution/model', 'PATCH', valid, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await f.request('/api/execution/model', 'PATCH', valid, { Origin: 'https://outside.invalid' })).status, 403);
  assert.equal((await f.request('/api/execution/model', 'POST', valid)).status, 404);
  const invalid = [null, [], {}, { ...valid, modelId: ['provider-a/model-a'] }, { ...valid, modelId: 'model-a' },
    { ...valid, modelId: 'provider-a/missing' }, { ...valid, reasoningLevel: 1 }, { ...valid, reasoningLevel: 'ultra' },
    { ...valid, expectedRevision: -1 }, { ...valid, expectedRevision: 0.5 }, { ...valid, expectedRevision: '0' },
    { ...valid, expectedCatalogRevision: [] }, { ...valid, expectedCatalogRevision: 'invalid' }, { ...valid, apiKey: CANARY },
    { modelId: valid.modelId, expectedRevision: 0, expectedCatalogRevision: valid.expectedCatalogRevision },
    { ...f.payload(state, 'model-b'), reasoningLevel: 'low' }];
  for (const value of invalid) {
    const response = await f.request('/api/execution/model', 'PATCH', value);
    assert.equal(response.status, 400, JSON.stringify(value)); assertNoSecrets(response.body, f);
  }
  assert.equal(f.app.store.all('modelSelections').length, 0); assert.equal(f.app.store.all('executionChecks').length, 0);
  assert.equal(f.runner.mock.callCount(), 0);
});

test('saving persists only app-default selection, is idempotent, survives restart and never rewrites global config', async t => {
  const f = await fixture(t), files = snapshot(f.home);
  const saved = await f.select('model-a', 'low');
  assert.equal(saved.selectionStatus, 'configured'); assert.equal(saved.selectionRevision, 1);
  assert.equal(saved.selection!.id, 'app-default'); assert.equal(saved.selection!.updatedBy, f.userId);
  assert.equal(saved.selection!.catalogId, 'provider-a/model-a'); assert.equal(saved.selection!.reasoningLevel, 'low');
  assert.equal(saved.bindingSupport.ready, false);
  assert.deepEqual(f.app.store.all('modelSelections'), [saved.selection]);
  const again = await f.select('model-a', 'low');
  assert.deepEqual(again.selection, saved.selection); assert.equal(again.selectionRevision, 1);
  assert.deepEqual(snapshot(f.home), files);
  assertNoSecrets(f.app.store.sql.prepare('SELECT collection, body FROM records').all(), f);
  await f.restart();
  const restored = await f.read();
  assert.deepEqual(restored.selection, saved.selection); assert.equal(restored.selectionStatus, 'configured');
  assert.equal(restored.bindingSupport.ready, false); assert.equal(f.app.store.all('executionChecks').length, 0);
  assert.deepEqual(snapshot(f.home), files);
});

test('selection CAS and concurrent catalog changes return 409 without committing a stale selection', async t => {
  const f = await fixture(t), initial = await f.read();
  const responses = await Promise.all(['model-a', 'model-b'].map(model => f.request('/api/execution/model', 'PATCH', f.payload(initial, model))));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const saved = await f.read(); assert.equal(saved.selectionRevision, 1);
  const stale = f.payload(saved, saved.selection!.modelId === 'model-a' ? 'model-b' : 'model-a');
  const changed = providerConfig(); changed.config.providerConfigRules.providerRules[0].config.access.apiKey += '_ROTATED';
  f.writeCatalog(changed);
  assert.equal((await f.request('/api/execution/model', 'PATCH', stale)).status, 409);
  assert.deepEqual(f.app.store.all('modelSelections'), [saved.selection]);
  const fresh = await f.read(); assert.equal(fresh.selectionStatus, 'stale');
  const revoke = f.app.workflow.execution.invalidateModels.bind(f.app.workflow.execution);
  t.mock.method(f.app.workflow.execution, 'invalidateModels', (...args: Parameters<typeof revoke>) => {
    const result = revoke(...args);
    fs.appendFileSync(f.catalogFile, '\n'); // Deterministic write during the synchronous save transaction.
    return result;
  });
  const raced = await f.request('/api/execution/model', 'PATCH', f.payload(fresh, stale.modelId.split('/')[1]));
  assert.equal(raced.status, 409); assert.deepEqual(f.app.store.all('modelSelections'), [saved.selection]);
  assertNoSecrets(raced.body, f); assert.equal(f.app.store.all('runs').length, 0);
});

test('disabled, removed or unconfigured models invalidate saved bindings and cannot fall back to another entry', async t => {
  const f = await fixture(t), saved = await f.select('model-a', 'low');
  const disabled = providerConfig(); disabled.config.modelConfigRules.providerModelRules[0].config.enabled = false;
  const removed = providerConfig(); removed.config.providerConfigRules.providerRules[0].config.personalModelIds = ['model-b'];
  const unconfigured = providerConfig(); unconfigured.config.providerConfigRules.providerRules[0].config.access.apiKey = '';
  for (const source of [disabled, removed, unconfigured]) {
    f.writeCatalog(source);
    const state = await f.read();
    assert.equal(state.selectionStatus, 'stale'); assert.deepEqual(state.selection, saved.selection);
    assert.equal(state.bindingSupport.ready, false);
    assert.throws(() => f.app.workflow.execution.models.resolveSelectedModel(), conflict);
    const response = await f.request('/api/execution/model', 'PATCH', {
      modelId: saved.selection!.catalogId, reasoningLevel: 'low', expectedRevision: 1, expectedCatalogRevision: state.catalog.catalogRevision,
    });
    assert.equal(response.status, 400);
    assert.equal((await f.request('/api/execution/check', 'POST', { target: 'zcode' })).status, 409);
    assert.deepEqual(f.app.store.all('modelSelections'), [saved.selection]);
  }
  assert.equal(f.app.store.all('executionChecks').length, 0); assert.equal(f.runner.mock.callCount(), 0);
});

test('real unsupported service rejects unset and selected checks/work before probe, subprocess or default-model fallback', async t => {
  const f = await fixture(t), execution = f.app.workflow.execution;
  const probe = t.mock.method(execution as unknown as { probeZcode: (...args: unknown[]) => Promise<void> }, 'probeZcode');
  const { task } = f.task();
  assert.equal((await f.request('/api/execution/check', 'POST', { target: 'zcode' })).status, 409);
  assert.equal((await f.request(`/api/tasks/${task.id}/run`, 'POST', { mode: 'zcode' })).status, 409);
  await f.select('model-a', 'high');
  const binding = execution.models.resolveSelectedModel();
  assert.equal(execution.models.bindingSupport(binding).ready, false);
  evidence(f, binding, 'forged-ready-does-not-authorize');
  assert.equal((await f.request('/api/execution/check', 'POST', { target: 'zcode' })).status, 409);
  assert.equal((await f.request(`/api/tasks/${task.id}/run`, 'POST', { mode: 'zcode' })).status, 409);
  assert.equal((await f.request('/api/execution')).body.zcode.ready, false);
  assert.equal((await f.request('/api/health')).body.realExecutionEnabled, false);
  assert.equal((await f.request('/api/dashboard')).body.capabilities.realExecution.ready, false);
  assert.equal(probe.mock.callCount(), 0); assert.equal(f.runner.mock.callCount(), 0);
  assert.equal(f.app.store.all('executionChecks').length, 1, 'No check record or probe is started by a rejected check');
  assert.equal(f.app.store.all('runs').length, 0); assert.equal(f.app.workflow.task(task.id).status, 'draft');
  assert.equal((f.app.store.sql.prepare('SELECT count(*) AS n FROM jobs').get() as { n: number }).n, 0);
});

test('A→B→A advances evidence/session fingerprints and changing selection cancels queued/running real tasks only', { timeout: 15_000 }, async t => {
  const f = await fixture(t), { workflow, store } = f.app, execution = workflow.execution;
  const a1 = (await f.select('model-a', 'low')).selection!;
  const bindingA1 = execution.models.resolveSelectedModel();
  const checkA1 = evidence(f, bindingA1);
  // Test-only readiness/runner: execute the real queue, cancellation and session state machine, never a model or Docker.
  t.mock.method(execution.models, 'bindingSupport', () => ({ ready: true, reason: 'Test-only model binding support' }));
  const capabilities: Capabilities = {
    zcode: { ready: true, reason: 'fixture' }, docker: { ready: true, reason: 'fixture' }, realExecution: { ready: true, reason: 'fixture' },
    mergeExecution: { ready: false, reason: 'disabled' }, releaseExecution: { ready: false, reason: 'disabled' },
  };
  t.mock.method(workflow, 'capabilities', async () => capabilities);
  t.mock.method(execution, 'assertProjectReady', async (_project: Project, _signal?: AbortSignal, expected?: ModelBinding) => {
    const modelBinding = expected && 'employeeId' in expected ? execution.models.effectiveBinding(String(expected.employeeId), expected) : execution.models.resolveSelectedModel(expected);
    return { options: { ...f.config.zcode, modelBinding, verificationFingerprint: fingerprintCurrentZcode({ ...f.config.zcode, modelBinding }) },
      zcodeCheckId: `test-check-${modelBinding.selectionRevision}`, dockerDigest: `sha256:${'a'.repeat(64)}`, modelBinding };
  });
  const history = f.task('session-task');
  workflow.workspaces.createTask(history.project, history.task.id);
  const running = f.task('running-real', history.project).task, queued = f.task('queued-real', history.project).task;
  const entered = deferred<AbortSignal>(), inputs: RunnerInput[] = [];
  t.mock.method(ZcodeRunner.prototype, 'run', async (input: RunnerInput): Promise<AgentOutput> => {
    inputs.push(input);
    if (input.task.id === running.id) {
      entered.resolve(input.signal);
      await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { summary: `late ignored ${CANARY}`, files: [], sessionId: 'must-not-be-saved' };
    }
    return { summary: 'Synthetic planning only', files: [], sessionId: `fixture-session-${input.task.participantModelBindings![input.employee.id].selectionRevision}` };
  });
  const historyRun = async (binding: ModelBinding) => {
    const participant = execution.models.effectiveBinding(history.task.leaderId);
    store.put('tasks', { ...history.task, mode: 'zcode', status: 'awaiting_merge', modelBinding: null, participantModelBindings: { [history.task.leaderId]: participant }, batchId: 'fixed-history-batch' });
    const hook = workflow as unknown as { runAgent(taskId: string, employeeId: string, stage: 'planning', signal: AbortSignal): Promise<{ output: AgentOutput; runId: string }> };
    const result = await hook.runAgent(history.task.id, history.task.leaderId, 'planning', new AbortController().signal);
    return store.get('runs', result.runId)!;
  };
  const first = await historyRun(bindingA1);
  await historyRun(bindingA1);
  assert.equal(inputs[0].sessionId, undefined); assert.equal(inputs[1].sessionId, 'fixture-session-1');
  assert.equal((await f.request(`/api/tasks/${running.id}/run`, 'POST', { mode: 'zcode' })).status, 202);
  const signal = await entered.promise;
  assert.equal((await f.request(`/api/tasks/${queued.id}/run`, 'POST', { mode: 'zcode' })).status, 202);
  for (const status of ['queued', 'running'] as const) {
    const simulation = f.task(`untouched-${status}-simulation`, history.project).task;
    store.put('tasks', { ...simulation, mode: 'simulation', status: 'planning' });
    store.sql.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(simulation.id, simulation.id, status, '2026-01-01', '2026-01-01');
  }
  const b = (await f.select('model-b')).selection!;
  assert.equal(signal.aborted, true); await workflow.waitForIdle();
  for (const task of [running, queued]) {
    assert.equal(workflow.task(task.id).status, 'cancelled');
    assert.equal((store.sql.prepare('SELECT status FROM jobs WHERE task_id=?').get(task.id) as { status: string }).status, 'cancelled');
  }
  for (const status of ['queued', 'running']) {
    assert.equal(workflow.task(`untouched-${status}-simulation`).status, 'planning');
    assert.equal((store.sql.prepare('SELECT status FROM jobs WHERE task_id=?').get(`untouched-${status}-simulation`) as { status: string }).status, status);
  }
  const cancelled = store.all('runs').find(run => run.taskId === running.id)!;
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.output, ''); assert.equal(cancelled.sessionId, null);
  assert.equal(store.all('runs').some(run => run.taskId === queued.id), false);
  assert.equal(store.all('tests').length, 0);
  assert.equal(store.get('executionChecks', checkA1.id)!.status, 'revoked');
  assert.throws(() => execution.models.resolveSelectedModel(bindingA1), conflict);
  const middle = await historyRun(execution.models.resolveSelectedModel());
  const a2 = (await f.select('model-a', 'low')).selection!;
  const bindingA2 = execution.models.resolveSelectedModel();
  const last = await historyRun(bindingA2);
  assert.deepEqual([a1.selectionRevision, b.selectionRevision, a2.selectionRevision], [1, 2, 3]);
  assert.notEqual(a1.selectionFingerprint, a2.selectionFingerprint);
  assert.notEqual(first.contextFingerprint, middle.contextFingerprint); assert.notEqual(first.contextFingerprint, last.contextFingerprint);
  assert.notEqual(checkA1.fingerprint, fingerprintCurrentZcode({ ...f.config.zcode, modelBinding: bindingA2 }));
  assert.equal(inputs.filter(input => input.task.id === history.task.id).at(-1)!.sessionId, undefined, 'A→B→A cannot resume the original A session');
  assert.deepEqual(last.modelBinding, execution.models.effectiveBinding(history.task.leaderId)); assert.throws(() => execution.models.resolveSelectedModel(bindingA1), conflict);
  assertNoSecrets(store.sql.prepare('SELECT body FROM records').all(), f);
});

test('reload preserves stale selection without choosing a configured default; missing/invalid source errors stay generic', async t => {
  const f = await fixture(t);
  const source = providerConfig();
  f.writeCatalog({ ...source, config: { ...source.config, defaultModelSelection: { providerId: 'provider-a', modelId: 'model-b' } } });
  const initial = await f.read();
  assert.deepEqual(initial.catalog.configuredDefault, { providerId: 'provider-a', modelId: 'model-b' });
  assert.equal(initial.selectionStatus, 'unset'); assert.equal(initial.selection, null, 'Loading/restoring metadata does not choose the global default');
  const saved = (await f.select('model-a')).selection!;
  fs.appendFileSync(f.catalogFile, '\n');
  await f.restart();
  const stale = await f.read(); assert.equal(stale.selectionStatus, 'stale'); assert.deepEqual(stale.selection, saved);
  assert.equal((await f.request('/api/execution/check', 'POST', { target: 'zcode' })).status, 409);
  for (const kind of ['missing', 'invalid-json', 'directory'] as const) {
    fs.rmSync(f.catalogFile, { recursive: true, force: true });
    if (kind === 'invalid-json') fs.writeFileSync(f.catalogFile, `{"apiKey":"${CANARY}","baseUrl":"${URL_CANARY}",BROKEN`);
    if (kind === 'directory') fs.mkdirSync(f.catalogFile);
    const state = await f.read();
    assert.equal(state.catalog.coverage, 'unavailable'); assert.equal(state.catalog.catalogRevision, null);
    assert.deepEqual(state.catalog.models, []); assert.equal(state.selectionStatus, 'stale'); assert.deepEqual(state.selection, saved);
    assert.equal(state.bindingSupport.ready, false); assertNoSecrets(state, f);
    assert.doesNotMatch(state.catalog.reason, /ENOENT|EACCES|EISDIR|SyntaxError|BROKEN/);
    assert.equal((await f.request('/api/execution/check', 'POST', { target: 'zcode' })).status, 409);
  }
  assert.equal(f.app.store.all('executionChecks').length, 0); assert.equal(f.app.store.all('runs').length, 0);
  assert.deepEqual(f.app.store.all('modelSelections'), [saved]); assert.equal(f.runner.mock.callCount(), 0);
});
