import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/api.js';
import { Auth } from '../src/server/auth.js';
import type { AppConfig } from '../src/server/config.js';
import { Store } from '../src/server/db.js';
import { AppError } from '../src/server/policy.js';
import { ZcodeRunner } from '../src/server/runners/zcode.js';
import type {
  AgentRun, AuthState, Capabilities, Dashboard, Employee, Project, Role,
  SkillAssignment, SkillCatalog, SkillContent, SkillDetail, SkillDraft, SkillUsage,
  SkillVersion, Task, TestRun,
} from '../src/shared/types.js';

// All data belongs to a fresh temporary Store and all HTTP uses an ephemeral loopback
// listener. Only runFake may run: no main server, model, CLI, Docker or project code.
async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiyansi-skills-api-'));
  const database = path.join(dir, 'test-only.sqlite');
  const config: AppConfig = {
    port: 0, dataDir: dir, workspaceRoot: path.join(dir, 'workspaces'),
    realExecutionEnabled: false, monitoringEnabled: false,
    zcode: { electronPath: 'NEVER_EXECUTE', cliPath: 'NEVER_EXECUTE', enabled: false, isolationVerified: false, timeoutMs: 100, runtimeHome: path.join(dir, 'home') },
    docker: { executable: 'NEVER_EXECUTE', image: 'test-only', timeoutMs: 100 },
  };
  const forbidden = () => { throw new Error('External execution is forbidden in skills API tests'); };
  const processes = [
    t.mock.method(childProcess, 'spawn', forbidden), t.mock.method(childProcess, 'spawnSync', forbidden),
    t.mock.method(childProcess, 'exec', forbidden), t.mock.method(childProcess, 'execSync', forbidden),
    t.mock.method(childProcess, 'execFile', forbidden), t.mock.method(childProcess, 'execFileSync', forbidden),
    t.mock.method(childProcess, 'fork', forbidden),
  ];
  syncBuiltinESMExports();
  const zcode = t.mock.method(ZcodeRunner.prototype, 'run', async () => forbidden());
  const capabilities: Capabilities = {
    zcode: { ready: false, reason: 'test disabled' }, docker: { ready: false, reason: 'test disabled' },
    realExecution: { ready: false, reason: 'test disabled' },
    mergeExecution: { ready: false, reason: 'test disabled' }, releaseExecution: { ready: false, reason: 'test disabled' },
  };
  let app: ReturnType<typeof createApp>;
  let open = false, base = '', cookie = '', csrf = '';
  t.after(async () => {
    try {
      if (open) { open = false; await app.close(); }
      assert.equal(zcode.mock.callCount(), 0, 'No real agent runner may be invoked');
      for (const mock of processes) assert.equal(mock.mock.callCount(), 0, 'No child process or Docker probe may be invoked');
    } finally {
      for (const mock of processes) mock.mock.restore();
      syncBuiltinESMExports();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  const start = async () => {
    app = createApp(config, new Store(database));
    open = true;
    t.mock.method(app.workflow, 'capabilities', async () => capabilities);
    await new Promise<void>((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', () => { app.server.off('error', reject); resolve(); });
    });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  };
  const request = async <T = unknown>(route: string, method = 'GET', value?: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(base + route, {
      method, signal: AbortSignal.timeout(5000),
      headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() as T };
  };
  await start();
  const credentials = { username: 'skills-test-admin', password: 'Throwaway-Skills-Test-Only-2026!' };
  const setup = await request<AuthState>('/api/auth/setup', 'POST', credentials);
  assert.equal(setup.status, 200);
  assert.ok(setup.body.user);
  const userId = setup.body.user.id;
  cookie = setup.headers.get('set-cookie')!.split(';')[0];
  csrf = setup.body.csrfToken!;
  const project = async (name = 'Skills HTTP fixture') => {
    const reply = await request<Project>('/api/projects', 'POST', { name });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return reply.body;
  };
  const team = async (p: Project) => {
    const dashboard = await request<Dashboard>('/api/dashboard');
    assert.equal(dashboard.status, 200);
    const members = {} as Record<'lead' | 'developer' | 'qa', Employee>;
    for (const role of ['lead', 'developer', 'qa'] as const) {
      const employee = dashboard.body.employees.find(item => item.role === role)!;
      const reply = await request<Employee>(`/api/employees/${employee.id}`, 'PATCH', { projectIds: [...new Set([...employee.projectIds, p.id])] });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      members[role] = reply.body;
    }
    return members;
  };
  const task = async (p: Project, members: Awaited<ReturnType<typeof team>>, goal = 'Simulate independent addition review; never execute project code') => {
    const reply = await request<Task>('/api/tasks', 'POST', {
      title: 'Skills integration task', goal, projectId: p.id,
      leaderId: members.lead.id, developerId: members.developer.id, qaId: members.qa.id,
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return reply.body;
  };
  const restart = async () => {
    open = false; await app.close(); await start();
  };
  return { get app() { return app; }, get base() { return base; }, get cookie() { return cookie; }, get csrf() { return csrf; },
    dir, database, config, userId, request, project, team, task, restart };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type TaskDetail = { task: Task; runs: AgentRun[]; tests: TestRun[] };

function content(title = 'Review finite numeric inputs'): SkillContent {
  return { title, purpose: 'Reusable review notes, not execution authority.', conditions: 'Only within the explicitly assigned project.',
    steps: ['Check both input types.', 'Review finite numeric boundaries with independent QA.'],
    cautions: ['Manual notes do not establish passing tests or production readiness.'], verification: 'Inspect independently recorded evidence before accepting changes.', tags: ['input-review'] };
}
function review(draft: SkillDraft) { return { expectedRevision: draft.revision, expectedHash: draft.contentHash, note: 'Human reviewed these limited reference notes.' }; }
function edit(draft: SkillDraft, next = draft.content) { return { expectedRevision: draft.revision, expectedHash: draft.contentHash, content: next, roles: draft.roles, projectIds: draft.projectIds }; }
function usage(version: SkillVersion): SkillUsage {
  return { versionId: version.id, skillId: version.skillId, version: version.version, title: version.content.title, contentHash: version.contentHash, usePolicy: version.usePolicy };
}
function catalogSnapshot(f: Fixture) {
  const catalog = f.app.workflow.skills.catalog();
  return Object.fromEntries(Object.entries(catalog).map(([key, rows]) => [key, [...rows].sort((a, b) => a.id.localeCompare(b.id))]));
}
async function manual(f: Fixture, p: Project, roles: Role[] = ['developer']): Promise<SkillDraft> {
  const reply = await f.request<SkillDraft>('/api/skills/drafts', 'POST', { content: content(), roles, projectIds: [p.id] });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body;
}
async function publish(f: Fixture, draft: SkillDraft): Promise<SkillVersion> {
  const reply = await f.request<SkillVersion>(`/api/skills/drafts/${draft.id}/publish`, 'POST', review(draft));
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  assert.equal(reply.body.publishedBy, f.userId);
  return reply.body;
}
async function assign(f: Fixture, employee: Employee, p: Project, versions: SkillVersion[]) {
  const reply = await f.request<SkillAssignment[]>(`/api/employees/${employee.id}/skills`, 'POST', { assignments: versions.map(version => ({ versionId: version.id, projectIds: [p.id] })) });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.deepEqual(reply.body.map(item => item.versionId).sort(), versions.map(version => version.id).sort());
  for (const item of reply.body) { assert.equal(item.employeeId, employee.id); assert.equal(item.assignedBy, f.userId); assert.deepEqual(item.projectIds, [p.id]); }
  return reply.body;
}
async function simulate(f: Fixture, task: Task) {
  const reply = await f.request<Task>(`/api/tasks/${task.id}/run`, 'POST', { mode: 'simulation' });
  assert.equal(reply.status, 202, JSON.stringify(reply.body));
  await f.app.workflow.waitForIdle(10_000);
  const detail = await f.request<TaskDetail>(`/api/tasks/${task.id}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.task.batchId);
  return detail.body;
}

test('HTTP assignment accepts nine skills and preserves every version in subsequent run snapshots', async t => {
  const f = await fixture(t), p = await f.project(), members = await f.team(p);
  const versions: SkillVersion[] = [];
  for (let index = 0; index < 9; index++) {
    const draft = await f.request<SkillDraft>('/api/skills/drafts', 'POST', {
      content: content(`Review skill ${index + 1}`), roles: ['developer'], projectIds: [p.id],
    });
    assert.equal(draft.status, 201);
    versions.push(await publish(f, draft.body));
  }
  const assigned = await assign(f, members.developer, p, versions);
  assert.equal(assigned.length, 9);
  const resolved = f.app.workflow.skills.resolve(members.developer, p.id, 'simulation', 'development');
  assert.equal(resolved.skills.length, 9);
  assert.ok(Buffer.byteLength(resolved.reference) <= 24 * 1024);
  const task = await f.task(p, members);
  const detail = await simulate(f, task);
  const development = detail.runs.find(run => run.stage === 'development')!;
  assert.equal(development.skillsUsed?.length, 9);
  assert.deepEqual(development.skillsUsed?.map(item => item.versionId).sort(), versions.map(item => item.id).sort());
  await f.restart();
  assert.equal(f.app.store.all('skillAssignments').filter(item => item.employeeId === members.developer.id).length, 9);
});

// 1. Manual provenance is server-owned, review is optimistic, and publication is append-only.
test('manual draft HTTP lifecycle rejects forged provenance and stale review without mutating immutable versions', async t => {
  const f = await fixture(t), p = await f.project(), members = await f.team(p);
  const payload = { content: content(), roles: ['developer'], projectIds: [p.id] };
  const forged = { source: { kind: 'task', outcome: 'passed' }, usePolicy: 'task_observation', status: 'published', createdBy: f.userId, publishedBy: f.userId, contentHash: 'forged', revision: 1, taskId: 'task-forged', batchId: 'batch-forged', testIds: ['test-forged'], actor: { type: 'user', id: f.userId } };
  for (const [key, value] of Object.entries(forged)) {
    assert.equal((await f.request('/api/skills/drafts', 'POST', { ...payload, [key]: value })).status, 400, key);
  }
  assert.equal(f.app.store.all('skillDrafts').length, 0);
  const draft = await manual(f, p);
  assert.equal(draft.status, 'draft'); assert.equal(draft.revision, 1); assert.equal(draft.createdBy, f.userId);
  assert.equal(draft.usePolicy, 'manual_unverified'); assert.equal(draft.source.kind, 'manual'); assert.equal(draft.source.outcome, 'manual');
  for (const key of ['taskId', 'taskVersion', 'batchId', 'employeeId', 'projectId', 'runId', 'stage', 'mode'] as const) assert.equal(draft.source[key], null);
  assert.deepEqual(draft.source.testIds, []); assert.ok(draft.source.limitations.length); assert.match(draft.source.evidenceHash, /^[a-f0-9]{64}$/);
  const updated = await f.request<SkillDraft>(`/api/skills/drafts/${draft.id}`, 'PATCH', edit(draft, content('Edited human review notes')));
  assert.equal(updated.status, 200); const current = updated.body;
  assert.equal(current.revision, 2); assert.notEqual(current.contentHash, draft.contentHash); assert.deepEqual(current.source, draft.source);
  assert.equal((await f.request(`/api/skills/drafts/${draft.id}`, 'PATCH', edit(draft))).status, 409);
  assert.equal((await f.request(`/api/skills/drafts/${draft.id}`, 'PATCH', { ...edit(current), expectedHash: draft.contentHash })).status, 409);
  assert.equal((await f.request(`/api/skills/drafts/${draft.id}/publish`, 'POST', { ...review(current), expectedRevision: 1 })).status, 409);
  assert.equal((await f.request(`/api/skills/drafts/${draft.id}/publish`, 'POST', { ...review(current), expectedHash: draft.contentHash })).status, 409);
  assert.equal((await f.request(`/api/skills/drafts/${draft.id}`, 'PATCH', { ...edit(current), source: { kind: 'manual' } })).status, 400);
  assert.deepEqual(f.app.store.get('skillDrafts', draft.id), current);
  assert.equal(f.app.store.all('skillReviews').length, 0); assert.equal(f.app.store.all('skillVersions').length, 0);
  assert.throws(() => f.app.workflow.skills.publish({ type: 'agent', id: members.developer.id }, draft.id, review(current)), (error: unknown) => error instanceof AppError && error.status === 403);
  assert.equal((await f.request(`/api/skills/drafts/${draft.id}/publish`, 'POST', { ...review(current), actor: { type: 'user', id: f.userId } })).status, 400);
  const version = await publish(f, current);
  assert.equal(version.version, 1); assert.equal(version.contentHash, current.contentHash); assert.deepEqual(version.source, current.source);
  assert.equal(version.usePolicy, 'manual_unverified'); assert.equal(f.app.store.all('skillAssignments').length, 0);
  assert.deepEqual(f.app.workflow.skills.resolve(members.developer, p.id, 'simulation', 'development').skills, []);
  assert.equal((await f.request(`/api/skills/drafts/${draft.id}/publish`, 'POST', review(current))).status, 409);
  assert.equal((await f.request(`/api/skills/drafts/${draft.id}`, 'PATCH', edit(current))).status, 409);
  assert.equal((await f.request(`/api/skills/versions/${version.id}`, 'PATCH', { content: content('Overwrite forbidden') })).status, 404);
  assert.equal((await f.request(`/api/skills/versions/${version.id}`, 'DELETE', {})).status, 404);
  const reviews = f.app.store.all('skillReviews');
  assert.equal(reviews.length, 1); assert.equal(reviews[0].userId, f.userId); assert.equal(reviews[0].contentHash, version.contentHash);
  assert.throws(() => f.app.store.put('skillVersions', { ...version, content: content('Overwrite forbidden') }));
  assert.throws(() => f.app.store.sql.prepare('UPDATE records SET body=? WHERE collection=? AND id=?').run(JSON.stringify({ ...version, version: 99 }), 'skillVersions', version.id), /immutable/i);
  assert.throws(() => f.app.store.sql.prepare('DELETE FROM records WHERE collection=? AND id=?').run('skillReviews', reviews[0].id), /cannot be deleted/i);
  const detail = await f.request<SkillDetail>(`/api/skills/versions/${version.id}`);
  assert.equal(detail.status, 200); assert.deepEqual(detail.body.version, version); assert.deepEqual(detail.body.reviews, reviews);
  assert.equal(detail.body.draft?.status, 'published'); assert.equal(f.app.store.all('runs').length, 0);
});

// 2. Exercise real HTTP -> queue -> runFake -> final capture, not a mocked workflow.
test('explicit skill assignment is pinned in simulated runs; final capture creates three simulation-only drafts', async t => {
  const f = await fixture(t), p = await f.project(), members = await f.team(p);
  const version = await publish(f, await manual(f, p));
  const before = f.app.workflow.skills.resolve(members.developer, p.id, 'simulation', 'development');
  assert.deepEqual(before.skills, []); assert.equal(before.reference, '');
  await assign(f, members.developer, p, [version]);
  const resolved = f.app.workflow.skills.resolve(members.developer, p.id, 'simulation', 'development');
  assert.deepEqual(resolved.skills, [usage(version)]); assert.notEqual(resolved.fingerprint, before.fingerprint);
  assert.ok(resolved.reference.includes('knowledge_only')); assert.ok(resolved.reference.includes('"grantsPermissions":false'));
  const contexts = new Map<string, string>();
  const originalContext = f.app.workflow.workspaces.readContext.bind(f.app.workflow.workspaces);
  t.mock.method(f.app.workflow.workspaces, 'readContext', (workspace: string) => {
    const value = originalContext(workspace);
    const running = f.app.store.all('tasks').find(task => f.app.workflow.taskWorkspace(task.id) === workspace)!;
    const stage = running.status === 'planning' ? 'planning' : running.status === 'developing' ? 'development' : 'qa';
    contexts.set(`${running.id}:${stage}`, value);
    return value;
  });
  const task = await f.task(p, members), detail = await simulate(f, task);
  assert.equal(detail.task.status, 'awaiting_merge'); assert.equal(detail.runs.length, 3); assert.equal(detail.tests.length, 1);
  assert.equal(detail.tests[0].mode, 'simulation'); assert.equal(detail.tests[0].image, 'simulation-only'); assert.equal(detail.tests[0].imageDigest, null);
  for (const run of detail.runs) {
    assert.equal(run.mode, 'simulation'); assert.equal(run.taskVersion, task.version); assert.equal(run.batchId, detail.task.batchId); assert.equal(run.projectId, p.id);
    assert.equal(run.learningCaptureStatus, 'saved'); assert.equal(run.status, 'succeeded');
    assert.deepEqual(run.skillsUsed, run.stage === 'development' ? [usage(version)] : []);
    const employee = f.app.store.get('employees', run.employeeId)!;
    const knowledge = f.app.workflow.skills.resolve(employee, p.id, 'simulation', run.stage);
    const context = contexts.get(`${task.id}:${run.stage}`); assert.equal(typeof context, 'string');
    const expectedFingerprint = createHash('sha256').update(JSON.stringify({ taskId: task.id, taskVersion: task.version, goal: task.goal, stage: run.stage, mode: 'simulation', employeeId: employee.id, duties: employee.duties, skillFingerprint: knowledge.fingerprint, executionFingerprint: null, context })).digest('hex');
    assert.equal(run.contextFingerprint, expectedFingerprint, `exact context fingerprint for ${run.stage}`);
  }
  const catalog = await f.request<SkillCatalog>('/api/skills');
  assert.equal(catalog.status, 200);
  const drafts = catalog.body.drafts.filter(item => item.source.kind === 'task');
  assert.equal(drafts.length, 3); assert.equal(new Set(drafts.map(item => item.source.runId)).size, 3);
  for (const draft of drafts) {
    const run = detail.runs.find(item => item.id === draft.source.runId)!;
    assert.ok(run); assert.equal(draft.status, 'draft'); assert.equal(draft.publishedVersionId, null); assert.equal(draft.createdBy, 'system');
    assert.equal(draft.usePolicy, 'simulation_only'); assert.equal(draft.source.mode, 'simulation'); assert.equal(draft.source.outcome, 'passed');
    assert.equal(draft.source.taskId, task.id); assert.equal(draft.source.taskVersion, task.version); assert.equal(draft.source.batchId, detail.task.batchId);
    assert.equal(draft.source.employeeId, run.employeeId); assert.equal(draft.source.projectId, p.id); assert.equal(draft.source.stage, run.stage);
    assert.deepEqual(draft.source.testIds, [detail.tests[0].id]); assert.match(draft.source.evidenceHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(draft.projectIds, [p.id]); assert.deepEqual(draft.roles, [f.app.store.get('employees', run.employeeId)!.role]);
  }
  assert.equal(detail.tests[0].taskVersion, task.version); assert.equal(detail.tests[0].batchId, detail.task.batchId);
  assert.equal(detail.tests[0].agentRunId, detail.runs.find(run => run.stage === 'qa')!.id);
  assert.equal(catalog.body.versions.length, 1); assert.equal(catalog.body.assignments.length, 1);
  const learned = await publish(f, drafts.find(draft => draft.source.stage === 'development')!);
  assert.equal(learned.usePolicy, 'simulation_only'); assert.equal(learned.source.mode, 'simulation');
  await assign(f, members.developer, p, [version, learned]);
  assert.deepEqual(f.app.workflow.skills.resolve(members.developer, p.id, 'simulation', 'development').skills.map(item => item.versionId).sort(), [version.id, learned.id].sort());
  const real = f.app.workflow.skills.resolve(members.developer, p.id, 'zcode', 'development');
  assert.deepEqual(real.skills, [usage(version)]); assert.equal(real.reference.includes(learned.id), false);
  assert.equal((await f.request(`/api/tasks/${task.id}/approve`, 'POST', { kind: 'merge', taskVersion: task.version, contentHash: detail.task.contentHash })).status, 409);
  const unrun = await f.task(p, members);
  assert.equal((await f.request(`/api/tasks/${unrun.id}/run`, 'POST', { mode: 'zcode' })).status, 409);
  assert.equal(f.app.store.all('approvals').length, 0); assert.equal(f.app.store.all('runs').length, 3);
});

// 3. New versions, explicit upgrades and disables affect future use, never old evidence.
test('published revisions do not auto-upgrade pins; explicit upgrades and disable preserve historical skillsUsed', async t => {
  const f = await fixture(t), p = await f.project(), members = await f.team(p);
  const v1 = await publish(f, await manual(f, p)); await assign(f, members.developer, p, [v1]);
  const first = await simulate(f, await f.task(p, members));
  const history = first.runs.map(run => ({ id: run.id, skillsUsed: run.skillsUsed, contextFingerprint: run.contextFingerprint }));
  const originalResolution = f.app.workflow.skills.resolve(members.developer, p.id, 'simulation', 'development');
  const revised = await f.request<SkillDraft>(`/api/skills/versions/${v1.id}/revise`, 'POST', {});
  assert.equal(revised.status, 201); assert.equal(revised.body.baseVersionId, v1.id);
  const changed = await f.request<SkillDraft>(`/api/skills/drafts/${revised.body.id}`, 'PATCH', edit(revised.body, content('Version two review notes')));
  assert.equal(changed.status, 200); const v2 = await publish(f, changed.body);
  assert.equal(v2.skillId, v1.skillId); assert.equal(v2.version, 2); assert.notEqual(v2.id, v1.id); assert.notEqual(v2.contentHash, v1.contentHash);
  assert.deepEqual(f.app.store.get('skillVersions', v1.id), v1);
  assert.deepEqual(f.app.workflow.skills.resolve(members.developer, p.id, 'simulation', 'development'), originalResolution);
  assert.equal(f.app.store.all('skillAssignments')[0].versionId, v1.id);
  const pinned = await simulate(f, await f.task(p, members));
  assert.deepEqual(pinned.runs.find(run => run.stage === 'development')!.skillsUsed, [usage(v1)]);
  await assign(f, members.developer, p, [v2]);
  const upgradedResolution = f.app.workflow.skills.resolve(members.developer, p.id, 'simulation', 'development');
  assert.deepEqual(upgradedResolution.skills, [usage(v2)]); assert.notEqual(upgradedResolution.fingerprint, originalResolution.fingerprint);
  const workspace = f.app.workflow.taskWorkspace(first.task.id);
  f.app.store.saveSession(members.developer.id, p.id, workspace, 'throwaway-session-never-used', originalResolution.fingerprint);
  assert.equal(f.app.store.sessionFor(members.developer.id, p.id, workspace, originalResolution.fingerprint), 'throwaway-session-never-used');
  assert.equal(f.app.store.sessionFor(members.developer.id, p.id, workspace, upgradedResolution.fingerprint), undefined);
  const upgraded = await simulate(f, await f.task(p, members));
  assert.deepEqual(upgraded.runs.find(run => run.stage === 'development')!.skillsUsed, [usage(v2)]);
  assert.equal((await f.request(`/api/skills/versions/${v2.id}/availability`, 'PATCH', { enabled: false })).status, 200);
  const disabled = f.app.workflow.skills.resolve(members.developer, p.id, 'simulation', 'development');
  assert.deepEqual(disabled.skills, []); assert.equal(disabled.reference, ''); assert.notEqual(disabled.fingerprint, upgradedResolution.fingerprint);
  assert.equal(f.app.store.all('skillAssignments')[0].versionId, v2.id, 'Disable must not silently fall back to v1');
  assert.equal((await f.request(`/api/employees/${members.developer.id}/skills`, 'POST', { assignments: [{ versionId: v2.id, projectIds: [p.id] }] })).status, 409);
  const afterDisable = await simulate(f, await f.task(p, members));
  assert.deepEqual(afterDisable.runs.find(run => run.stage === 'development')!.skillsUsed, []);
  for (const old of history) {
    const current = f.app.store.get('runs', old.id)!;
    assert.deepEqual({ id: current.id, skillsUsed: current.skillsUsed, contextFingerprint: current.contextFingerprint }, old);
  }
  assert.deepEqual(f.app.store.get('runs', upgraded.runs.find(run => run.stage === 'development')!.id)!.skillsUsed, [usage(v2)]);
  assert.deepEqual(f.app.store.get('skillVersions', v2.id), v2);
});

// 4. Old capture is scoped to the original batch, not to the current mutable task.
test('revision and retry produce distinct deduplicated batches; captured old evidence stays publishable', async t => {
  const f = await fixture(t), p = await f.project(), members = await f.team(p), task = await f.task(p, members);
  const first = await simulate(f, task), firstBatch = first.task.batchId!;
  const oldDrafts = f.app.store.all('skillDrafts').filter(draft => draft.source.batchId === firstBatch);
  assert.equal(oldDrafts.length, 3);
  const beforeReplay = catalogSnapshot(f);
  for (let replay = 0; replay < 2; replay++) assert.deepEqual(f.app.workflow.skills.captureBatch(firstBatch).map(item => item.id).sort(), oldDrafts.map(item => item.id).sort());
  assert.deepEqual(catalogSnapshot(f), beforeReplay);
  const revised = await f.request<Task>(`/api/tasks/${task.id}/revise`, 'POST', { goal: '模拟失败: retain failed review evidence in a separate batch' });
  assert.equal(revised.status, 200); assert.equal(revised.body.version, 2); assert.equal(revised.body.batchId, null);
  const oldPublished = await publish(f, oldDrafts.find(draft => draft.source.stage === 'development')!);
  assert.equal(oldPublished.source.taskVersion, 1); assert.equal(oldPublished.source.batchId, firstBatch); assert.equal(oldPublished.usePolicy, 'simulation_only');
  const second = await simulate(f, revised.body), secondBatch = second.task.batchId!;
  assert.equal(second.task.status, 'changes_requested'); assert.notEqual(secondBatch, firstBatch);
  const retry = await f.request<Task>(`/api/tasks/${task.id}/revise`, 'POST', { goal: 'Retry simulation with a corrected independent review' });
  assert.equal(retry.status, 200); assert.equal(retry.body.version, 3);
  const third = await simulate(f, retry.body), thirdBatch = third.task.batchId!;
  assert.equal(third.task.status, 'awaiting_merge'); assert.equal(new Set([firstBatch, secondBatch, thirdBatch]).size, 3);
  const drafts = f.app.store.all('skillDrafts'); assert.equal(drafts.length, 9);
  assert.equal(new Set(drafts.map(draft => draft.dedupeKey)).size, 9);
  for (const [batchId, version, outcome] of [[firstBatch, 1, 'passed'], [secondBatch, 2, 'failed'], [thirdBatch, 3, 'passed']] as const) {
    const captured = drafts.filter(draft => draft.source.batchId === batchId), tests = third.tests.filter(item => item.batchId === batchId);
    assert.equal(captured.length, 3); assert.equal(tests.length, 1);
    for (const draft of captured) {
      assert.equal(draft.source.taskVersion, version); assert.equal(draft.source.outcome, outcome); assert.deepEqual(draft.source.testIds, [tests[0].id]);
      assert.equal(f.app.store.get('runs', draft.source.runId!)!.batchId, batchId);
    }
  }
  const captured = catalogSnapshot(f);
  for (const batchId of [firstBatch, secondBatch, thirdBatch]) f.app.workflow.skills.captureBatch(batchId);
  assert.deepEqual(catalogSnapshot(f), captured);
  const oldLead = oldDrafts.find(draft => draft.source.stage === 'planning')!;
  const historyDetail = await f.request<SkillDetail>(`/api/skills/drafts/${oldLead.id}`);
  assert.equal(historyDetail.status, 200); assert.equal(historyDetail.body.run?.taskVersion, 1);
  assert.deepEqual(historyDetail.body.tests.map(item => item.id), oldLead.source.testIds);
  const publishedAfterRetry = await publish(f, oldLead);
  assert.deepEqual(publishedAfterRetry.source, oldLead.source);
  assert.deepEqual(f.app.store.get('skillVersions', oldPublished.id), oldPublished);
});

// 5. Roles/project scopes are enforced both at binding and at use; secrets never enter the catalog.
test('skills HTTP rejects malformed fields, scope escalation and secret canaries without partial writes', async t => {
  const f = await fixture(t), p = await f.project(), members = await f.team(p), other = await f.project('Unassigned project');
  const payload = { content: content(), roles: ['developer'], projectIds: [p.id] };
  const malformed: unknown[] = [null, [], {}, { ...payload, roles: 'developer' }, { ...payload, roles: ['admin'] }, { ...payload, roles: ['developer', 'developer'] },
    { ...payload, projectIds: [] }, { ...payload, projectIds: ['project-does-not-exist'] }, { ...payload, content: { ...content(), steps: 'not an array' } },
    { ...payload, content: { ...content(), tags: ['duplicate', 'duplicate'] } }, { ...payload, content: { ...content(), title: 'x'.repeat(257) } },
    { ...payload, content: { ...content(), source: { outcome: 'passed' } } }, { ...payload, content: { ...content(), steps: Array(13).fill('bounded') } }];
  for (const value of malformed) assert.equal((await f.request('/api/skills/drafts', 'POST', value)).status, 400, JSON.stringify(value));
  assert.equal(f.app.store.all('skillDrafts').length, 0);
  const draft = await manual(f, p), version = await publish(f, draft);
  await assign(f, members.developer, p, [version]);
  const snapshot = catalogSnapshot(f);
  const denied: [string, string, unknown, number][] = [
    [`/api/employees/${members.qa.id}/skills`, 'POST', { assignments: [{ versionId: version.id, projectIds: [p.id] }] }, 400],
    [`/api/employees/${members.developer.id}/skills`, 'POST', { assignments: [{ versionId: version.id, projectIds: [other.id] }] }, 400],
    [`/api/employees/${members.developer.id}/skills`, 'POST', { assignments: [{ versionId: draft.id, projectIds: [p.id] }] }, 404],
    [`/api/employees/${members.developer.id}/skills`, 'POST', { assignments: [{ versionId: version.id, projectIds: [p.id], employeeId: members.qa.id }] }, 400],
    [`/api/employees/${members.developer.id}/skills`, 'POST', { assignments: [{ versionId: version.id, projectIds: [p.id] }, { versionId: version.id, projectIds: [p.id] }] }, 400],
    [`/api/employees/${members.developer.id}/skills`, 'POST', { assignments: null }, 400],
    [`/api/skills/versions/${version.id}/availability`, 'PATCH', { enabled: 'false' }, 400],
    [`/api/skills/versions/${version.id}/availability`, 'PATCH', { enabled: false, usePolicy: 'task_observation' }, 400],
    [`/api/skills/versions/${version.id}/revise`, 'POST', { source: { kind: 'manual' } }, 400],
  ];
  for (const [route, method, value, status] of denied) assert.equal((await f.request(route, method, value)).status, status, route);
  assert.deepEqual(catalogSnapshot(f), snapshot);
  assert.deepEqual(f.app.workflow.skills.resolve(members.qa, p.id, 'simulation', 'qa').skills, []);
  assert.deepEqual(f.app.workflow.skills.resolve(members.developer, other.id, 'simulation', 'development').skills, []);
  assert.deepEqual(f.app.workflow.skills.resolve(members.developer, p.id, 'simulation', 'qa').skills, []);
  assert.equal((await f.request(`/api/employees/${members.developer.id}`, 'PATCH', { projectIds: [p.id, other.id] })).status, 200);
  assert.equal((await f.request(`/api/employees/${members.developer.id}/skills`, 'POST', { assignments: [{ versionId: version.id, projectIds: [other.id] }] })).status, 400, 'Employee scope alone cannot expand the version scope');
  assert.equal((await f.request(`/api/employees/${members.developer.id}`, 'PATCH', { projectIds: [] })).status, 200);
  assert.deepEqual(f.app.workflow.skills.resolve(members.developer, p.id, 'simulation', 'development').skills, [], 'Stale employee objects cannot retain revoked project authority');
  const editable = await manual(f, p);
  const canary = 'SKILLS_TEST_CANARY_NOT_A_REAL_CREDENTIAL';
  const secrets = [
    { ...payload, content: { ...content(), purpose: `token=${canary}` } },
    { ...payload, content: { ...content(), steps: [`Authorization: Bearer ${canary}`] } },
  ];
  const beforeSecrets = catalogSnapshot(f);
  for (const value of secrets) {
    const reply = await f.request('/api/skills/drafts', 'POST', value);
    assert.equal(reply.status, 400); assert.equal(JSON.stringify(reply.body).includes(canary), false);
  }
  for (const [route, method, value] of [
    [`/api/skills/drafts/${editable.id}`, 'PATCH', edit(editable, { ...content(), cautions: [`password=${canary}`] })],
    [`/api/skills/drafts/${editable.id}/publish`, 'POST', { ...review(editable), note: `api_key=${canary}` }],
    [`/api/skills/drafts/${editable.id}/publish`, 'POST', { ...review(editable), expectedRevision: '1' }],
    [`/api/skills/drafts/${editable.id}/publish`, 'POST', { ...review(editable), expectedHash: [] }],
  ] as const) {
    const reply = await f.request(route, method, value);
    assert.equal(reply.status, 400); assert.equal(JSON.stringify(reply.body).includes(canary), false);
  }
  assert.deepEqual(catalogSnapshot(f), beforeSecrets);
  for (const route of ['/api/skills', `/api/skills/drafts/${editable.id}`, '/api/dashboard']) {
    const reply = await f.request(route); assert.equal(reply.status, 200); assert.equal(JSON.stringify(reply.body).includes(canary), false);
  }
  const records = f.app.store.sql.prepare('SELECT body FROM records').all();
  assert.equal(JSON.stringify(records).includes(canary), false);
  assert.equal((await f.request('/api/skills', 'GET', undefined, { Cookie: '' })).status, 401);
  assert.equal((await f.request('/api/skills/drafts', 'POST', payload, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await f.request('/api/skills/drafts', 'POST', payload, { Origin: 'https://not-local.example' })).status, 403);
});

// 6–7. The request is identified before its last bytes; revocation must be rechecked afterwards.
for (const revoke of ['logout', 'expiry'] as const) {
  test(`streamed draft publish cannot mutate after session ${revoke}`, { timeout: 10_000 }, async t => {
    const f = await fixture(t), p = await f.project(), draft = await manual(f, p);
    const route = `/api/skills/drafts/${draft.id}/publish`, payload = JSON.stringify(review(draft));
    let identified!: () => void;
    const ready = new Promise<void>(resolve => { identified = resolve; });
    const original = Auth.prototype.identify;
    t.mock.method(Auth.prototype, 'identify', function (this: Auth, req: http.IncomingMessage) {
      const identity = original.call(this, req);
      if (req.url === route && identity) identified();
      return identity;
    });
    const snapshot = catalogSnapshot(f);
    let client!: http.ClientRequest;
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      client = http.request(f.base + route, { method: 'POST', headers: {
        Origin: f.base, Cookie: f.cookie, 'X-CSRF-Token': f.csrf, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
      } }, res => {
        let data = ''; res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body: data })); res.on('error', reject);
      });
      client.on('error', reject); client.setTimeout(5000, () => client.destroy(new Error('Deferred publish timed out')));
      client.write(payload.slice(0, 5));
    });
    void response.catch(() => undefined); t.after(() => client.destroy());
    await Promise.race([ready, response.then(() => { throw new Error('Publish ended before the body/revocation barrier'); })]);
    if (revoke === 'logout') assert.equal((await f.request('/api/auth/logout', 'POST', {})).status, 200);
    else f.app.store.sql.prepare('UPDATE sessions SET expires_at=?').run('2000-01-01T00:00:00.000Z');
    client.end(payload.slice(5));
    const reply = await response; assert.equal(reply.status, 401, reply.body);
    assert.deepEqual(catalogSnapshot(f), snapshot);
    assert.equal(f.app.store.all('skillReviews').length, 0); assert.equal(f.app.store.all('skillVersions').length, 0);
    assert.equal(f.app.store.all('skillAvailability').length, 0); assert.equal(f.app.store.all('skillAssignments').length, 0);
    assert.equal(f.app.store.all('audit').some(event => event.action === '技能版本发布'), false);
  });
}

// 8. A restart preserves historical pins but never invents validated evidence for legacy rows.
test('restart persists skills and history without retroactively validating legacy runs missing batch metadata', async t => {
  const f = await fixture(t), p = await f.project(), members = await f.team(p);
  const version = await publish(f, await manual(f, p)); await assign(f, members.developer, p, [version]);
  const completed = await simulate(f, await f.task(p, members));
  assert.equal(completed.task.status, 'awaiting_merge');
  const legacyTask = await f.task(p, members, 'Legacy fixture only; no execution');
  const timestamp = '2025-01-01T00:00:00.000Z';
  const legacyRun: AgentRun = { id: 'run-legacy-test-only', taskId: legacyTask.id, employeeId: members.developer.id,
    stage: 'development', mode: 'simulation', status: 'succeeded', sessionId: null, startedAt: timestamp, endedAt: timestamp,
    exitCode: 0, output: 'Legacy fixture: no batch/version/evidence validation', error: null };
  const legacyTest: TestRun = { id: 'test-legacy-test-only', taskId: legacyTask.id, reviewerId: members.qa.id, mode: 'simulation',
    status: 'passed', exitCode: 0, image: 'simulation-only', imageDigest: null, command: ['NOT_EXECUTED'], log: 'Legacy fixture only',
    contentHash: 'legacy-not-validated', createdAt: timestamp, durationMs: 0 };
  f.app.store.put('runs', legacyRun); f.app.store.put('tests', legacyTest);
  assert.equal((await f.request(`/api/skills/versions/${version.id}/availability`, 'PATCH', { enabled: false })).status, 200);
  const before = catalogSnapshot(f), runs = f.app.store.all('runs'), tests = f.app.store.all('tests');
  await f.restart();
  const auth = await f.request<AuthState>('/api/auth/status');
  assert.equal(auth.status, 200); assert.equal(auth.body.setupRequired, false); assert.equal(auth.body.user?.id, f.userId);
  assert.deepEqual(catalogSnapshot(f), before); assert.deepEqual(f.app.store.all('runs'), runs); assert.deepEqual(f.app.store.all('tests'), tests);
  assert.deepEqual(f.app.store.get('runs', legacyRun.id), legacyRun); assert.deepEqual(f.app.store.get('tests', legacyTest.id), legacyTest);
  assert.deepEqual(f.app.workflow.skills.captureBatch('batch-legacy-unrelated'), []);
  f.app.workflow.skills.captureBatch(completed.task.batchId!);
  assert.deepEqual(catalogSnapshot(f), before);
  const catalog = await f.request<SkillCatalog>('/api/skills'); assert.equal(catalog.status, 200);
  assert.equal(catalog.body.drafts.some(draft => draft.source.runId === legacyRun.id || draft.source.testIds.includes(legacyTest.id)), false);
  assert.deepEqual(f.app.workflow.skills.resolve(members.developer, p.id, 'simulation', 'development').skills, []);
  const detail = await f.request<SkillDetail>(`/api/skills/versions/${version.id}`);
  assert.equal(detail.status, 200); assert.deepEqual(detail.body.version, version);
  const history = await f.request<TaskDetail>(`/api/tasks/${completed.task.id}`);
  assert.equal(history.status, 200); assert.deepEqual(history.body.runs.find(run => run.stage === 'development')!.skillsUsed, [usage(version)]);
  assert.deepEqual(f.app.store.all('approvals'), []);
});
