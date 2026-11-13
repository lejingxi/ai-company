import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/db.js';
import { parseAgentOutput } from '../src/server/runners/zcode.js';
import { Workflow } from '../src/server/workflow.js';
import type { AppConfig } from '../src/server/config.js';
import type { AgentRun, Employee, Project, Task } from '../src/shared/types.js';

const proposal = { title: '边界检查', purpose: '整理边界输入检查方法', conditions: '隔离演示项目', steps: ['核对输入类型', '交独立测试验证'], cautions: ['不代表生产验证'], verification: '检查同批次测试结果', tags: ['边界'] };

test('ZCode learningProposals 使用严格嵌套结构，拒绝伪造来源、秘密与超限', () => {
  const base = { summary: '完成阶段工作', files: [] };
  assert.deepEqual(parseAgentOutput(JSON.stringify({ ...base, learningProposals: [proposal] })).learningProposals, [proposal]);
  for (const learningProposals of [null, {}, [null], Array(4).fill(proposal), [{ ...proposal, publishedBy: 'agent' }], [{ ...proposal, source: { kind: 'manual' } }], [{ ...proposal, title: ['not-string'] }], [{ ...proposal, steps: Array(13).fill('step') }], [{ ...proposal, purpose: 'password=CANARY_SECRET_NEVER_SAVE' }]]) {
    assert.throws(() => parseAgentOutput(JSON.stringify({ ...base, learningProposals })));
  }
  assert.equal(parseAgentOutput(JSON.stringify(base)).learningProposals, undefined, '旧模型输出保持兼容');
});

test('兼容迁移保留旧记录，旧会话不错误匹配技能上下文，版本和审核记录不可改写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiyansi-skill-migration-'));
  const file = path.join(dir, 'company.sqlite');
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE records(collection TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(collection,id));
    CREATE TABLE agent_sessions(employee_id TEXT NOT NULL, project_id TEXT NOT NULL, workspace TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(employee_id,project_id,workspace));
    PRAGMA user_version=1;`);
  legacy.prepare('INSERT INTO records VALUES(?,?,?,?)').run('audit', 'old-event', JSON.stringify({ id: 'old-event', actor: 'human', action: '旧事件', targetId: null, detail: 'must retain', createdAt: '2026-11-11T00:00:00Z' }), '2026-11-11T00:00:00Z');
  legacy.prepare('INSERT INTO agent_sessions VALUES(?,?,?,?)').run('e', 'p', 'w', 'old-session');
  legacy.close();
  const store = new Store(file);
  try {
    assert.equal(store.get('audit', 'old-event')!.detail, 'must retain');
    assert.equal((store.sql.prepare('PRAGMA user_version').get() as any).user_version, 2);
    assert.equal(store.sessionFor('e', 'p', 'w', 'new-knowledge-fingerprint'), undefined);
    store.saveSession('e', 'p', 'w', 'new-session', 'fingerprint-v1');
    assert.equal(store.sessionFor('e', 'p', 'w', 'fingerprint-v1'), 'new-session');
    assert.equal(store.sessionFor('e', 'p', 'w', 'fingerprint-v2'), undefined);
    store.sql.prepare('INSERT INTO records VALUES(?,?,?,?)').run('skillReviews', 'immutable-review', JSON.stringify({ id: 'immutable-review' }), 'now');
    assert.throws(() => store.sql.prepare("UPDATE records SET body='{}' WHERE collection='skillReviews' AND id='immutable-review'").run(), /immutable/);
    assert.throws(() => store.sql.prepare("DELETE FROM records WHERE collection='skillReviews' AND id='immutable-review'").run(), /cannot be deleted/);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('重启只整理有精确批次的中断观察，重复重启不重复生成或自动执行', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiyansi-learning-recovery-'));
  const cfg: AppConfig = { port: 0, dataDir: dir, workspaceRoot: path.join(dir, 'workspaces'), realExecutionEnabled: false, monitoringEnabled: false, zcode: { electronPath: 'never', cliPath: 'never', enabled: false, isolationVerified: false, timeoutMs: 100, runtimeHome: path.join(dir, 'home') }, docker: { executable: 'never', image: 'never', timeoutMs: 100 } };
  const file = path.join(dir, 'company.sqlite');
  let store = new Store(file);
  const employee: Employee = { id: 'dev', name: '开发', role: 'developer', duties: '开发', reportsTo: null, projectIds: ['p'], enabled: true, createdAt: 'start' };
  const project: Project = { id: 'p', name: '测试', description: '', workspace: 'not-used', leadId: null, stack: 'demo', testCommand: [], dockerImage: '', createdAt: 'start' };
  const task: Task = { id: 't', title: '中断任务', goal: '保留观察', projectId: 'p', leaderId: 'lead', developerId: 'dev', qaId: 'qa', status: 'developing', mode: 'simulation', version: 1, batchId: 'batch-one', contentHash: null, plan: null, blockedReason: null, createdAt: 'start', updatedAt: 'start' };
  const run: AgentRun = { id: 'r', taskId: 't', employeeId: 'dev', stage: 'development', mode: 'simulation', status: 'running', sessionId: null, startedAt: 'start', endedAt: null, exitCode: null, output: '{truncated', error: null, taskVersion: 1, batchId: 'batch-one', projectId: 'p', applicationStatus: 'pending', learningCaptureStatus: 'pending' };
  store.put('employees', employee); store.put('projects', project); store.put('tasks', task); store.put('runs', run);
  store.put('runs', { ...run, id: 'legacy', batchId: undefined, taskVersion: undefined, learningCaptureStatus: undefined });
  store.sql.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run('job', 't', 'running', 'start', 'start');
  store.close();
  store = new Store(file);
  const flow = new Workflow(store, cfg);
  try {
    assert.equal(store.get('tasks', 't')!.status, 'blocked');
    const drafts = store.all('skillDrafts');
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].source.runId, 'r');
    assert.equal(drafts[0].source.outcome, 'interrupted');
    assert.equal(drafts[0].usePolicy, 'simulation_only');
    assert.equal(drafts[0].source.taskVersion, 1);
    assert.equal(store.get('runs', 'r')!.learningCaptureStatus, 'saved');
  } finally { await flow.shutdown(); store.close(); }
  store = new Store(file);
  const again = new Workflow(store, cfg);
  try { assert.equal(store.all('skillDrafts').length, 1); assert.equal(store.all('skillVersions').length, 0); }
  finally { await again.shutdown(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
