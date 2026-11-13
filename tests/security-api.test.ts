import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/api.js';
import { Auth } from '../src/server/auth.js';
import { AppError } from '../src/server/policy.js';
import type { AppConfig } from '../src/server/config.js';
import type { Capabilities, Incident, Project, RunMode, Task } from '../src/shared/types.js';

// Test-only listeners and data. Capability probes and every executor are stubbed:
// no main server, CLI, model, Docker, or external service is started by this suite.
async function fixture(t: TestContext, password = 'Security-Test-Password-Only!') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiyansi-security-'));
  const config: AppConfig = {
    port: 0, dataDir: dir, workspaceRoot: path.join(dir, 'workspaces'),
    realExecutionEnabled: false, monitoringEnabled: false,
    zcode: { electronPath: 'never-execute', cliPath: 'never-execute', enabled: false, isolationVerified: false, timeoutMs: 100, runtimeHome: path.join(dir, 'home') },
    docker: { executable: 'never-execute', image: 'test-only', timeoutMs: 100 },
  };
  const app = createApp(config);
  t.after(async () => { try { await app.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } });
  const capabilities: Capabilities = {
    zcode: { ready: false, reason: 'disabled for tests' }, docker: { ready: false, reason: 'disabled for tests' },
    realExecution: { ready: false, reason: 'real execution stays disabled' },
    mergeExecution: { ready: false, reason: 'disabled' }, releaseExecution: { ready: false, reason: 'disabled' },
  };
  t.mock.method(app.workflow, 'capabilities', async () => capabilities);
  const execute = t.mock.method(app.workflow as unknown as { execute: () => Promise<void> }, 'execute', async () => { throw new Error('Executor must not run in security tests'); });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  let cookie = '', csrf = '';
  const request = async (route: string, method = 'GET', value?: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(base + route, {
      method, headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() as any };
  };
  const setup = await request('/api/auth/setup', 'POST', { username: '  security-admin  ', password });
  assert.equal(setup.status, 200);
  assert.equal(setup.body.user.username, 'security-admin');
  cookie = setup.headers.get('set-cookie')!.split(';')[0]; csrf = setup.body.csrfToken;
  const project = async () => {
    const response = await request('/api/projects', 'POST', { name: 'Security fixture' });
    assert.equal(response.status, 201);
    return response.body as Project;
  };
  const task = async () => {
    const p = await project();
    const employees = app.store.all('employees');
    for (const employee of employees) app.store.put('employees', { ...employee, projectIds: [p.id] });
    const response = await request('/api/tasks', 'POST', {
      title: 'Security task', goal: 'No executor may run', projectId: p.id,
      leaderId: employees.find(e => e.role === 'lead')!.id,
      developerId: employees.find(e => e.role === 'developer')!.id,
      qaId: employees.find(e => e.role === 'qa')!.id,
    });
    assert.equal(response.status, 201);
    return { project: p, task: response.body as Task };
  };
  return { app, config, dir, base, cookie, csrf, request, project, task, execute };
}

test('API and workflow reject non-string modes without queuing or invoking any executor', async t => {
  const f = await fixture(t);
  const { task } = await f.task();
  const badModes: unknown[] = [['zcode'], ['simulation'], [], {}, { toString: 'zcode' }, null, true, 1, '', 'other'];
  const enqueue = t.mock.method(f.app.workflow, 'enqueue');
  for (const mode of badModes) {
    assert.equal((await f.request(`/api/tasks/${task.id}/run`, 'POST', { mode })).status, 400, JSON.stringify(mode));
  }
  assert.equal(enqueue.mock.callCount(), 0, 'API must reject before reaching workflow');
  for (const mode of badModes) {
    await assert.rejects(f.app.workflow.enqueue(task.id, mode as RunMode, 'test'), (error: unknown) => error instanceof AppError && error.status === 400);
  }
  assert.equal((await f.request(`/api/tasks/${task.id}/run`, 'POST', { mode: 'zcode' })).status, 409);
  assert.equal(f.app.workflow.task(task.id).status, 'draft');
  assert.equal((f.app.store.sql.prepare('SELECT count(*) AS n FROM jobs').get() as { n: number }).n, 0);
  assert.equal(f.app.store.all('runs').length, 0);
  assert.equal(f.execute.mock.callCount(), 0);
});

test('API strictly validates approval kind, incident status, and employee role; simulation cannot approve', async t => {
  const f = await fixture(t);
  const { task, project } = await f.task();
  for (const kind of [['merge'], ['release'], {}, null, 1]) {
    assert.equal((await f.request(`/api/tasks/${task.id}/approve`, 'POST', { kind, taskVersion: 1, contentHash: 'test' })).status, 400);
  }
  const incident: Incident = { id: 'incident_test', projectId: project.id, title: 'fixture', severity: 'warning', status: 'open', detail: '', createdAt: new Date().toISOString() };
  f.app.store.put('incidents', incident);
  for (const status of [['acknowledged'], ['resolved'], {}, null, 1]) {
    assert.equal((await f.request(`/api/incidents/${incident.id}`, 'PATCH', { status })).status, 400);
  }
  assert.equal(f.app.store.get('incidents', incident.id)!.status, 'open');
  const employee = f.app.store.all('employees')[0];
  assert.equal((await f.request(`/api/employees/${employee.id}`, 'PATCH', { role: ['lead'] })).status, 400);
  const workspace = f.app.workflow.workspaces.createTask(project, task.id);
  const hash = f.app.workflow.workspaces.snapshot(workspace).hash;
  f.app.store.put('tasks', { ...task, status: 'awaiting_merge', mode: 'simulation', contentHash: hash });
  assert.equal((await f.request(`/api/tasks/${task.id}/approve`, 'POST', { kind: 'merge', taskVersion: 1, contentHash: hash })).status, 409);
  assert.equal(f.app.store.all('approvals').length, 0);
  assert.equal(f.app.workflow.task(task.id).status, 'awaiting_merge');
  assert.equal(f.execute.mock.callCount(), 0);
});

for (const revoke of ['logout', 'expiry'] as const) {
  test(`approval reauthenticates after its streamed body: ${revoke} invalidates the pending request`, { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    const { task, project } = await f.task();
    const workspace = f.app.workflow.workspaces.createTask(project, task.id);
    const hash = f.app.workflow.workspaces.snapshot(workspace).hash;
    // Synthetic evidence only, to make the pre-fix approval otherwise eligible.
    f.app.store.put('tasks', { ...task, status: 'awaiting_merge', mode: 'zcode', contentHash: hash });
    f.app.store.put('tests', { id: 'test_fixture_only', taskId: task.id, reviewerId: task.qaId, mode: 'zcode', status: 'passed', exitCode: 0, image: 'fixture', imageDigest: 'sha256:fixture', command: ['NOT_EXECUTED'], log: 'Synthetic fixture; no code executed', contentHash: hash, createdAt: new Date().toISOString(), durationMs: 0 });
    const route = `/api/tasks/${task.id}/approve`;
    let resolveIdentified!: () => void;
    const identified = new Promise<void>(resolve => { resolveIdentified = resolve; });
    const original = Auth.prototype.identify;
    t.mock.method(Auth.prototype, 'identify', function (this: Auth, req: http.IncomingMessage) {
      const identity = original.call(this, req);
      if (req.url === route && identity) resolveIdentified();
      return identity;
    });
    const payload = JSON.stringify({ kind: 'merge', taskVersion: 1, contentHash: hash });
    let client!: http.ClientRequest;
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      client = http.request(f.base + route, {
        method: 'POST', headers: { Origin: f.base, Cookie: f.cookie, 'X-CSRF-Token': f.csrf, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, res => {
        let data = ''; res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body: data })); res.on('error', reject);
      });
      client.on('error', reject);
      client.setTimeout(5000, () => client.destroy(new Error('Deferred request timed out')));
      client.write(payload.slice(0, 5));
    });
    void response.catch(() => undefined);
    t.after(() => client.destroy());
    await identified;
    if (revoke === 'logout') assert.equal((await f.request('/api/auth/logout', 'POST', {})).status, 200);
    else f.app.store.sql.prepare('UPDATE sessions SET expires_at=?').run('2000-01-01T00:00:00.000Z');
    client.end(payload.slice(5));
    assert.equal((await response).status, 401);
    assert.equal(f.app.store.all('approvals').length, 0);
    assert.equal(f.app.workflow.task(task.id).status, 'awaiting_merge');
    assert.equal(f.execute.mock.callCount(), 0);
  });
}

function fileSnapshot(root: string, prefix = ''): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(prefix, entry.name), absolute = path.join(root, entry.name);
    assert.equal(entry.isSymbolicLink(), false);
    return entry.isDirectory() ? fileSnapshot(absolute, relative) : [`${relative}:${fs.readFileSync(absolute).toString('base64')}`];
  }).sort();
}

test('project validation precedes disk writes; DB and creation failures clean only the new project artifacts', async t => {
  const f = await fixture(t);
  const kept = await f.project();
  const sentinel = path.join(f.dir, 'untouched.txt'); fs.writeFileSync(sentinel, 'preserve');
  const before = fileSnapshot(f.config.workspaceRoot);
  const originalCreate = f.app.workflow.workspaces.createProject.bind(f.app.workflow.workspaces);
  const create = t.mock.method(f.app.workflow.workspaces, 'createProject');
  for (const value of [{}, { name: 'x'.repeat(101) }, { name: 'valid', description: 'x'.repeat(3001) }, { name: 'valid', description: {} }]) {
    assert.equal((await f.request('/api/projects', 'POST', value)).status, 400);
  }
  assert.equal(create.mock.callCount(), 0);
  assert.deepEqual(fileSnapshot(f.config.workspaceRoot), before);
  const lead = f.app.store.all('employees').find(e => e.role === 'lead')!;
  const audit = f.app.store.audit.bind(f.app.store);
  const failAudit = t.mock.method(f.app.store, 'audit', (...args: Parameters<typeof audit>) => {
    if (args[1] === '创建隔离演示项目') throw new Error('Injected transaction failure');
    return audit(...args);
  });
  const rm = t.mock.method(fs, 'rmSync');
  assert.equal((await f.request('/api/projects', 'POST', { name: 'rollback', leadId: lead.id })).status, 500);
  assert.deepEqual(f.app.store.all('projects').map(p => p.id), [kept.id]);
  assert.deepEqual(f.app.store.get('employees', lead.id)!.projectIds, lead.projectIds);
  assert.deepEqual(fileSnapshot(f.config.workspaceRoot), before);
  const failedId = create.mock.calls[0].arguments[0];
  assert.deepEqual(rm.mock.calls.map(call => path.resolve(String(call.arguments[0]))).sort(), [
    path.join(f.config.workspaceRoot, 'projects', failedId),
    path.join(f.config.workspaceRoot, 'baselines', '_projects', failedId),
    path.join(f.config.workspaceRoot, 'baselines', '_seals', `projects-${failedId}.sha256`),
  ].sort());
  failAudit.mock.restore(); create.mock.restore();
  t.mock.method(f.app.workflow.workspaces, 'createProject', (projectId: string) => {
    originalCreate(projectId); throw new Error('Injected failure after workspace writes');
  });
  assert.equal((await f.request('/api/projects', 'POST', { name: 'partial-creation' })).status, 500);
  assert.deepEqual(fileSnapshot(f.config.workspaceRoot), before);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve');
  assert.deepEqual(f.app.store.all('projects').map(p => p.id), [kept.id]);
  rm.mock.restore();
});

test('monitor API rejects query strings without persisting or returning a credential canary', async t => {
  const f = await fixture(t);
  const project = await f.project();
  const canary = 'SECURITY_CANARY_NOT_A_REAL_SECRET';
  for (const url of [`http://127.0.0.1:8080/health?token=${canary}`, 'http://127.0.0.1:8080/health?', 'http://127.0.0.1:8080/health?ok=1']) {
    const response = await f.request('/api/monitors', 'POST', { projectId: project.id, url });
    assert.equal(response.status, 400);
    assert.equal(JSON.stringify(response.body).includes(canary), false);
  }
  assert.equal(f.app.store.all('monitors').length, 0);
  assert.equal(f.app.store.all('incidents').length, 0);
  assert.equal(JSON.stringify(f.app.store.all('audit')).includes(canary), false);
  const accepted = await f.request('/api/monitors', 'POST', { projectId: project.id, url: 'http://127.0.0.1:8080/health' });
  assert.equal(accepted.status, 201);
  // Old persisted URLs are revalidated before any fetch or error/incident logging.
  f.app.store.put('monitors', { ...accepted.body, url: `http://127.0.0.1:8080/health?token=${canary}` });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Probe forbidden in security tests'); });
  await assert.rejects(f.app.monitoring.check(accepted.body.id, 'test'), (error: unknown) => error instanceof AppError && error.status === 400);
  assert.equal(fetchMock.mock.callCount(), 0);
  fetchMock.mock.restore();
  assert.equal(JSON.stringify({ audit: f.app.store.all('audit'), incidents: f.app.store.all('incidents') }).includes(canary), false);
});

test('password setup/login preserve boundary whitespace and validate raw length; usernames still trim', async t => {
  const password = ' 0123456789 '; // 12 raw characters, only 10 after trim.
  const f = await fixture(t, password);
  assert.equal((await f.request('/api/auth/login', 'POST', { username: 'security-admin', password: password.trim() })).status, 401);
  const login = await f.request('/api/auth/login', 'POST', { username: '  security-admin  ', password });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.username, 'security-admin');
  for (const value of ['', 'x'.repeat(129), null, [password]]) {
    assert.equal((await f.request('/api/auth/login', 'POST', { username: 'security-admin', password: value })).status, 400);
  }
  assert.equal(JSON.stringify(f.app.store.all('audit')).includes(password), false);
});
