import type { Employee, Role, Task, TaskStatus, TestRun } from '../shared/types.js';

export class AppError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = 'AppError'; }
}
export interface Actor { type: 'user' | 'agent'; id: string; }
export const roles: Role[] = ['director', 'lead', 'developer', 'qa', 'ops'];
const transitions: Record<TaskStatus, TaskStatus[]> = {
  draft: ['planning', 'blocked', 'cancelled'], planning: ['assigned', 'blocked', 'cancelled'],
  assigned: ['developing', 'blocked', 'cancelled'], developing: ['awaiting_test', 'blocked', 'cancelled'],
  awaiting_test: ['testing', 'blocked', 'cancelled'], testing: ['changes_requested', 'awaiting_merge', 'blocked', 'cancelled'],
  changes_requested: ['draft', 'cancelled'], awaiting_merge: ['awaiting_release', 'changes_requested', 'draft', 'blocked', 'cancelled'],
  awaiting_release: ['release_authorized', 'changes_requested', 'draft', 'blocked', 'cancelled'],
  release_authorized: ['monitoring', 'draft', 'cancelled'], monitoring: ['closed', 'blocked'],
  closed: [], blocked: ['draft', 'cancelled'], cancelled: ['draft'],
};
export function requireHuman(actor: Actor) {
  if (actor.type !== 'user' || !actor.id) throw new AppError('只有已登录的本人可以批准此操作', 403);
}
export function assertTransition(from: TaskStatus, to: TaskStatus) {
  if (!transitions[from]?.includes(to)) throw new AppError(`不允许从 ${from} 转换到 ${to}`, 409);
}
export function validateHierarchy(employeeId: string, reportsTo: string | null, employees: Employee[]) {
  let next = reportsTo;
  const seen = new Set([employeeId]);
  while (next) {
    if (seen.has(next)) throw new AppError('直属领导关系不能形成循环');
    seen.add(next);
    const employee = employees.find(item => item.id === next);
    if (!employee) throw new AppError('直属领导不存在');
    if (!['director', 'lead'].includes(employee.role)) throw new AppError('直属领导必须是技术负责人或项目负责人');
    next = employee.reportsTo;
  }
}
export function validateTeam(task: Pick<Task, 'leaderId' | 'developerId' | 'qaId' | 'projectId'>, employees: Employee[]) {
  if (task.developerId === task.qaId) throw new AppError('开发与验收必须由不同员工承担');
  const check = (employeeId: string, allowedRoles: Role[]) => {
    const employee = employees.find(item => item.id === employeeId);
    if (!employee || !employee.enabled || !allowedRoles.includes(employee.role)) throw new AppError('负责人不存在、已停用或岗位不匹配');
    if (!employee.projectIds.includes(task.projectId)) throw new AppError(`${employee.name} 未被授权负责该项目`);
  };
  check(task.leaderId, ['director', 'lead']); check(task.developerId, ['developer']); check(task.qaId, ['qa']);
}
export function validateApproval(actor: Actor, task: Task, kind: 'merge' | 'release', version: number, hash: string, currentHash: string, tests: TestRun[]) {
  requireHuman(actor);
  const expected = kind === 'merge' ? 'awaiting_merge' : 'awaiting_release';
  if (task.status !== expected) throw new AppError('任务尚未到达该审批阶段', 409);
  if (task.mode !== 'zcode') throw new AppError('模拟演练不能作为真实合并或发布的批准依据', 409);
  if (task.version !== version || !task.contentHash || task.contentHash !== hash || hash !== currentHash) throw new AppError('代码或任务版本已变化，必须重新测试后申请批准', 409);
  const latest = tests.filter(test => test.taskId === task.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!latest || latest.mode !== 'zcode' || latest.status !== 'passed' || latest.exitCode !== 0 || latest.contentHash !== hash || latest.reviewerId !== task.qaId || latest.reviewerId === task.developerId || !latest.imageDigest) throw new AppError('缺少与当前代码一致的独立 Docker 测试证据', 409);
}
export function text(value: unknown, name: string, max = 2000, min = 1): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) throw new AppError(`${name}长度应为 ${min}–${max} 个字符`);
  return value.trim();
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('请求必须是 JSON 对象');
  return value as Record<string, unknown>;
}
export const busyStatuses: TaskStatus[] = ['planning', 'assigned', 'developing', 'awaiting_test', 'testing'];
