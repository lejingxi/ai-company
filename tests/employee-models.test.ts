import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Store } from '../src/server/db.js';
import { ModelCatalogService } from '../src/server/model-catalog.js';
import { AppError, type Actor } from '../src/server/policy.js';
import type { Employee, ModelCatalogState, EmployeeModelState } from '../src/shared/types.js';

const TIMESTAMP = '2026-11-12T12:00:00.000Z';
const API_KEY = 'EMPLOYEE_MODEL_FIXTURE_KEY_NOT_REAL';
const BASE_URL = 'https://employee-model-fixture.invalid/v1';
const human: Actor = { type: 'user', id: 'fixture-human' };
const status = (expected: number) => (error: unknown) => error instanceof AppError && error.status === expected;

function personal(modelIds = ['gpt-6-astra', 'gpt-5.4']) {
  return {
    schemaVersion: 1,
    config: {
      providerOrder: ['fixture-openai'],
      providerConfigRules: {
        providerRules: [{
          providerId: 'fixture-openai', providerName: 'Fixture OpenAI',
          config: {
            group: 'standard-personal',
            access: { type: 'api-key', apiKey: API_KEY },
            api: { type: 'openai-responses', baseUrl: BASE_URL },
            personalModelIds: modelIds, modelOrder: modelIds,
          },
        }],
      },
      modelConfigRules: {
        providerModelRules: modelIds.map(modelId => ({ providerId: 'fixture-openai', modelId, config: {} })),
        manualProviderModelRules: [],
      },
    },
  };
}

function builtin(revision = 44) {
  return {
    schemaVersion: 1, revision,
    config: {
      modelConfigRules: {
        // The final matching model rule wins. Astra deliberately has five levels.
        modelRules: [
          { modelMatch: '.*', config: { optionSpecs: { reasoningLevel: { values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] } } } },
          { modelMatch: '.*gpt-6-astra.*', config: { optionSpecs: { reasoningLevel: { values: ['low', 'medium', 'high', 'xhigh', 'max'] } } } },
        ],
        modelApiRules: [
          { modelMatch: '.*', apiTypeMatch: 'openai-responses', config: { optionSpecs: {
            reasoningLevel: { map: '{"reasoning":{"effort":reasoningLevel}}' },
            maxOutputTokens: { map: '{"max_output_tokens":maxOutputTokens}' },
          } } },
          { modelMatch: '.*gpt-6-astra.*', apiTypeMatch: 'openai-responses', config: { optionSpecs: {
            reasoningLevel: { map: '{"reasoning":{"effort":reasoningLevel}}' },
          } } },
        ],
        providerSiteRules: [], templateModelRules: [], builtinProviderModelRules: [],
      },
    },
  };
}

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ai-company-employee-models-'));
  const configPath = path.join(directory, 'personal.json');
  const builtinConfigPath = path.join(directory, 'builtin.json');
  const write = (value = personal()) => fs.writeFileSync(configPath, JSON.stringify(value));
  const writeBuiltin = (value = builtin()) => fs.writeFileSync(builtinConfigPath, JSON.stringify(value));
  write(); writeBuiltin();
  const store = new Store(':memory:');
  store.sql.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(human.id, 'fixture-admin', 'not-real', 'not-real', TIMESTAMP);
  const employee: Employee = {
    id: 'employee_alice', name: 'Alice', role: 'developer', duties: 'fixture only', reportsTo: null,
    projectIds: [], enabled: true, createdAt: TIMESTAMP,
  };
  store.put('employees', employee);
  const service = new ModelCatalogService(store, { configPath, builtinConfigPath });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, configPath, builtinConfigPath, store, service, employee, write, writeBuiltin };
}

function appPayload(state: ModelCatalogState, modelId = 'fixture-openai/gpt-6-astra', reasoningLevel: string | null = null) {
  assert.ok(state.catalog.catalogRevision);
  return { modelId, reasoningLevel, expectedRevision: state.selectionRevision, expectedCatalogRevision: state.catalog.catalogRevision };
}
function saveApp(service: ModelCatalogService, modelId = 'fixture-openai/gpt-6-astra', reasoningLevel: string | null = null) {
  const state = service.read();
  return service.select(human, appPayload(state, modelId, reasoningLevel));
}
function employeePayload(state: EmployeeModelState, modelId = 'fixture-openai/gpt-6-astra', reasoningLevel: string | null = 'medium') {
  assert.ok(state.catalog.catalogRevision);
  return { mode: 'override' as const, modelId, reasoningLevel, expectedRevision: state.preferenceRevision, expectedCatalogRevision: state.catalog.catalogRevision };
}


test('Astra inherits builtin five levels, last level is the default, and resolveApiConfig returns the opaque maps', t => {
  const f = fixture(t);
  const state = f.service.read();
  const astra = state.catalog.models.find(model => model.id === 'fixture-openai/gpt-6-astra');
  assert.ok(astra);
  assert.deepEqual(astra.reasoningLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(astra.reasoningDefault, 'max');
  assert.equal(astra.reasoningSource, 'builtin');
  assert.equal(astra.reasoningSupport, 'supported');

  saveApp(f.service, 'fixture-openai/gpt-6-astra', null);
  const binding = f.service.resolveSelectedModel();
  const api = f.service.resolveApiConfig(binding);
  assert.equal(api.baseUrl, BASE_URL);
  assert.equal(api.apiKey, API_KEY);
  assert.equal(api.apiType, 'openai-responses');
  assert.equal(api.effectiveReasoning, 'max');
  assert.match(api.reasoningMap ?? '', /reasoning/);
  assert.match(api.maxOutputMap ?? '', /max_output_tokens/);
  assert.equal(api.catalogRevision, state.catalog.catalogRevision);
});

test('employee inherit and override are independent from app selection revisions', t => {
  const f = fixture(t);
  saveApp(f.service, 'fixture-openai/gpt-6-astra', 'high');
  const inherited = f.service.selectEmployee(human, f.employee.id, {
    mode: 'inherit-app', expectedRevision: 0,
  });
  assert.equal(inherited.mode, 'inherit-app');
  assert.equal(inherited.preferenceRevision, 1);
  assert.equal(inherited.effectiveBinding?.source, 'app-default');
  assert.equal(inherited.effectiveBinding?.employeeId, f.employee.id);
  assert.equal(inherited.effectiveReasoning, 'high');

  const override = f.service.selectEmployee(human, f.employee.id, employeePayload(inherited, undefined, 'medium'));
  assert.equal(override.mode, 'override');
  assert.equal(override.preferenceRevision, 2);
  assert.equal(override.effectiveBinding?.source, 'employee-override');
  assert.equal(override.effectiveBinding?.reasoningLevel, 'medium');
  const employeeFingerprint = override.effectiveBinding?.selectionFingerprint;

  saveApp(f.service, 'fixture-openai/gpt-5.4', null);
  const afterAppChange = f.service.readEmployee(f.employee.id);
  assert.equal(afterAppChange.effectiveStatus, 'configured');
  assert.equal(afterAppChange.effectiveBinding?.source, 'employee-override');
  assert.equal(afterAppChange.effectiveBinding?.reasoningLevel, 'medium');
  assert.equal(afterAppChange.effectiveBinding?.selectionFingerprint, employeeFingerprint);
  assert.equal(afterAppChange.preferenceRevision, 2);
});

test('inherit fingerprint includes employee and preference revision, and persisted binding never gains effective source fields', t => {
  const f = fixture(t);
  const app = saveApp(f.service, 'fixture-openai/gpt-6-astra', 'low');
  const state = f.service.selectEmployee(human, f.employee.id, { mode: 'inherit-app', expectedRevision: 0 });
  assert.ok(state.effectiveBinding);
  assert.deepEqual(Object.keys(state.effectiveBinding).sort(), [
    'catalogId', 'catalogRevision', 'employeeId', 'modelId', 'providerId', 'reasoningLevel', 'selectionFingerprint', 'selectionRevision', 'source',
  ]);
  const saved = f.store.get('employeeModelPreferences', f.employee.id);
  assert.ok(saved);
  assert.equal(saved?.id, f.employee.id);
  assert.equal(Object.hasOwn(saved?.binding ?? {}, 'source'), false);
  assert.equal(Object.hasOwn(saved?.binding ?? {}, 'employeeId'), false);
  assert.notEqual(state.effectiveBinding.selectionFingerprint, app.selection!.selectionFingerprint, 'employee scope must be part of the effective fingerprint');

  // A caller-mutated response cannot change the persisted source or next read.
  state.effectiveBinding.source = 'employee-override';
  assert.equal(f.service.readEmployee(f.employee.id).effectiveBinding?.source, 'app-default');
});

test('builtin revision change makes inherited and overridden bindings stale without fallback', t => {
  const f = fixture(t);
  saveApp(f.service, 'fixture-openai/gpt-6-astra', 'high');
  const overridden = f.service.selectEmployee(human, f.employee.id, employeePayload(f.service.readEmployee(f.employee.id), undefined, 'medium'));
  assert.equal(overridden.effectiveStatus, 'configured');
  f.writeBuiltin(builtin(45));

  const stale = f.service.readEmployee(f.employee.id);
  assert.equal(stale.mode, 'override');
  assert.equal(stale.effectiveStatus, 'stale');
  assert.equal(stale.effectiveBinding, null);
  assert.throws(() => f.service.effectiveBinding(f.employee.id), status(409));
  assert.throws(() => f.service.resolveApiConfig(overridden.effectiveBinding!), status(409));
});

test('removed employee override is stale and never silently falls back to the app model', t => {
  const f = fixture(t);
  const app = saveApp(f.service, 'fixture-openai/gpt-5.4', null);
  const overridden = f.service.selectEmployee(human, f.employee.id, employeePayload(f.service.readEmployee(f.employee.id), undefined, 'medium'));
  assert.equal(overridden.effectiveBinding?.source, 'employee-override');
  f.write(personal(['gpt-5.4']));

  const stale = f.service.readEmployee(f.employee.id);
  assert.equal(stale.effectiveStatus, 'stale');
  assert.equal(stale.effectiveBinding, null);
  assert.equal(stale.selection?.catalogId, 'fixture-openai/gpt-6-astra');
  assert.notEqual(stale.selection?.catalogId, app.catalog.models.find(model => model.id === app.selection?.catalogId)?.id);
  assert.throws(() => f.service.effectiveBinding(f.employee.id), status(409));
});

test('strict employee payloads reject invalid levels, unknown models, stale revisions, and extras', t => {
  const f = fixture(t);
  const initial = f.service.readEmployee(f.employee.id);
  const invalid = [
    null, {}, [],
    { mode: 'inherit-app', expectedRevision: 0, extra: true },
    { mode: 'override', modelId: 'fixture-openai/missing', reasoningLevel: 'medium', expectedRevision: 0, expectedCatalogRevision: initial.catalog.catalogRevision },
    { mode: 'override', modelId: 'fixture-openai/gpt-6-astra', reasoningLevel: 'invented', expectedRevision: 0, expectedCatalogRevision: initial.catalog.catalogRevision },
  ];
  for (const value of invalid) assert.throws(() => f.service.selectEmployee(human, f.employee.id, value), status(400));
  assert.equal(f.store.all('employeeModelPreferences').length, 0);
  assert.throws(() => f.service.selectEmployee(human, f.employee.id, {
    mode: 'override', modelId: 'fixture-openai/gpt-6-astra', reasoningLevel: null,
    expectedRevision: 1, expectedCatalogRevision: initial.catalog.catalogRevision,
  }), status(409));
});

test('queued/running employee work blocks model changes and does not cancel or write a preference', t => {
  const f = fixture(t);
  const task = {
    id: 'task_busy', title: 'busy fixture', goal: 'busy fixture', projectId: 'project_fixture',
    leaderId: f.employee.id, developerId: f.employee.id, qaId: 'employee_qa', status: 'planning' as const, mode: 'simulation' as const,
    version: 1, contentHash: null, plan: null, blockedReason: null, createdAt: TIMESTAMP, updatedAt: TIMESTAMP,
  };
  f.store.put('tasks', task);
  f.store.sql.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run('job_busy', task.id, 'running', TIMESTAMP, TIMESTAMP);
  f.store.put('runs', {
    id: 'run_busy', taskId: task.id, employeeId: f.employee.id, stage: 'development', mode: 'simulation', status: 'running',
    sessionId: null, startedAt: TIMESTAMP, endedAt: null, exitCode: null, output: '', error: null,
  });
  const state = f.service.readEmployee(f.employee.id);
  assert.throws(() => f.service.selectEmployee(human, f.employee.id, employeePayload(state)), status(409));
  assert.equal(f.store.get('employeeModelPreferences', f.employee.id), null);
  assert.equal(f.store.get('tasks', task.id)?.status, 'planning');
  assert.equal(f.store.get('runs', 'run_busy')?.status, 'running');
});

test('disabled employees can inherit or reset without being silently enabled', t => {
  const f = fixture(t);
  f.store.put('employees', { ...f.employee, enabled: false });
  const state = f.service.selectEmployee(human, f.employee.id, { mode: 'inherit-app', expectedRevision: 0 });
  assert.equal(state.mode, 'inherit-app');
  assert.equal(f.store.get('employees', f.employee.id)?.enabled, false);
  assert.equal(f.store.get('employeeModelPreferences', f.employee.id)?.mode, 'inherit-app');
});
