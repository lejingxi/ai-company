import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/db.js';
import { Skills } from '../src/server/skills.js';
import { AppError, type Actor } from '../src/server/policy.js';
import { validateLearningProposals, validateSkillContent } from '../src/shared/skill-content.js';
import type { AgentRun, Employee, Project, RunMode, SkillContent, SkillDraft, SkillVersion, Task, TestRun } from '../src/shared/types.js';

const human: Actor = { type: 'user', id: 'human' };
const timestamp = '2026-11-12T12:00:00.000Z';
const sample = (title = '验证输入边界'): SkillContent => ({ title, purpose: '记录可复用的边界核查方法', conditions: '适用于本项目数字输入校验', steps: ['列出零、负数与最大值', '独立运行测试并记录证据'], cautions: ['不能用模型自报成功替代独立测试'], verification: '复核与代码哈希一致的测试记录', tags: ['边界', '验证'] });
function fixture() {
  const store = new Store(':memory:');
  store.sql.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(human.id, 'admin', 'test-only', 'test-only', timestamp);
  for (const projectId of ['p', 'other', 'third']) {
    const project: Project = { id: projectId, name: projectId, description: '', workspace: 'not-used', leadId: 'lead', stack: '', testCommand: ['node', '--test'], dockerImage: 'test-only', createdAt: timestamp };
    store.put('projects', project);
  }
  const employees: Employee[] = [
    { id: 'lead', name: 'lead', role: 'lead', duties: 'plan', reportsTo: null, projectIds: ['p', 'other'], enabled: true, createdAt: timestamp },
    { id: 'dev', name: 'dev', role: 'developer', duties: 'develop', reportsTo: 'lead', projectIds: ['p', 'other'], enabled: true, createdAt: timestamp },
    { id: 'qa', name: 'qa', role: 'qa', duties: 'test', reportsTo: 'lead', projectIds: ['p'], enabled: true, createdAt: timestamp },
  ];
  for (const employee of employees) store.put('employees', employee);
  const service = new Skills(store);
  return { store, service, dev: employees[1], qa: employees[2], close: () => store.close() };
}
function create(service: Skills, title = '验证输入边界', projectIds = ['p']) {
  return service.createManual(human, { content: sample(title), roles: ['developer'], projectIds });
}
function approve(service: Skills, draft: SkillDraft) {
  return service.publish(human, draft.id, { expectedRevision: draft.revision, expectedHash: draft.contentHash, note: '已核查，作为受限知识参考' });
}
function edit(service: Skills, draft: SkillDraft, title = '修订输入边界') {
  return service.updateDraft(human, draft.id, { expectedRevision: draft.revision, expectedHash: draft.contentHash, content: sample(title), roles: draft.roles, projectIds: draft.projectIds });
}
function status(expected: number) { return (error: unknown) => error instanceof AppError && error.status === expected; }
function batch(store: Store, mode: RunMode = 'simulation', batchId = 'batch1') {
  const task: Task = { id: `task-${batchId}`, title: '阶段任务', goal: '验证', projectId: 'p', leaderId: 'lead', developerId: 'dev', qaId: 'qa', status: 'awaiting_merge', mode, version: 4, contentHash: 'code-hash', plan: '', blockedReason: null, createdAt: timestamp, updatedAt: timestamp, batchId };
  store.put('tasks', task);
  const runs: AgentRun[] = (['planning', 'development', 'qa'] as const).map((stage, index) => ({ id: `${batchId}-run${index}`, taskId: task.id, employeeId: ['lead', 'dev', 'qa'][index], stage, mode, status: 'succeeded', sessionId: 'never-copy-session', startedAt: timestamp, endedAt: timestamp, exitCode: 0, output: 'never-copy-output', error: null, batchId, taskVersion: 4, projectId: 'p', applicationStatus: index === 0 ? 'not_applicable' : 'applied', learningCaptureStatus: 'pending' }));
  for (const run of runs) store.put('runs', run);
  const finalTest: TestRun = { id: `${batchId}-test`, taskId: task.id, reviewerId: 'qa', mode, status: 'passed', exitCode: 0, image: mode === 'simulation' ? 'simulation' : 'node:test', imageDigest: mode === 'simulation' ? null : 'sha256:image', command: ['node', '--test'], log: 'never-copy-log', contentHash: 'code-hash', createdAt: timestamp, durationMs: 1, taskVersion: 4, batchId, agentRunId: runs[2].id };
  store.put('tests', finalTest);
  return { task, runs, finalTest };
}

test('pure validation: strict fields, bounded bytes/counts and no proposal provenance', () => {
  assert.deepEqual(validateSkillContent(sample()), sample());
  assert.deepEqual(validateLearningProposals(undefined), []);
  assert.deepEqual(validateLearningProposals([sample()]), [sample()]);
  for (const invalid of [null, {}, [], { ...sample(), source: {} }, { ...sample(), title: '' }, { ...sample(), title: '中'.repeat(100) }, { ...sample(), steps: [] }, { ...sample(), steps: Array(13).fill('step') }, { ...sample(), cautions: Array(11).fill('warning') }, { ...sample(), tags: Array(9).fill('tag') }, { ...sample(), tags: ['same', 'same'] }, { ...sample(), steps: Array(12).fill('x'.repeat(1100)) }]) assert.throws(() => validateSkillContent(invalid));
  assert.throws(() => validateLearningProposals(null));
  assert.throws(() => validateLearningProposals(Array(4).fill(sample())));
  assert.throws(() => validateLearningProposals([{ ...sample(), mode: 'zcode' }]));
  let invoked = false;
  const accessor = { ...sample() };
  Object.defineProperty(accessor, 'title', { get() { invoked = true; return 'hidden'; } });
  assert.throws(() => validateSkillContent(accessor));
  assert.equal(invoked, false);
});

test('manual saves and reviews are human-only and reject fake users, provenance injection and secrets', () => {
  const f = fixture();
  try {
    const payload = { content: sample(), roles: ['developer'], projectIds: ['p'] };
    for (const actor of [{ type: 'agent', id: 'dev' }, { type: 'user', id: 'fake' }] as Actor[]) assert.throws(() => f.service.createManual(actor, payload), status(403));
    for (const key of ['source', 'id', 'status', 'usePolicy', 'baseVersionId']) assert.throws(() => f.service.createManual(human, { ...payload, [key]: 'forged' }), status(400));
    for (const secret of ['password=super-secret-value', 'token: secretvaluehere', 'OPENAI_API_KEY=privatevalue', 'access_token=privatevalue', 'client_secret: privatevalue', 'password=x', 'Authorization: Bearer abcdef1234567890', '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----', 'sk-proj-abcdefghijklmnopqrstuvwxyz', 'https://name:secretvalue@example.invalid/path']) assert.throws(() => f.service.createManual(human, { ...payload, content: { ...sample(), purpose: secret } }), status(400));
    assert.equal(f.store.all('skillDrafts').length, 0);
    assert.equal(f.store.all('audit').length, 0);
    const draft = create(f.service);
    assert.equal(draft.usePolicy, 'manual_unverified');
    for (const actor of [{ type: 'agent', id: 'dev' }, { type: 'user', id: 'fake' }] as Actor[]) {
      assert.throws(() => f.service.publish(actor, draft.id, { expectedRevision: 1, expectedHash: draft.contentHash, note: 'review' }), status(403));
      assert.throws(() => f.service.reject(actor, draft.id, { expectedRevision: 1, expectedHash: draft.contentHash, note: 'review' }), status(403));
    }
    assert.throws(() => f.service.publish(human, draft.id, { expectedRevision: 1, expectedHash: draft.contentHash, note: 'api_key=privatevalue' }), status(400));
    assert.equal(f.store.all('skillVersions').length, 0);
    assert.equal(f.store.all('skillReviews').length, 0);
  } finally { f.close(); }
});

test('draft rejection, editing, immutable publication and explicit version pins form a lifecycle', () => {
  const f = fixture();
  try {
    const first = create(f.service);
    const rejected = f.service.reject(human, first.id, { expectedRevision: 1, expectedHash: first.contentHash, note: '补充步骤' });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.contentHash, first.contentHash);
    assert.throws(() => approve(f.service, rejected), status(409));
    const edited = edit(f.service, rejected);
    assert.equal(edited.status, 'draft');
    assert.equal(edited.revision, 2);
    assert.notEqual(edited.contentHash, rejected.contentHash);
    assert.deepEqual(edited.source, rejected.source);
    assert.throws(() => approve(f.service, first), status(409));
    const version = approve(f.service, edited);
    assert.equal(version.version, 1);
    assert.equal(version.publishedBy, human.id);
    assert.ok(version.publishedAt);
    assert.equal(f.store.all('skillReviews').length, 2);
    assert.equal(f.store.all('skillAssignments').length, 0);
    assert.throws(() => approve(f.service, edited), status(409));
    assert.throws(() => edit(f.service, edited), status(409));
    assert.equal(f.service.resolve(f.dev, 'p', 'zcode', 'development').reference, '');
    f.service.assign(human, f.dev.id, { assignments: [{ versionId: version.id, projectIds: ['p'] }] });
    const revised = f.service.reviseVersion(human, version.id);
    assert.equal(revised.baseVersionId, version.id);
    assert.deepEqual(revised.source, version.source);
    assert.equal(revised.usePolicy, version.usePolicy);
    const v2 = approve(f.service, edit(f.service, revised, '新版本边界核查'));
    assert.equal(v2.version, 2);
    assert.equal(f.store.all('skillVersions').length, 2);
    assert.deepEqual(f.store.get('skillVersions', version.id), version);
    assert.equal(f.service.resolve(f.dev, 'p', 'zcode', 'development').skills[0].versionId, version.id);
    assert.equal(f.service.detail('version', v2.id).baseVersion?.id, version.id);
    assert.equal(f.service.detail('draft', edited.id).reviews.length, 2);
    for (const collection of ['skillVersions', 'skillReviews'] as const) {
      const record = f.store.all(collection)[0];
      assert.throws(() => f.store.put(collection, record));
      assert.throws(() => f.store.remove(collection, record.id));
      assert.throws(() => f.store.sql.prepare('UPDATE records SET body=body WHERE collection=? AND id=?').run(collection, record.id));
      assert.throws(() => f.store.sql.prepare('DELETE FROM records WHERE collection=? AND id=?').run(collection, record.id));
    }
  } finally { f.close(); }
});

test('optimistic revisions and concurrent base versions fail without writes', () => {
  const f = fixture();
  try {
    const draft = create(f.service);
    assert.throws(() => f.service.publish(human, draft.id, { expectedRevision: 2, expectedHash: draft.contentHash, note: '审核' }), status(409));
    assert.throws(() => f.service.reject(human, draft.id, { expectedRevision: 1, expectedHash: 'stale', note: '审核' }), status(409));
    const original = approve(f.service, draft);
    const one = f.service.reviseVersion(human, original.id);
    const two = f.service.reviseVersion(human, original.id);
    approve(f.service, one);
    const auditCount = f.store.all('audit').length;
    assert.throws(() => approve(f.service, two), status(409));
    assert.throws(() => f.service.reviseVersion(human, original.id), status(409));
    assert.equal(f.store.all('skillVersions').length, 2);
    assert.equal(f.store.all('audit').length, auditCount);
    assert.equal(f.store.get('skillDrafts', two.id)?.status, 'draft');
  } finally { f.close(); }
});

test('publication and assignment replacements rollback atomically on storage failure', () => {
  const f = fixture();
  try {
    const draft = create(f.service);
    f.store.sql.exec("CREATE TRIGGER fail_review BEFORE INSERT ON records WHEN NEW.collection='skillReviews' BEGIN SELECT RAISE(ABORT,'test rollback'); END;");
    const audits = f.store.all('audit').length;
    assert.throws(() => approve(f.service, draft));
    assert.equal(f.store.all('skillVersions').length, 0);
    assert.equal(f.store.all('skillAvailability').length, 0);
    assert.equal(f.store.all('skillReviews').length, 0);
    assert.equal(f.store.all('audit').length, audits);
    assert.equal(f.store.get('skillDrafts', draft.id)?.status, 'draft');
    f.store.sql.exec('DROP TRIGGER fail_review;');
    const v1 = approve(f.service, draft);
    const v2 = approve(f.service, create(f.service, '另一个技能'));
    const old = f.service.assign(human, f.dev.id, { assignments: [{ versionId: v1.id, projectIds: ['p'] }] });
    f.store.sql.exec("CREATE TRIGGER fail_assign BEFORE INSERT ON records WHEN NEW.collection='skillAssignments' BEGIN SELECT RAISE(ABORT,'test rollback'); END;");
    assert.throws(() => f.service.assign(human, f.dev.id, { assignments: [{ versionId: v2.id, projectIds: ['p'] }] }));
    assert.deepEqual(f.store.all('skillAssignments'), old);
  } finally { f.close(); }
});

test('assignment scopes, disabled versions, role changes, mode and busy workers cannot leak references', () => {
  const f = fixture();
  try {
    for (const bad of [{ roles: [], projectIds: ['p'] }, { roles: ['developer'], projectIds: [] }, { roles: ['fake'], projectIds: ['p'] }, { roles: ['developer'], projectIds: ['missing'] }]) assert.throws(() => f.service.createManual(human, { content: sample(), ...bad }), status(400));
    const v1 = approve(f.service, create(f.service));
    const v2 = approve(f.service, f.service.reviseVersion(human, v1.id));
    for (const assignments of [[{ versionId: v1.id, projectIds: [] }], [{ versionId: v1.id, projectIds: ['other'] }], [{ versionId: v1.id, projectIds: ['missing'] }], [{ versionId: v1.id, projectIds: ['p'] }, { versionId: v2.id, projectIds: ['p'] }]]) assert.throws(() => f.service.assign(human, f.dev.id, { assignments }), status(400));
    assert.throws(() => f.service.assign(human, f.qa.id, { assignments: [{ versionId: v1.id, projectIds: ['p'] }] }), status(400));
    f.service.assign(human, f.dev.id, { assignments: [{ versionId: v1.id, projectIds: ['p'] }] });
    const resolved = f.service.resolve(f.dev, 'p', 'zcode', 'development');
    assert.equal(resolved.skills.length, 1);
    assert.match(resolved.reference, /knowledge_only/);
    assert.match(resolved.reference, /"grantsPermissions":false/);
    assert.equal(f.service.resolve(f.dev, 'other', 'zcode', 'development').skills.length, 0);
    assert.equal(f.service.resolve(f.dev, 'p', 'zcode', 'qa').skills.length, 0);
    assert.equal(f.service.resolve({ ...f.dev, role: 'qa' }, 'p', 'zcode', 'development').skills.length, 0);
    f.service.setAvailability(human, v1.id, false);
    assert.deepEqual(f.store.get('skillVersions', v1.id), v1);
    assert.equal(f.service.resolve(f.dev, 'p', 'zcode', 'development').skills.length, 0);
    assert.throws(() => f.service.assign(human, f.dev.id, { assignments: [{ versionId: v1.id, projectIds: ['p'] }] }), status(409));
    f.service.setAvailability(human, v1.id, true);
    assert.equal(f.service.resolve(f.dev, 'p', 'zcode', 'development').fingerprint, resolved.fingerprint);
    f.store.put('employees', { ...f.dev, projectIds: ['other'] });
    assert.equal(f.service.resolve(f.dev, 'p', 'zcode', 'development').skills.length, 0);
    f.store.put('employees', f.dev);
    const b = batch(f.store);
    f.store.put('tasks', { ...b.task, status: 'developing' });
    assert.throws(() => f.service.assign(human, f.dev.id, { assignments: [] }), status(409));
    assert.equal(f.store.all('skillAssignments').length, 1);
  } finally { f.close(); }
});

test('disabled employees may revoke all pins but cannot receive nonempty assignments', () => {
  const f = fixture();
  try {
    const version = approve(f.service, create(f.service));
    f.service.assign(human, f.dev.id, { assignments: [{ versionId: version.id, projectIds: ['p'] }] });
    f.store.put('employees', { ...f.dev, enabled: false });
    assert.equal(f.service.resolve(f.dev, 'p', 'zcode', 'development').skills.length, 0);
    assert.throws(() => f.service.assign(human, f.dev.id, { assignments: [{ versionId: version.id, projectIds: ['p'] }] }), status(400));
    assert.equal(f.store.all('skillAssignments').length, 1);
    assert.deepEqual(f.service.assign(human, f.dev.id, { assignments: [] }), []);
    assert.equal(f.store.all('skillAssignments').length, 0);
  } finally { f.close(); }
});

test('captures only exact batch provenance, once per stage, without implicit publication or use', () => {
  const f = fixture();
  try {
    const b = batch(f.store);
    f.store.put('tests', { ...b.finalTest, id: 'wrong-version', taskVersion: 99, status: 'failed' });
    f.store.put('tests', { ...b.finalTest, id: 'wrong-batch', batchId: 'unrelated', status: 'failed' });
    f.store.put('tests', { ...b.finalTest, id: 'wrong-mode', mode: 'zcode', status: 'failed' });
    f.store.put('tests', { ...b.finalTest, id: 'wrong-agent', agentRunId: b.runs[1].id, status: 'failed' });
    f.store.put('runs', { ...b.runs[0], id: 'legacy-run', batchId: undefined, taskVersion: undefined, projectId: undefined });
    const drafts = f.service.captureBatch('batch1');
    assert.equal(drafts.length, 3);
    assert.equal(f.store.all('skillDrafts').length, 3);
    assert.equal(f.store.all('skillVersions').length, 0);
    assert.equal(f.store.all('skillAssignments').length, 0);
    assert.equal(f.service.resolve(f.dev, 'p', 'simulation', 'development').skills.length, 0);
    for (const draft of drafts) {
      assert.equal(draft.source.taskVersion, 4);
      assert.equal(draft.source.projectId, 'p');
      assert.equal(draft.source.batchId, 'batch1');
      assert.equal(draft.source.mode, 'simulation');
      assert.equal(draft.source.outcome, 'passed');
      assert.deepEqual(draft.source.testIds, [b.finalTest.id]);
      assert.equal(draft.usePolicy, 'simulation_only');
      assert.match(draft.source.evidenceHash, /^[a-f0-9]{64}$/);
      assert.match(draft.content.purpose, /不是 AI 已学会/);
      assert.doesNotMatch(JSON.stringify(draft), /never-copy/);
    }
    assert.deepEqual(new Set(f.service.captureBatch('batch1').map(d => d.id)), new Set(drafts.map(d => d.id)));
    assert.equal(f.store.all('audit').length, 3);
    assert.equal(f.store.get('runs', b.runs[1].id)?.learningCaptureStatus, 'saved');
    assert.equal(f.store.get('runs', 'legacy-run')?.learningCaptureStatus, 'pending');
  } finally { f.close(); }
});

test('simulated sources and use policies survive edits, publication and revision without laundering', () => {
  const f = fixture();
  try {
    batch(f.store);
    const draft = f.service.captureBatch('batch1').find(draft => draft.source.employeeId === 'dev')!;
    const payload = { expectedRevision: draft.revision, expectedHash: draft.contentHash, content: sample('声称是真实经验'), roles: ['developer'], projectIds: ['p'] };
    assert.throws(() => f.service.updateDraft(human, draft.id, { ...payload, source: { kind: 'manual' } }), status(400));
    assert.throws(() => f.service.updateDraft(human, draft.id, { ...payload, usePolicy: 'manual_unverified' }), status(400));
    const edited = f.service.updateDraft(human, draft.id, payload);
    const version = approve(f.service, edited);
    assert.deepEqual(version.source, draft.source);
    assert.equal(version.usePolicy, 'simulation_only');
    f.service.assign(human, 'dev', { assignments: [{ versionId: version.id, projectIds: ['p'] }] });
    assert.equal(f.service.resolve(f.dev, 'p', 'zcode', 'development').skills.length, 0);
    assert.equal(f.service.resolve(f.dev, 'p', 'simulation', 'development').skills.length, 1);
    const revision = f.service.reviseVersion(human, version.id);
    assert.deepEqual(revision.source, draft.source);
    assert.equal(revision.usePolicy, 'simulation_only');
    assert.equal(approve(f.service, edit(f.service, revision)).usePolicy, 'simulation_only');
    assert.equal(f.service.captureBatch('batch1').length, 3);
  } finally { f.close(); }
});

test('evidence survives log truncation and capture metadata changes but rejects source evidence mutation', () => {
  const f = fixture();
  try {
    const b = batch(f.store, 'zcode');
    const drafts = f.service.captureBatch('batch1');
    const draft = drafts.find(draft => draft.source.employeeId === 'dev')!;
    const original = f.store.get('runs', b.runs[1].id)!;
    f.store.put('runs', { ...original, output: 'changed/truncated', error: 'redacted', outputTruncated: true, learningCaptureStatus: 'failed' });
    f.store.put('tests', { ...b.finalTest, log: 'truncated' });
    assert.equal(f.service.captureBatch('batch1').find(d => d.id === draft.id)?.source.evidenceHash, draft.source.evidenceHash);
    const version = approve(f.service, draft);
    assert.equal(version.usePolicy, 'task_observation');
    assert.doesNotMatch(JSON.stringify(f.service.detail('version', version.id)), /changed\/truncated|redacted|never-copy/);
    const qaDraft = drafts.find(draft => draft.source.employeeId === 'qa')!;
    f.store.put('tests', { ...b.finalTest, contentHash: 'mutated-code' });
    assert.throws(() => approve(f.service, qaDraft), status(409));
    assert.equal(f.store.all('skillVersions').length, 1);
    assert.match(f.service.detail('draft', qaDraft.id).warnings.join(' '), /完整性/);
    f.store.put('tests', b.finalTest);
    f.store.put('runs', { ...b.runs[2], mode: 'simulation' });
    assert.throws(() => approve(f.service, qaDraft), status(409));
  } finally { f.close(); }
});

test('historical versions never borrow current task status or tests and failed/interrupted records stay observations', () => {
  const f = fixture();
  try {
    const b = batch(f.store, 'zcode');
    f.store.remove('tests', b.finalTest.id);
    f.store.put('tasks', { ...b.task, version: 5, batchId: 'new-batch', status: 'awaiting_merge' });
    f.store.put('tests', { ...b.finalTest, taskVersion: 5, batchId: 'new-batch' });
    const old = f.service.captureBatch('batch1');
    assert.equal(old.length, 3);
    assert.ok(old.every(draft => draft.source.taskVersion === 4 && draft.source.outcome === 'unknown' && draft.source.testIds.length === 0));
    assert.ok(old.every(draft => draft.source.limitations.some(text => text.includes('当前任务'))));
    const c = batch(f.store, 'zcode', 'interrupted');
    f.store.remove('tests', c.finalTest.id);
    f.store.put('tasks', { ...c.task, status: 'blocked', blockedReason: '服务重启，执行中断' });
    for (const run of c.runs) f.store.put('runs', { ...run, status: 'failed', applicationStatus: 'unknown', error: 'token=must-not-copy' });
    const interrupted = f.service.captureBatch('interrupted');
    assert.ok(interrupted.every(draft => draft.source.outcome === 'interrupted'));
    assert.doesNotMatch(JSON.stringify(interrupted), /must-not-copy/);
    const d = batch(f.store, 'zcode', 'failed');
    f.store.put('tasks', { ...d.task, status: 'changes_requested' });
    f.store.put('tests', { ...d.finalTest, status: 'failed', exitCode: 1 });
    assert.ok(f.service.captureBatch('failed').every(draft => draft.source.outcome === 'failed'));
    const e = batch(f.store, 'simulation', 'cancelled');
    f.store.put('tasks', { ...e.task, status: 'cancelled' });
    assert.ok(f.service.captureBatch('cancelled').every(draft => draft.source.outcome === 'cancelled'));
  } finally { f.close(); }
});

test('real passed observations require Docker digest and succeeded/applied linked QA evidence', () => {
  for (const missing of ['digest', 'qaStatus', 'qaApplication'] as const) {
    const f = fixture();
    try {
      const b = batch(f.store, 'zcode');
      if (missing === 'digest') f.store.put('tests', { ...b.finalTest, imageDigest: null });
      if (missing === 'qaStatus') f.store.put('runs', { ...b.runs[2], status: 'failed' });
      if (missing === 'qaApplication') f.store.put('runs', { ...b.runs[2], applicationStatus: 'unknown' });
      const drafts = f.service.captureBatch('batch1');
      assert.ok(drafts.every(draft => draft.source.outcome !== 'passed'));
      assert.equal(drafts.find(draft => draft.source.employeeId === 'dev')?.source.outcome, 'unknown');
      assert.ok(drafts.every(draft => draft.usePolicy === 'task_observation'));
    } finally { f.close(); }
  }
});

test('bounded proposals are sanitized automatically; capture failures never mark saved prematurely', () => {
  const f = fixture();
  try {
    const b = batch(f.store);
    const secret = { ...sample(), purpose: 'password=must-not-appear' };
    f.store.put('runs', { ...b.runs[1], learningProposals: [sample('one'), secret, sample('three')] });
    f.store.sql.exec("CREATE TRIGGER fail_capture BEFORE INSERT ON records WHEN NEW.collection='skillDrafts' BEGIN SELECT RAISE(ABORT,'test rollback'); END;");
    assert.throws(() => f.service.captureBatch('batch1'));
    assert.equal(f.store.all('skillDrafts').length, 0);
    assert.equal(f.store.all('audit').length, 0);
    assert.equal(f.store.get('runs', b.runs[0].id)?.learningCaptureStatus, 'pending');
    f.store.sql.exec('DROP TRIGGER fail_capture;');
    const captured = f.service.captureBatch('batch1');
    assert.equal(captured.length, 5);
    assert.equal(captured.filter(draft => draft.source.employeeId === 'dev').length, 3);
    assert.doesNotMatch(JSON.stringify(captured), /must-not-appear/);
    assert.doesNotMatch(JSON.stringify(f.store.all('audit')), /must-not-appear/);
    assert.ok(captured.some(draft => draft.content.cautions.some(caution => caution.includes('替换'))));
    assert.equal(f.service.captureBatch('batch1').length, 5);
  } finally { f.close(); }
});

test('more than eight compact skills can be assigned and resolved without truncation', () => {
  const f = fixture();
  try {
    const versions = Array.from({ length: 12 }, (_, index) => approve(f.service, create(f.service, `compact-${index}`)));
    const assigned = f.service.assign(human, 'dev', { assignments: versions.map(version => ({ versionId: version.id, projectIds: ['p'] })) });
    assert.equal(assigned.length, 12);
    assert.equal(f.store.all('skillAssignments').length, 12);
    for (const mode of ['simulation', 'zcode'] as const) {
      const resolved = f.service.resolve(f.dev, 'p', mode, 'development');
      assert.equal(resolved.skills.length, 12);
      assert.deepEqual(resolved.skills.map(item => item.versionId).sort(), versions.map(item => item.id).sort());
      assert.ok(Buffer.byteLength(resolved.reference) <= 24 * 1024);
    }
  } finally { f.close(); }
});

test('resolve retains the 24 KiB content budget and deterministic contextual fingerprints without a count cap', () => {
  const f = fixture();
  try {
    const versions: SkillVersion[] = [];
    for (let index = 0; index < 9; index++) {
      const draft = f.service.createManual(human, { content: { ...sample(`big-${index}`), steps: Array(10).fill('x'.repeat(1000)) }, roles: ['developer'], projectIds: ['p'] });
      versions.push(approve(f.service, draft));
    }
    const assigned = f.service.assign(human, 'dev', { assignments: versions.map(version => ({ versionId: version.id, projectIds: ['p'] })) });
    assert.equal(assigned.length, 9, 'storage has no skill-count cap even when a single prompt would be too large');
    assert.throws(() => f.service.resolve(f.dev, 'p', 'zcode', 'development'), (error: unknown) => error instanceof AppError && error.status === 409 && error.message.includes('24 KiB'));
    assert.equal(f.store.all('skillAssignments').length, 9, 'prompt overflow must not discard saved skills');
    f.service.assign(human, 'dev', { assignments: versions.slice(0, 2).map(version => ({ versionId: version.id, projectIds: ['p'] })) });
    const first = f.service.resolve(f.dev, 'p', 'zcode', 'development');
    assert.equal(first.skills.length, 2);
    assert.ok(Buffer.byteLength(first.reference) <= 24 * 1024);
    assert.equal(f.service.resolve(f.dev, 'p', 'zcode', 'development').fingerprint, first.fingerprint);
    assert.notEqual(f.service.resolve(f.dev, 'p', 'simulation', 'development').fingerprint, first.fingerprint);
    assert.notEqual(f.service.resolve(f.dev, 'other', 'zcode', 'development').fingerprint, first.fingerprint);
    assert.notEqual(f.service.resolve(f.dev, 'p', 'zcode', 'qa').fingerprint, first.fingerprint);
    f.service.setAvailability(human, first.skills[0].versionId, false);
    assert.notEqual(f.service.resolve(f.dev, 'p', 'zcode', 'development').fingerprint, first.fingerprint);
    assert.equal(f.store.all('skillAssignments').length, 2);
    f.service.assign(human, 'dev', { assignments: [] });
    assert.equal(f.service.resolve(f.dev, 'p', 'zcode', 'development').reference, '');
  } finally { f.close(); }
});
