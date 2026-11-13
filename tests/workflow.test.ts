import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/api.js';
import type { AppConfig } from '../src/server/config.js';
import type { Dashboard, Employee, Project, Task } from '../src/shared/types.js';
import { validateMonitorUrl } from '../src/server/monitoring.js';

function config(dir: string): AppConfig {
  return { port: 0, dataDir: dir, workspaceRoot: path.join(dir, 'workspaces'), realExecutionEnabled: false, monitoringEnabled: false, zcode: { electronPath: 'missing.exe', cliPath: 'missing.cjs', enabled: false, timeoutMs: 1000, isolationVerified: false, runtimeHome: path.join(dir, 'home') }, docker: { executable: 'nonexistent-docker-for-tests', image: 'node:24-alpine', timeoutMs: 1000 } };
}

test('完整本地流程：认证、派工、独立模拟QA、真实批准拒绝、修订失效与重启持久化', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiyansi-workflow-'));
  const cfg = config(dir);
  const app = createApp(cfg);
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  let cookie = '', csrf = '';
  const request = async (route: string, method = 'GET', value?: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(base + route, { method, headers: { ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...extra }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { response, body: await response.json() as any };
  };
  let taskId = '';
  try {
    assert.equal((await request('/api/dashboard')).response.status, 401);
    assert.equal((await request('/api/auth/status')).body.setupRequired, true);
    const setup = await request('/api/auth/setup', 'POST', { username: 'test-admin', password: 'OnlyForAutomatedTest-2026!' });
    assert.equal(setup.response.status, 200);
    cookie = setup.response.headers.get('set-cookie')!.split(';')[0]; csrf = setup.body.csrfToken;
    assert.equal((await request('/api/auth/setup', 'POST', { username: 'another-admin', password: 'OnlyForAutomatedTest-2026!' })).response.status, 409);
    assert.equal((await request('/api/projects', 'POST', { name: '非法跨站' }, { Origin: 'https://evil.example' })).response.status, 403);
    assert.equal((await request('/api/projects', 'POST', { name: '缺少CSRF' }, { 'X-CSRF-Token': '' })).response.status, 403);
    const dash = (await request('/api/dashboard')).body as Dashboard;
    const lead = dash.employees.find(employee => employee.role === 'lead')!;
    const dev = dash.employees.find(employee => employee.role === 'developer')!;
    const qa = dash.employees.find(employee => employee.role === 'qa')!;
    const projectReply = await request('/api/projects', 'POST', { name: '隔离演示', description: '只验证测试目录', leadId: lead.id });
    assert.equal(projectReply.response.status, 201);
    const project = projectReply.body as Project;
    for (const employee of [dev, qa]) {
      const { id, createdAt, ...editable } = employee;
      assert.equal((await request(`/api/employees/${id}`, 'PATCH', { ...editable, projectIds: [project.id] })).response.status, 200);
    }
    const payload = { title: '加法实现', goal: '实现数字加法并验证负数与边界输入', projectId: project.id, leaderId: lead.id, developerId: dev.id, qaId: qa.id };
    assert.equal((await request('/api/tasks', 'POST', { ...payload, qaId: dev.id })).response.status, 400);
    const created = await request('/api/tasks', 'POST', payload);
    assert.equal(created.response.status, 201);
    taskId = (created.body as Task).id;
    assert.equal((await request(`/api/tasks/${taskId}/run`, 'POST', { mode: 'zcode' })).response.status, 409);
    assert.equal((await request(`/api/tasks/${taskId}/run`, 'POST', { mode: 'simulation' })).response.status, 202);
    await app.workflow.waitForIdle(10_000);
    const detail = await request(`/api/tasks/${taskId}`);
    assert.equal(detail.body.task.status, 'awaiting_merge');
    assert.equal(detail.body.runs.length, 3);
    assert.equal(detail.body.tests[0].mode, 'simulation');
    assert.equal(detail.body.tests[0].reviewerId, qa.id);
    assert.ok(detail.body.files.length > 0);
    assert.equal((await request(`/api/tasks/${taskId}/approve`, 'POST', { kind: 'merge', taskVersion: 1, contentHash: detail.body.task.contentHash, note: '不得批准模拟结果' })).response.status, 409);
    const revised = await request(`/api/tasks/${taskId}/revise`, 'POST', { goal: '模拟失败：检查退回机制' });
    assert.equal(revised.body.version, 2); assert.equal(revised.body.contentHash, null); assert.equal(revised.body.status, 'draft');
    assert.equal((await request(`/api/tasks/${taskId}/run`, 'POST', { mode: 'simulation' })).response.status, 202);
    await app.workflow.waitForIdle(10_000);
    assert.equal(app.workflow.task(taskId).status, 'changes_requested');
    assert.equal(app.store.all('approvals').length, 0);
    assert.ok(app.store.all('audit').some(event => event.action.includes('失效')));
  } finally { await app.close(); }
  const restarted = createApp(cfg);
  try {
    assert.equal(restarted.workflow.task(taskId).status, 'changes_requested');
    assert.equal(restarted.store.all('projects').length, 1);
    assert.equal(restarted.store.all('tests').length, 2);
  } finally { await restarted.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('运维探针拒绝外部、凭据、重定向型地址和特权端口', () => {
  assert.equal(validateMonitorUrl('http://127.0.0.1:8080/health').hostname, '127.0.0.1');
  for (const url of ['https://example.com/health', 'http://user:secret@127.0.0.1:8080', 'http://127.0.0.1:80', 'file:///etc/passwd', 'http://localhost:8080']) assert.throws(() => validateMonitorUrl(url));
});
