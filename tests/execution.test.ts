import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { createApp } from '../src/server/api.js';
import type { AppConfig } from '../src/server/config.js';
import { Store } from '../src/server/db.js';
import { Execution } from '../src/server/execution.js';
import { AppError } from '../src/server/policy.js';
import { fingerprintCurrentZcode, ZcodeRunner } from '../src/server/runners/zcode.js';
import type { EffectiveModelBinding, ExecutionCheck, ModelBinding, Project, RunnerInput, Task } from '../src/shared/types.js';

const POLICY = 'selected-model-zcode-v2';
const FIXTURE_EMPLOYEE_ID = 'fixture-employee';
const MODEL_BINDING: ModelBinding = {
  catalogId: 'provider-a/model-a', providerId: 'provider-a', modelId: 'model-a', reasoningLevel: 'low',
  selectionRevision: 1, catalogRevision: 'c'.repeat(64), selectionFingerprint: 'd'.repeat(64),
};
const effectiveBinding = (employeeId = FIXTURE_EMPLOYEE_ID, source: EffectiveModelBinding['source'] = 'app-default', binding: ModelBinding = MODEL_BINDING): EffectiveModelBinding => ({
  ...binding,
  source,
  employeeId,
  selectionFingerprint: createHash('sha256').update(JSON.stringify(['employee-effective-v1', employeeId, source, source === 'employee-override' ? 1 : 0, binding.selectionFingerprint])).digest('hex'),
});
// These tests exercise the existing state machine with explicit, test-only model authority.
// The production service remains unsupported; it is tested unmocked below and by model-selection-api.test.ts.
function mockSelectedModel(t: TestContext, execution: Execution) {
  const models = execution.models as unknown as {
    resolveSelectedModel: (expected?: ModelBinding) => ModelBinding;
    effectiveBinding: (employeeId: string, expected?: ModelBinding) => EffectiveModelBinding;
    bindingSupport: (binding?: ModelBinding) => { ready: boolean; reason: string };
  };
  t.mock.method(models, 'resolveSelectedModel', (expected?: ModelBinding) => {
    if (expected && expected.selectionFingerprint !== MODEL_BINDING.selectionFingerprint) throw new AppError('Synthetic model binding changed', 409);
    return { ...MODEL_BINDING };
  });
  t.mock.method(models, 'effectiveBinding', (employeeId: string, expected?: ModelBinding) => {
    const source = expected && 'source' in expected && (expected as EffectiveModelBinding).source === 'employee-override' ? 'employee-override' : 'app-default';
    const actual = effectiveBinding(employeeId, source);
    if (expected && expected.selectionFingerprint !== actual.selectionFingerprint) throw new AppError('Synthetic effective model binding changed', 409);
    if (expected && 'employeeId' in expected && (expected as EffectiveModelBinding).employeeId !== employeeId) throw new AppError('Synthetic employee binding changed', 409);
    return actual;
  });
  t.mock.method(models, 'bindingSupport', () => ({ ready: true, reason: 'Explicit test-only model support' }));
}
const zcodeFingerprint = (config: AppConfig, binding: ModelBinding = MODEL_BINDING) => fingerprintCurrentZcode({ ...config.zcode, modelBinding: binding });
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const DIGEST = `fixture-node@${IMAGE_ID}`;
const ENGINE = JSON.stringify('test-engine-id');
const CANARY = 'EXECUTION_TEST_CREDENTIAL_CANARY_NOT_REAL';
const PASSWORD = 'Execution-Test-Password-Only!';
const imageFingerprint = (imageId = IMAGE_ID, digest = DIGEST) => createHash('sha256')
  .update(JSON.stringify({ policy: POLICY, engine: ENGINE, imageId, digest })).digest('hex');
type SpawnCall = { command: string; args: string[]; options: childProcess.SpawnOptions };
type Reply = { stdout?: string; stderr?: string; code?: number };
type ProbeHooks = {
  active: { promise: Promise<void> } | null;
  probeZcode(check: ExecutionCheck, workspace: string, signal: AbortSignal): Promise<void>;
  complete(checkId: string, patch: Partial<ExecutionCheck>): void;
};
const hooks = (execution: Execution) => execution as unknown as ProbeHooks;
const conflict = (error: unknown) => error instanceof AppError && error.status === 409;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function removeTree(directory: string) {
  // Workspace baselines are sealed read-only; only unlock artifacts under this test's own root.
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fs.unlinkSync(file);
    else if (entry.isDirectory()) removeTree(file);
    else { fs.chmodSync(file, 0o600); fs.unlinkSync(file); }
  }
  fs.rmdirSync(directory);
}
function sandbox(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'zhiyansi-execution-'));
  const home = path.join(dir, 'home');
  const configFile = path.join(home, '.zcode', 'cli', 'config.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ model: 'fixture-model', apiKey: CANARY }));
  const modelCatalogPath = path.join(home, '.zcode', 'v2', 'provider_config.json');
  fs.mkdirSync(path.dirname(modelCatalogPath), { recursive: true });
  fs.writeFileSync(modelCatalogPath, JSON.stringify({ schemaVersion: 1, config: {
    providerOrder: ['provider-a'],
    providerConfigRules: { providerRules: [{ providerId: 'provider-a', providerName: 'test', config: {
      access: { type: 'api-key', apiKey: 'TEST_SECRET_CANARY' },
      api: { type: 'openai-chat-completions', baseUrl: 'https://never.invalid/v1' },
      group: 'standard-personal', personalModelIds: ['model-a', 'model-b'], modelOrder: ['model-a', 'model-b'],
    } }] },
    modelConfigRules: { providerModelRules: [{ providerId: 'provider-a', modelId: 'model-a', config: {
      optionSpecs: { reasoningLevel: { values: ['low', 'high'] } },
    } }], manualProviderModelRules: [] },
  } }));
  const env: NodeJS.ProcessEnv = {
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'config'), LOCALAPPDATA: path.join(home, 'local'),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'),
    HOMEDRIVE: path.parse(home).root.slice(0, 2), HOMEPATH: home.slice(2),
  };
  const savedEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const config: AppConfig = {
    port: 0, dataDir: path.join(dir, 'data'), workspaceRoot: path.join(dir, 'workspaces'),
    realExecutionEnabled: true, monitoringEnabled: false, modelCatalogPath,
    zcode: { electronPath: path.join(dir, 'fixture-node.exe'), cliPath: path.join(dir, 'fixture-cli.cjs'),
      enabled: true, environmentMode: 'existing-user', isolationVerified: true, timeoutMs: 1000 },
    docker: { executable: path.join(dir, 'never-real-docker.exe'), image: 'fixture-node:24', timeoutMs: 1000 },
  };
  for (const file of [config.zcode.electronPath, config.zcode.cliPath]) fs.writeFileSync(file, 'test data, never executable');
  const calls: SpawnCall[] = [];
  const unexpected: string[] = [];
  let reply: (call: SpawnCall) => Reply | Promise<Reply> = call => {
    unexpected.push(call.command);
    throw new Error('Unexpected child process in execution integration test');
  };
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = ((command: string, args: string[], options: childProcess.SpawnOptions) => {
    const call = { command, args, options }; calls.push(call);
    const child = Object.assign(new EventEmitter(), {
      pid: undefined, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null,
      kill: () => true, unref: () => undefined,
    });
    queueMicrotask(async () => {
      try {
        const result = await reply(call);
        child.stdout.end(result.stdout ?? ''); child.stderr.end(result.stderr ?? '');
        child.exitCode = result.code ?? 0;
        child.emit('close', child.exitCode);
      } catch (error) { child.emit('error', error); }
    });
    return child;
  }) as unknown as typeof childProcess.spawn;
  const guards = ['exec', 'execFile', 'execSync', 'execFileSync', 'spawnSync', 'fork'] as const;
  for (const method of guards) t.mock.method(childProcess, method, () => {
    unexpected.push(method); throw new Error(`Forbidden process API: ${method}`);
  });
  // Named ESM spawn imports must see the replacement as well as childProcess.spawn.
  syncBuiltinESMExports();
  const close: (() => void | Promise<void>)[] = [];
  let allowedBase = '';
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, allowedBase, 'Only this test loopback API may be contacted');
    return realFetch(input, { ...init, redirect: 'error' });
  }) as typeof fetch);
  t.after(async () => {
    try { for (const dispose of close.reverse()) await dispose(); }
    finally {
      childProcess.spawn = originalSpawn;
      t.mock.restoreAll(); syncBuiltinESMExports();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      removeTree(dir);
    }
    assert.deepEqual(unexpected, [], 'No unplanned process API may be attempted');
  });
  return { dir, home, configFile, config, calls, close,
    reply: (next: typeof reply) => { reply = next; },
    allowApi: (base: string) => { allowedBase = base; } };
}
async function apiFixture(t: TestContext) {
  const f = sandbox(t);
  const app = createApp(f.config);
  f.close.push(() => app.close());
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  f.allowApi(base);
  let cookie = '', csrf = '';
  const request = async (route: string, method = 'GET', value?: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(base + route, { method, headers: {
      Origin: base, Cookie: cookie, 'X-CSRF-Token': csrf,
      ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra,
    }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, headers: response.headers, body: await response.json() as any };
  };
  const setup = await request('/api/auth/setup', 'POST', { username: 'execution-admin', password: PASSWORD });
  assert.equal(setup.status, 200);
  cookie = setup.headers.get('set-cookie')!.split(';')[0]; csrf = setup.body.csrfToken;
  return { ...f, app, request, userId: setup.body.user.id as string };
}
function project(store: Store, config: AppConfig, projectId = 'fixture-project'): Project {
  return store.put('projects', { id: projectId, name: projectId, description: 'Synthetic fixture only',
    workspace: path.join(config.workspaceRoot, 'projects', projectId), leadId: null,
    stack: 'node', testCommand: ['node', '--test', 'tests'], dockerImage: config.docker.image,
    createdAt: new Date().toISOString() });
}
function readyCheck(execution: Execution, target: ExecutionCheck['target'], p?: Project, employeeId: string | null = null, source: EffectiveModelBinding['source'] = 'app-default'): ExecutionCheck {
  const selected = target === 'zcode' ? (employeeId ? effectiveBinding(employeeId, source) : { ...MODEL_BINDING }) : undefined;
  const check: ExecutionCheck = {
    id: `synthetic-${target}-${employeeId ?? p?.id ?? 'app'}`, target, status: 'ready', environmentMode: 'existing-user',
    policyVersion: POLICY, fingerprint: target === 'zcode' ? zcodeFingerprint(execution.config, selected) : imageFingerprint(),
    checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    checkedBy: 'fixture-admin', processInstanceId: execution.instanceId, projectId: p?.id ?? null,
    taskId: null, image: p?.dockerImage ?? null, imageDigest: target === 'docker' ? DIGEST : null,
    result: 'Synthetic test evidence; not an OS sandbox', model: null,
    observedTools: target === 'zcode' ? ['Read', 'Write'] : [], sessionId: null,
    ...(target === 'zcode' ? { modelBinding: selected, ...(employeeId ? { employeeId } : {}) } : {}),
  };
  return execution.store.put('executionChecks', check);
}
function domainFixture(t: TestContext) {
  const f = sandbox(t), store = new Store(path.join(f.config.dataDir, 'company.sqlite'));
  f.close.push(() => store.close());
  const execution = new Execution(store, f.config);
  mockSelectedModel(t, execution);
  f.close.push(() => execution.shutdown());
  const p = project(store, f.config);
  return { ...f, store, execution, p };
}
async function settle(execution: Execution) {
  await hooks(execution).active?.promise;
  await Promise.resolve();
  assert.equal(execution.status().checking, false);
}
function dockerReply(call: SpawnCall, image = 'fixture-node:24', imageId = IMAGE_ID, digest = DIGEST): Reply {
  assert.equal(call.options.shell, false);
  if (call.args[0] === 'info') {
    assert.deepEqual(call.args, ['info', '--format', '{{json .ID}}']);
    return { stdout: ENGINE };
  }
  assert.deepEqual(call.args, ['image', 'inspect', '--format', '{{json .}}', image]);
  return { stdout: JSON.stringify({ Id: imageId, RepoDigests: [digest], Config: { Volumes: null } }) };
}

// All subprocesses are inert event emitters; all configuration and SQLite data are synthetic.
test('GET execution/dashboard/health never probe, and manual true flags or old checks cannot authorize', async t => {
  const f = await apiFixture(t), execution = f.app.workflow.execution;
  const p = project(f.app.store, f.config);
  for (let pass = 0; pass < 2; pass++) {
    if (pass) {
      const old = readyCheck(execution, 'zcode');
      f.app.store.put('executionChecks', { ...old, processInstanceId: 'previous-process' });
      const docker = readyCheck(execution, 'docker', p);
      f.app.store.put('executionChecks', { ...docker, processInstanceId: 'previous-process' });
    }
    const status = await f.request('/api/execution');
    assert.equal(status.status, 200); assert.equal(status.body.zcode.ready, false);
    assert.equal(status.body.docker.ready, false); assert.equal(status.body.checking, false);
    assert.equal(status.body.environmentMode, 'existing-user');
    assert.match(status.body.warning, /不是操作系统沙箱/);
    const dashboard = await f.request('/api/dashboard');
    assert.equal(dashboard.body.capabilities.realExecution.ready, false);
    assert.equal(dashboard.body.capabilities.releaseExecution.ready, false);
    assert.equal((await f.request('/api/health')).body.realExecutionEnabled, false);
    assert.equal(JSON.stringify({ status: status.body, dashboard: dashboard.body }).includes(CANARY), false);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.app.store.all('runs').length, 0);
  assert.equal(f.app.store.all('executionChecks').length, 2, 'GET must not create new evidence');
});

test('execution checks/revoke require explicit POST, user authentication and CSRF; malformed inputs never probe', async t => {
  const f = await apiFixture(t);
  for (const route of ['/api/execution/check', '/api/execution/revoke']) {
    assert.equal((await f.request(route)).status, 404);
    assert.equal((await f.request(route, 'PUT', { target: 'zcode', employeeId: null })).status, 404);
    assert.equal((await f.request(route, 'POST', { target: 'zcode', employeeId: null }, { Cookie: '' })).status, 401);
    assert.equal((await f.request(route, 'POST', { target: 'zcode', employeeId: null }, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await f.request(route, 'POST', { target: 'zcode', employeeId: null }, { Origin: 'https://outside.invalid' })).status, 403);
    for (const value of [null, [], {}, { target: ['zcode'] }, { target: true }, { target: 'other' }, { target: 'zcode', apiKey: CANARY }]) {
      const result = await f.request(route, 'POST', value);
      assert.equal(result.status, 400);
      assert.equal(JSON.stringify(result.body).includes(CANARY), false);
    }
  }
  for (const projectId of [undefined, null, [], {}, true, 'missing-project']) {
    assert.equal((await f.request('/api/execution/check', 'POST', { target: 'docker', projectId })).status, 400);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.app.store.all('executionChecks').length, 0);
  const execution = f.app.workflow.execution;
  mockSelectedModel(t, execution);
  const probe = t.mock.method(hooks(execution), 'probeZcode', async (check: ExecutionCheck) => {
    assert.deepEqual(check.modelBinding, MODEL_BINDING);
    throw new Error('1113: fixture provider has no balance');
  });
  assert.equal((await f.request('/api/execution/check', 'POST', { target: 'zcode', employeeId: null })).status, 202);
  await settle(execution);
  const check = f.app.store.all('executionChecks')[0];
  assert.equal(check.checkedBy, f.userId); assert.equal(check.status, 'blocked');
  assert.equal(probe.mock.callCount(), 1, 'failed explicit check is not retried');
  assert.equal(f.calls.length, 0, 'state-machine fixture never invokes a real transport');
});

test('queued jobs and overlapping checks are busy; revocation aborts a probe and defeats its late completion', async t => {
  const f = await apiFixture(t), execution = f.app.workflow.execution;
  mockSelectedModel(t, execution);
  for (const status of ['queued', 'running']) {
    f.app.store.sql.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run('busy', 'fixture-task', status, '2026-01-01', '2026-01-01');
    assert.equal((await f.request('/api/execution/check', 'POST', { target: 'zcode', employeeId: null })).status, 409);
    f.app.store.sql.prepare('DELETE FROM jobs WHERE id=?').run('busy');
  }
  assert.equal(f.app.store.all('executionChecks').length, 0);
  const entered = deferred<AbortSignal>();
  const probe = t.mock.method(hooks(execution), 'probeZcode', async (check: ExecutionCheck, _workspace: string, signal: AbortSignal) => {
    entered.resolve(signal);
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    hooks(execution).complete(check.id, { fingerprint: zcodeFingerprint(f.config), result: 'Late synthetic success' });
  });
  const started = await f.request('/api/execution/check', 'POST', { target: 'zcode', employeeId: null });
  assert.equal(started.status, 202); assert.equal(started.body.checking, true);
  const signal = await entered.promise;
  assert.equal((await f.request('/api/execution/check', 'POST', { target: 'zcode', employeeId: null })).status, 409);
  assert.equal(f.app.store.all('executionChecks').length, 1);
  assert.equal((await f.request('/api/execution/revoke', 'POST', { target: 'zcode' })).status, 200);
  assert.equal(signal.aborted, true);
  await settle(execution);
  const check = f.app.store.all('executionChecks')[0];
  assert.equal(check.status, 'revoked'); assert.equal(check.expiresAt, null);
  assert.equal(execution.status().zcode.ready, false);
  assert.equal(probe.mock.callCount(), 1); assert.equal(f.calls.length, 0);
});

test('failed model checks redact credentials and replace raw 1113 dumps in responses and every stored record', async t => {
  const f = await apiFixture(t), execution = f.app.workflow.execution;
  mockSelectedModel(t, execution);
  const providerDump = `RAW_PROVIDER_DUMP_ONLY {"code":1113,"apiKey":"${CANARY}"}`;
  let failure = providerDump;
  const probe = t.mock.method(hooks(execution), 'probeZcode', async (check: ExecutionCheck) => {
    assert.deepEqual(check.modelBinding, MODEL_BINDING);
    throw new Error(failure);
  });
  for (const errorText of [providerDump, `Authorization: Bearer ${CANARY}\napiKey=${CANARY}\nhttps://fixture:${CANARY}@provider.invalid/`]) {
    failure = errorText;
    const response = await f.request('/api/execution/check', 'POST', { target: 'zcode', employeeId: null });
    assert.equal(response.status, 202);
    await settle(execution);
    const status = await f.request('/api/execution'), dashboard = await f.request('/api/dashboard');
    assert.equal(status.body.zcode.ready, false); assert.equal(status.body.zcodeCheck.status, 'blocked');
    const persisted = JSON.stringify(f.app.store.sql.prepare('SELECT collection, body FROM records').all());
    const visible = JSON.stringify([response.body, status.body, dashboard.body]);
    for (const output of [persisted, visible]) {
      assert.equal(output.includes(CANARY), false, 'credential canary must not reach records or API');
      assert.equal(output.includes(PASSWORD), false);
      assert.equal(output.includes('RAW_PROVIDER_DUMP_ONLY'), false);
    }
    if (errorText === providerDump) {
      assert.match(status.body.zcodeCheck.result, /1113/);
      assert.match(status.body.zcodeCheck.result, /余额|资源包/);
      assert.match(status.body.zcodeCheck.result, /不会自动/);
    }
  }
  assert.equal(probe.mock.callCount(), 2, 'one mocked attempt per explicit request, no retries');
  assert.equal(f.calls.length, 0);
  assert.equal(f.app.store.all('runs').length, 0);
});

test('revoking an accepted check cancels an active workflow stage and cannot persist its late model result', async t => {
  const f = await apiFixture(t), { workflow, store } = f.app;
  mockSelectedModel(t, workflow.execution);
  const p = project(store, f.config);
  p.workspace = workflow.workspaces.createProject(p.id); store.put('projects', p);
  const employees = store.all('employees');
  for (const employee of employees) store.put('employees', { ...employee, projectIds: [p.id] });
  const task: Task = { id: 'revoke-task', title: 'Never execute real work', goal: 'Synthetic cancellation fixture',
    projectId: p.id, leaderId: employees.find(e => e.role === 'lead')!.id,
    developerId: employees.find(e => e.role === 'developer')!.id, qaId: employees.find(e => e.role === 'qa')!.id,
    status: 'draft', mode: null, version: 1, modelBinding: { ...MODEL_BINDING }, contentHash: null, plan: null, blockedReason: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  store.put('tasks', task);
  readyCheck(workflow.execution, 'zcode');
  for (const employeeId of [task.leaderId, task.developerId, task.qaId]) readyCheck(workflow.execution, 'zcode', undefined, employeeId);
  readyCheck(workflow.execution, 'docker', p);
  f.reply(call => { assert.equal(call.command, f.config.docker.executable); return dockerReply(call); });
  const entered = deferred<AbortSignal>();
  const run = t.mock.method(ZcodeRunner.prototype, 'run', async (input: RunnerInput) => {
    entered.resolve(input.signal);
    await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }));
    return { summary: `late ignored response ${CANARY}`, files: [] };
  });
  assert.equal((await f.request(`/api/tasks/${task.id}/run`, 'POST', { mode: 'zcode' })).status, 202);
  const signal = await entered.promise;
  assert.equal(store.all('runs')[0].status, 'running');
  assert.equal((await f.request('/api/execution/revoke', 'POST', { target: 'zcode' })).status, 200);
  assert.equal(signal.aborted, true);
  await workflow.waitForIdle();
  assert.equal(workflow.task(task.id).status, 'cancelled');
  assert.equal(store.all('runs')[0].status, 'cancelled'); assert.equal(store.all('runs')[0].output, '');
  assert.equal(store.all('tests').length, 0); assert.equal(run.mock.callCount(), 1);
  assert.equal((store.sql.prepare('SELECT status FROM jobs').get() as { status: string }).status, 'cancelled');
  assert.equal(workflow.execution.status().zcode.ready, false);
  assert.equal((await workflow.capabilities()).realExecution.ready, false);
  assert.equal(JSON.stringify(store.sql.prepare('SELECT body FROM records').all()).includes(CANARY), false);
  assert.ok(f.calls.length >= 2); assert.ok(f.calls.every(call => call.command === f.config.docker.executable));
});

test('persisted ready checks are stale after restart, and interrupted checks become blocked without rerunning', async t => {
  const f = domainFixture(t);
  const zcode = readyCheck(f.execution, 'zcode'), docker = readyCheck(f.execution, 'docker', f.p);
  assert.equal(f.execution.status().zcode.ready, true); assert.equal(f.execution.status().docker.ready, true);
  const pending = { ...docker, id: 'interrupted-check', projectId: 'another-project', status: 'checking' as const, expiresAt: null };
  f.store.put('executionChecks', pending);
  const restartedStore = new Store(path.join(f.config.dataDir, 'company.sqlite'));
  f.close.push(() => restartedStore.close());
  const restarted = new Execution(restartedStore, f.config);
  mockSelectedModel(t, restarted);
  f.close.push(() => restarted.shutdown());
  assert.notEqual(restarted.instanceId, f.execution.instanceId);
  assert.equal(restartedStore.get('executionChecks', zcode.id)!.status, 'ready', 'historical evidence may remain, but is not readiness');
  assert.equal(restartedStore.get('executionChecks', pending.id)!.status, 'blocked');
  assert.equal(restartedStore.get('executionChecks', pending.id)!.expiresAt, null);
  assert.equal(restarted.status().checking, false); assert.equal(restarted.status().zcode.ready, false);
  assert.equal(restarted.status().projects.find(p => p.id === f.p.id)!.ready, false);
  await assert.rejects(restarted.assertProjectReady(f.p), conflict);
  assert.equal(f.calls.length, 0);
});

test('assertProjectReady rechecks CLI/model configuration, policy, instance and expiry before permitting any process', async t => {
  const f = domainFixture(t), { execution, store, p } = f;
  const reset = () => ({ zcode: readyCheck(execution, 'zcode'), docker: readyCheck(execution, 'docker', p) });
  let { zcode, docker } = reset();
  const cliBefore = zcode.fingerprint;
  fs.appendFileSync(f.config.zcode.cliPath, '\nchanged CLI entry');
  assert.notEqual(zcodeFingerprint(f.config), cliBefore);
  assert.equal(execution.status().zcode.ready, false);
  await assert.rejects(execution.assertProjectReady(p), conflict);
  ({ zcode, docker } = reset());
  fs.writeFileSync(f.configFile, JSON.stringify({ model: 'different-fixture-model-with-new-config', apiKey: CANARY }));
  assert.notEqual(zcodeFingerprint(f.config), zcode.fingerprint);
  await assert.rejects(execution.assertProjectReady(p), conflict);
  for (const target of ['zcode', 'docker'] as const) {
    for (const patch of [{ expiresAt: '2000-01-01T00:00:00.000Z' }, { processInstanceId: 'another-process' }, { policyVersion: 'old-policy' }]) {
      ({ zcode, docker } = reset());
      store.put('executionChecks', { ...(target === 'zcode' ? zcode : docker), ...patch });
      await assert.rejects(execution.assertProjectReady(p), conflict);
    }
  }
  reset();
  await assert.rejects(execution.assertProjectReady({ ...p, dockerImage: 'unverified-image:24' }), conflict);
  await assert.rejects(execution.assertProjectReady(project(store, f.config, 'unverified-project')), conflict);
  assert.equal(f.calls.length, 0, 'stale/mismatched evidence is refused before Docker inspection');
});

test('runtime checks inspect the exact project image and reject digest changes or revocation during inspection', async t => {
  const f = domainFixture(t), { execution, p } = f;
  const reset = () => { readyCheck(execution, 'zcode'); readyCheck(execution, 'docker', p); };
  reset();
  f.reply(call => { assert.equal(call.command, f.config.docker.executable); return dockerReply(call, p.dockerImage); });
  const accepted = await execution.assertProjectReady(p);
  assert.equal(accepted.dockerDigest, DIGEST);
  assert.equal(accepted.options.environmentMode, 'existing-user');
  assert.equal(accepted.options.verificationFingerprint, zcodeFingerprint(f.config));
  assert.deepEqual(f.calls.map(call => call.args[0]), ['info', 'image']);
  const changedId = `sha256:${'b'.repeat(64)}`;
  f.reply(call => dockerReply(call, p.dockerImage, changedId, `fixture-node@${changedId}`));
  await assert.rejects(execution.assertProjectReady(p), conflict);
  for (const target of ['zcode', 'docker'] as const) {
    reset();
    f.reply(call => {
      const result = dockerReply(call, p.dockerImage);
      if (call.args[0] === 'image') execution.revoke(target, 'fixture-admin');
      return result;
    });
    await assert.rejects(execution.assertProjectReady(p), conflict, `${target} revocation must be checked after awaited inspection`);
  }
  assert.equal(f.calls.length, 8);
  assert.ok(f.calls.every(call => ['info', 'image'].includes(call.args[0])), 'no container or pull starts during readiness checks');
});
