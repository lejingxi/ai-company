import assert from 'node:assert/strict';
import test from 'node:test';
import { Store, now } from '../src/server/db.js';
import { AppError, type Actor } from '../src/server/policy.js';
import { ModelCatalogService } from '../src/server/model-catalog.js';
import {
  ModelApiError,
  buildModelRequest,
  isPublicIp,
  parseModelResponse,
  requestModelOnce,
  type ModelApiConnection,
  type ModelApiRequest,
} from '../src/server/model-api-http.js';
import { ModelApiTests } from '../src/server/model-api-test.js';
import type { Employee, EffectiveModelBinding, ModelApiTest, ModelBinding } from '../src/shared/types.js';

const USER_ID = 'fixture-human';
const EMPLOYEE_ID = 'employee_fixture';
const SECRET = 'MODEL_API_TEST_SECRET_CANARY_NOT_REAL';
const CATALOG_REVISION = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);
const TIMESTAMP = '2026-11-12T12:00:00.000Z';
const actor: Actor = { type: 'user', id: USER_ID };

const CHAT_MAP = `
{
  "thinking": {
    "type": reasoningLevel == "disabled" || reasoningLevel == "none" ? "disabled" : "enabled"
  },
  "enable_thinking": reasoningLevel != "disabled" && reasoningLevel != "none",
  "reasoning_effort": reasoningLevel == "disabled" ? "none" : reasoningLevel == "enabled" ? "high" : reasoningLevel,
  "reasoning": {
    "effort": reasoningLevel == "disabled" ? "none" : reasoningLevel == "enabled" ? "high" : reasoningLevel
  }
}`;
const CHAT_MAX_OUTPUT_MAP = `{'max_completion_tokens': maxOutputTokens}`;

function employee(): Employee {
  return {
    id: EMPLOYEE_ID, name: 'Fixture employee', role: 'developer', duties: 'fixture only', reportsTo: null,
    projectIds: [], enabled: true, createdAt: TIMESTAMP,
  };
}

function binding(overrides: Partial<ModelBinding> = {}): ModelBinding {
  return {
    providerId: 'new-provider', modelId: 'gpt-fixture', catalogId: 'new-provider/gpt-fixture',
    reasoningLevel: 'high', selectionRevision: 1, catalogRevision: CATALOG_REVISION,
    selectionFingerprint: FINGERPRINT, ...overrides,
  };
}

function connection(overrides: Partial<ModelApiConnection> = {}): ModelApiConnection {
  return {
    baseUrl: 'https://api.example.com/v1', apiKey: SECRET, apiType: 'openai-chat-completions',
    effectiveReasoning: 'high', reasoningMap: CHAT_MAP, maxOutputMap: CHAT_MAX_OUTPUT_MAP,
    catalogRevision: CATALOG_REVISION, ...overrides,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fakeModels(store: Store, options: {
  appBinding?: ModelBinding;
  employeeBinding?: ModelBinding;
  api?: ModelApiConnection;
} = {}) {
  const appBinding = options.appBinding ?? binding();
  const employeeBinding: EffectiveModelBinding = (options.employeeBinding ?? { ...appBinding, source: 'employee-override' as const, employeeId: EMPLOYEE_ID }) as EffectiveModelBinding;
  const api = options.api ?? connection();
  const service = {
    store,
    resolveSelectedModel(expected?: ModelBinding) {
      if (expected && expected.selectionFingerprint !== appBinding.selectionFingerprint) throw new AppError('模型选择已变化', 409);
      return { ...appBinding };
    },
    effectiveBinding(employeeId: string, expected?: ModelBinding) {
      if (employeeId !== EMPLOYEE_ID) throw new AppError('员工不存在', 404);
      if (expected && expected.selectionFingerprint !== employeeBinding.selectionFingerprint) throw new AppError('员工模型已变化', 409);
      return { ...employeeBinding };
    },
    resolveApiConfig() { return { ...api }; },
  } as unknown as ModelCatalogService;
  return { service, appBinding, employeeBinding, api };
}

function setupStore(withEmployee = false) {
  const store = new Store(':memory:');
  store.sql.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(USER_ID, 'fixture', 'not-real', 'not-real', TIMESTAMP);
  if (withEmployee) store.put('employees', employee());
  return store;
}

function input(scope: 'app' | 'employee' = 'app', employeeId: string | null = null, overrides: Record<string, unknown> = {}) {
  return {
    scope, employeeId, expectedSelectionFingerprint: FINGERPRINT, effectiveReasoning: 'high',
    requestId: `request-${scope}-fixture`, confirmCharge: true, ...overrides,
  };
}

async function waitForTerminal(service: ModelApiTests, scope: 'app' | 'employee', employeeId: string | null, timeoutMs = 3_000): Promise<ModelApiTest> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const latest = service.state(scope, employeeId).latest;
    if (latest && latest.status !== 'running') return latest;
    if (Date.now() >= deadline) throw new Error('fixture test did not finish');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function assertNoSecret(value: unknown) {
  assert.equal(JSON.stringify(value).includes(SECRET), false, 'credential must never enter persisted records or safe errors');
}

function close(store: Store) {
  try { store.close(); } catch { /* fixture cleanup */ }
}

test('Astra chat map is exact, sends one bounded fixed request, and never uses a default endpoint', () => {
  const request = buildModelRequest(connection(), 'gpt-fixture');
  assert.equal(request.url.toString(), 'https://api.example.com/v1/chat/completions');
  assert.equal(request.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(request.headers['Content-Type'], 'application/json');
  const body = JSON.parse(request.body) as Record<string, any>;
  assert.equal(body.model, 'gpt-fixture');
  assert.equal(body.max_completion_tokens, 2048);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Reply exactly OK.' }]);
  assert.equal(body.thinking.type, 'enabled');
  assert.equal(body.enable_thinking, true);
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.reasoning.effort, 'high');
  assert.equal(body.tools, undefined);
  assert.throws(() => buildModelRequest(connection({ reasoningMap: '{"reasoning_effort": guess(reasoningLevel)}' }), 'gpt-fixture'), (error: unknown) => error instanceof ModelApiError && error.code === 'reasoning_mapping_unsupported');
  assert.throws(() => buildModelRequest(connection({ baseUrl: 'https://127.0.0.1/v1' }), 'gpt-fixture'), (error: unknown) => error instanceof ModelApiError && error.code === 'endpoint_not_allowed');
});

test('public IP and response classification fail closed without contacting a provider', () => {
  assert.equal(isPublicIp('8.8.8.8'), true);
  for (const address of ['0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.1.1', '192.168.1.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '2001:db8::1']) assert.equal(isPublicIp(address), false, address);
  const passed = parseModelResponse(200, JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), 'openai-chat-completions', 'high');
  assert.deepEqual(passed, { status: 'passed', code: 'generation_received', message: '模型 API 已返回有效生成内容；不代表 ZCode 员工、工具或 Docker 已接通。', reasoningHonored: 'not-confirmed' });
  assert.equal(parseModelResponse(403, '{}', 'openai-chat-completions', 'high').code, 'authentication_failed');
  assert.equal(parseModelResponse(429, '{}', 'openai-chat-completions', 'high').code, 'quota_or_rate_limit');
  assert.equal(parseModelResponse(200, JSON.stringify({ choices: [{ message: { content: '' } }] }), 'openai-chat-completions', null).code, 'no_visible_output');
  assert.equal(parseModelResponse(200, JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), 'openai-responses', null).code, 'output_budget_exhausted');
  assert.equal(parseModelResponse(200, JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }), 'anthropic-messages', null).status, 'passed');
});

test('successful injected API test is accepted asynchronously and persists safe metadata only', async () => {
  const store = setupStore();
  try {
    const { service } = fakeModels(store);
    const calls: unknown[] = [];
    const request: ModelApiRequest = async requestInput => {
      calls.push(requestInput);
      return { status: 'passed', code: 'generation_received', message: `provider output ${SECRET}`, reasoningHonored: 'reported' };
    };
    const tests = new ModelApiTests(store, service, { request, timeoutMs: 1_000 });
    const beforeChecks = store.all('executionChecks').length;
    const beforeSelections = store.all('modelSelections').length;
    const started = await tests.start(actor, input(), () => true);
    assert.equal(started.status, 'running');
    const result = await waitForTerminal(tests, 'app', null);
    assert.equal(result.status, 'passed');
    assert.equal(result.code, 'generation_received');
    assert.equal(result.reasoningHonored, 'reported');
    assert.equal(calls.length, 1, 'exactly one injected provider request');
    assert.equal(store.all('executionChecks').length, beforeChecks);
    assert.equal(store.all('modelSelections').length, beforeSelections);
    assert.equal(store.all('modelApiTests').length, 1);
    assertNoSecret(store.sql.prepare('SELECT collection, body FROM records').all());
    assertNoSecret(result);
    await tests.shutdown();
  } finally { close(store); }
});

test('session validity is checked before dispatch and during a running request', async () => {
  const store = setupStore();
  try {
    const { service } = fakeModels(store);
    let calls = 0;
    const blocked = new ModelApiTests(store, service, { request: async () => { calls++; throw new Error('must not dispatch'); } });
    await assert.rejects(blocked.start(actor, input(), () => false), (error: unknown) => error instanceof AppError && error.status === 401);
    assert.equal(calls, 0);
    const entered = deferred<void>();
    let valid = true;
    const request: ModelApiRequest = async ({ signal }) => {
      calls++;
      entered.resolve();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { status: 'passed', code: 'generation_received', message: 'late', reasoningHonored: 'reported' };
    };
    const tests = new ModelApiTests(store, service, { request, timeoutMs: 2_000 });
    await tests.start(actor, input('app', null, { requestId: 'session-running' }), () => valid);
    await entered.promise;
    valid = false;
    const result = await waitForTerminal(tests, 'app', null);
    assert.equal(result.status, 'cancelled');
    assert.equal(result.code, 'session_expired');
    assert.equal(calls, 1);
    await tests.shutdown();
  } finally { close(store); }
});

test('duplicate request IDs are idempotent while only one unique request may be active globally', async () => {
  const store = setupStore();
  try {
    const { service } = fakeModels(store);
    const entered = deferred<void>();
    const request: ModelApiRequest = async ({ signal }) => {
      entered.resolve();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { status: 'passed', code: 'generation_received', message: 'late', reasoningHonored: 'not-confirmed' };
    };
    const tests = new ModelApiTests(store, service, { request, timeoutMs: 2_000 });
    const first = await tests.start(actor, input('app', null, { requestId: 'same-request' }), () => true);
    await entered.promise;
    const duplicate = await tests.start(actor, input('app', null, { requestId: 'same-request' }), () => true);
    assert.equal(duplicate.id, first.id);
    await assert.rejects(tests.start(actor, input('app', null, { requestId: 'other-request' }), () => true), (error: unknown) => error instanceof AppError && error.status === 409);
    const cancelled = tests.cancel(actor, first.id);
    assert.equal(cancelled.status, 'cancelled');
    await tests.shutdown();
  } finally { close(store); }
});

test('cancel prevents a late provider completion from becoming passed', async () => {
  const store = setupStore();
  try {
    const { service } = fakeModels(store);
    const entered = deferred<void>();
    const request: ModelApiRequest = async ({ signal }) => {
      entered.resolve();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { status: 'passed', code: 'generation_received', message: 'late provider output', reasoningHonored: 'reported' };
    };
    const tests = new ModelApiTests(store, service, { request, timeoutMs: 2_000 });
    const started = await tests.start(actor, input(), () => true);
    await entered.promise;
    const cancelled = tests.cancel(actor, started.id);
    assert.equal(cancelled.status, 'cancelled');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(tests.state('app', null).latest?.status, 'cancelled');
    assert.notEqual(tests.state('app', null).latest?.status, 'passed');
    await tests.shutdown();
  } finally { close(store); }
});

test('selection invalidation marks app and inherited tests stale but preserves employee overrides', () => {
  const store = setupStore(true);
  try {
    const { service, appBinding, employeeBinding } = fakeModels(store);
    const appRecord: ModelApiTest = {
      id: 'modeltest-app', requestId: 'app-fixture', scope: 'app', employeeId: null, binding: appBinding,
      effectiveReasoning: 'high', status: 'passed', code: 'generation_received', message: 'safe', durationMs: 1,
      startedAt: '2026-11-12T12:00:01.000Z', endedAt: '2026-11-12T12:00:02.000Z', userId: USER_ID, reasoningHonored: 'not-confirmed',
    };
    const overrideRecord: ModelApiTest = {
      ...appRecord, id: 'modeltest-override', requestId: 'override-fixture', scope: 'employee', employeeId: EMPLOYEE_ID,
      binding: employeeBinding, startedAt: '2026-11-12T12:00:03.000Z', endedAt: '2026-11-12T12:00:04.000Z',
    };
    store.insert('modelApiTests', appRecord);
    store.insert('modelApiTests', overrideRecord);
    const tests = new ModelApiTests(store, service);
    tests.invalidate('app');
    assert.equal(store.get('modelApiTests', appRecord.id)?.status, 'stale');
    assert.equal(store.get('modelApiTests', overrideRecord.id)?.status, 'passed');
    tests.invalidate('employee', EMPLOYEE_ID);
    assert.equal(store.get('modelApiTests', overrideRecord.id)?.status, 'stale');
    assertNoSecret(store.sql.prepare('SELECT collection, body FROM records').all());
  } finally { close(store); }
});

test('employee test preserves effective binding context and does not authorize execution readiness', async () => {
  const store = setupStore(true);
  try {
    const { service, employeeBinding } = fakeModels(store);
    const calls: Parameters<ModelApiRequest>[0][] = [];
    const request: ModelApiRequest = async value => {
      calls.push(value);
      return { status: 'passed', code: 'generation_received', message: 'safe', reasoningHonored: 'not-confirmed' };
    };
    const tests = new ModelApiTests(store, service, { request });
    const started = await tests.start(actor, input('employee', EMPLOYEE_ID, { expectedSelectionFingerprint: employeeBinding.selectionFingerprint, requestId: 'employee-request' }), () => true);
    const result = await waitForTerminal(tests, 'employee', EMPLOYEE_ID);
    assert.equal(result.status, 'passed');
    assert.equal((result.binding as typeof employeeBinding).source, 'employee-override');
    assert.equal((result.binding as typeof employeeBinding).employeeId, EMPLOYEE_ID);
    assert.equal(calls.length, 1);
    assert.equal(store.all('executionChecks').length, 0);
    assert.equal(store.all('tests').length, 0);
    assert.equal(store.all('modelSelections').length, 0);
    await tests.shutdown();
  } finally { close(store); }
});

test('shutdown aborts an active request and persists a non-success terminal result', async () => {
  const store = setupStore();
  try {
    const { service } = fakeModels(store);
    const entered = deferred<void>();
    const request: ModelApiRequest = async ({ signal }) => {
      entered.resolve();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { status: 'passed', code: 'generation_received', message: 'late', reasoningHonored: 'reported' };
    };
    const tests = new ModelApiTests(store, service, { request, timeoutMs: 2_000 });
    const started = await tests.start(actor, input(), () => true);
    await entered.promise;
    await tests.shutdown();
    assert.notEqual(store.get('modelApiTests', started.id)?.status, 'passed');
    assert.equal(store.get('modelApiTests', started.id)?.status, 'cancelled');
  } finally { close(store); }
});

// Keep the import/type contract exercised without ever invoking requestModelOnce.
// A private endpoint must fail before DNS or HTTPS dispatch.
test('requestModelOnce rejects a blocked endpoint before any network operation', async () => {
  const controller = new AbortController();
  await assert.rejects(requestModelOnce({ connection: connection({ baseUrl: 'https://127.0.0.1/v1' }), modelId: 'gpt-fixture', signal: controller.signal, timeoutMs: 100 }), (error: unknown) => error instanceof ModelApiError && error.code === 'endpoint_not_allowed');
});
