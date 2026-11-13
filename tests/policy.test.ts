import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTransition, validateApproval, validateHierarchy, validateTeam } from '../src/server/policy.js';
import { Store } from '../src/server/db.js';
import type { Employee, Task, TestRun } from '../src/shared/types.js';

const employees: Employee[] = [
  { id: 'leader', name: '领导', role: 'lead', duties: '规划', reportsTo: null, projectIds: ['p'], enabled: true, createdAt: '' },
  { id: 'dev', name: '开发', role: 'developer', duties: '开发', reportsTo: 'leader', projectIds: ['p'], enabled: true, createdAt: '' },
  { id: 'qa', name: '测试', role: 'qa', duties: '测试', reportsTo: 'leader', projectIds: ['p'], enabled: true, createdAt: '' },
];
const task: Task = { id: 't', title: '任务', goal: '测试', projectId: 'p', leaderId: 'leader', developerId: 'dev', qaId: 'qa', status: 'awaiting_merge', mode: 'zcode', version: 1, contentHash: 'hash', plan: '', blockedReason: null, createdAt: '', updatedAt: '' };
const testRun: TestRun = { id: 'test', taskId: 't', reviewerId: 'qa', mode: 'zcode', status: 'passed', exitCode: 0, image: 'node', imageDigest: 'sha256:test', command: ['node', '--test'], log: '真实退出码', contentHash: 'hash', createdAt: '2026-11-12T00:00:00Z', durationMs: 1 };

test('任务状态不能跳过独立测试与批准', () => {
  assert.doesNotThrow(() => assertTransition('developing', 'awaiting_test'));
  assert.throws(() => assertTransition('developing', 'awaiting_merge'));
  assert.throws(() => assertTransition('draft', 'release_authorized'));
});
test('开发不能自验收，跨项目或停用员工不能领任务', () => {
  assert.doesNotThrow(() => validateTeam(task, employees));
  assert.throws(() => validateTeam({ ...task, qaId: 'dev' }, employees));
  assert.throws(() => validateTeam({ ...task, projectId: 'another' }, employees));
  assert.throws(() => validateTeam(task, employees.map(item => item.id === 'qa' ? { ...item, enabled: false } : item)));
});
test('领导关系不能成环或指向普通开发者', () => {
  assert.throws(() => validateHierarchy('leader', 'leader', employees));
  assert.throws(() => validateHierarchy('leader', 'dev', employees));
  assert.doesNotThrow(() => validateHierarchy('qa', 'leader', employees));
});
test('只有人类可批准当前哈希且有真实独立测试证据的任务', () => {
  assert.doesNotThrow(() => validateApproval({ type: 'user', id: 'u' }, task, 'merge', 1, 'hash', 'hash', [testRun]));
  assert.throws(() => validateApproval({ type: 'agent', id: 'leader' }, task, 'merge', 1, 'hash', 'hash', [testRun]));
  assert.throws(() => validateApproval({ type: 'user', id: 'u' }, { ...task, mode: 'simulation' }, 'merge', 1, 'hash', 'hash', [testRun]));
  assert.throws(() => validateApproval({ type: 'user', id: 'u' }, task, 'merge', 1, 'hash', 'changed', [testRun]));
  assert.throws(() => validateApproval({ type: 'user', id: 'u' }, task, 'merge', 2, 'hash', 'hash', [testRun]));
  assert.throws(() => validateApproval({ type: 'user', id: 'u' }, task, 'merge', 1, 'hash', 'hash', [{ ...testRun, exitCode: 1 }]));
  assert.throws(() => validateApproval({ type: 'user', id: 'u' }, task, 'merge', 1, 'hash', 'hash', [{ ...testRun, imageDigest: null }]));
});
test('SQLite 短事务失败时回滚审计与记录', () => {
  const store = new Store(':memory:');
  try {
    assert.throws(() => store.transaction(() => { store.put('tasks', task); store.audit('u', 'test', task.id, 'rollback'); throw new Error('fail'); }));
    assert.equal(store.get('tasks', task.id), null);
    assert.equal(store.all('audit').length, 0);
  } finally { store.close(); }
});
