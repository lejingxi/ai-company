import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store, id, now } from './db.js';
import { Auth } from './auth.js';
import { AppError, busyStatuses, object, roles, text, validateHierarchy, validateTeam } from './policy.js';
import { Workflow } from './workflow.js';
import { Monitoring, validateMonitorUrl } from './monitoring.js';
import { root, type AppConfig } from './config.js';
import type { Dashboard, Employee, Project, Role, Task } from '../shared/types.js';

const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new AppError('只接受 application/json 请求', 415);
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 64 * 1024) throw new AppError('请求内容超过 64 KiB', 413);
    chunks.push(Buffer.from(chunk));
  }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError('JSON 格式不正确'); }
}
function assertFields(value: Record<string, unknown>, allowed: string[]) {
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra) throw new AppError(`不允许的字段：${extra}`);
}
function optionalId(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return text(value, 'ID', 100);
}
// Only these three UUID-scoped artifacts belong to a newly created project.
// Shared parents and pre-existing paths must never be removed on rollback.
function prepareProjectCleanup(workspaceRoot: string, projectId: string): () => void {
  const base = path.resolve(workspaceRoot);
  const artifacts = [
    path.join(base, 'projects', projectId),
    path.join(base, 'baselines', '_projects', projectId),
    path.join(base, 'baselines', '_seals', `projects-${projectId}.sha256`),
  ];
  const assertSafeParents = (target: string) => {
    const relative = path.relative(base, target);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new AppError('项目清理路径越界', 500);
    let directory = path.dirname(target);
    for (;;) {
      const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
      if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new AppError('项目路径包含不安全的父目录', 409);
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  };
  for (const target of artifacts) {
    assertSafeParents(target);
    if (fs.lstatSync(target, { throwIfNoEntry: false })) throw new AppError('项目工作区已存在，拒绝覆盖', 409);
  }
  return () => {
    for (const target of artifacts) {
      assertSafeParents(target);
      fs.rmSync(target, { recursive: true, force: true });
    }
  };
}
export function seedEmployees(store: Store) {
  if (store.all('employees').length) return;
  const createdAt = now();
  const director = id('employee');
  const lead = id('employee');
  const templates: Employee[] = [
    { id: director, name: '技术总负责人', role: 'director', duties: '接收目标，确定优先级、协调项目，汇报阻塞；不得批准合并或发布。', reportsTo: null, projectIds: [], enabled: true, createdAt },
    { id: lead, name: '项目架构师', role: 'lead', duties: '拆解需求、明确接口与验收标准，向开发派工；不能把计划等同验收。', reportsTo: director, projectIds: [], enabled: true, createdAt },
    { id: id('employee'), name: '研发工程师', role: 'developer', duties: '只实现本项目任务，提交可审查的代码变更；不修改测试门禁、不自行验收。', reportsTo: lead, projectIds: [], enabled: true, createdAt },
    { id: id('employee'), name: '独立测试工程师', role: 'qa', duties: '依据需求独立设计测试；保留失败证据，不修改产品源码来通过验收。', reportsTo: lead, projectIds: [], enabled: true, createdAt },
    { id: id('employee'), name: '运维观察员', role: 'ops', duties: '只读观察允许的指标与日志，报告影响和处理建议；不自动重启、回滚或发布。', reportsTo: lead, projectIds: [], enabled: true, createdAt },
  ];
  store.transaction(() => { for (const employee of templates) store.put('employees', employee); store.audit('system', '创建岗位模板', null, '只创建岗位资料，没有启动 AI 或任务；需分配项目后才可派工'); });
}

export function createApp(config: AppConfig, store = new Store(path.join(config.dataDir, 'company.sqlite'))) {
  const auth = new Auth(store);
  const workflow = new Workflow(store, config);
  const monitoring = new Monitoring(store, config.monitoringEnabled);
  seedEmployees(store);
  monitoring.start();
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const actualPort = (server.address() as AddressInfo | null)?.port ?? config.port;
      const allowedHosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
      if (!allowedHosts.has(req.headers.host ?? '')) throw new AppError('不允许的 Host', 403);
      const requestUrl = new URL(req.url ?? '/', `http://127.0.0.1:${actualPort}`);
      const route = requestUrl.pathname;
      const method = req.method ?? 'GET';
      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
      if (mutating) {
        const origins = new Set([`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`]);
        if (process.env.NODE_ENV !== 'production') { origins.add('http://127.0.0.1:5180'); origins.add('http://localhost:5180'); }
        if (typeof req.headers.origin !== 'string' || !origins.has(req.headers.origin)) throw new AppError('跨站写入请求被拒绝', 403);
      }
      if (route === '/api/health' && method === 'GET') return send(res, 200, { status: 'ok', app: '智研司', version: '0.5.0', realExecutionEnabled: (await workflow.capabilities()).realExecution.ready, releaseExecutionEnabled: false });
      const identity = auth.identify(req);
      if (route === '/api/auth/status' && method === 'GET') return send(res, 200, { setupRequired: auth.setupRequired(), user: identity ? { id: identity.id, username: identity.username } : null, ...(identity ? { csrfToken: identity.csrf } : {}) });
      if (['/api/auth/setup', '/api/auth/login'].includes(route) && method === 'POST') {
        const data = await body(req); assertFields(data, ['username', 'password']);
        const result = route.endsWith('setup') ? await auth.setup(data.username, data.password, req.socket.remoteAddress ?? 'local') : await auth.login(data.username, data.password, req.socket.remoteAddress ?? 'local');
        res.setHeader('Set-Cookie', result.cookie); return send(res, 200, result.body);
      }
      if (route.startsWith('/api/')) {
        if (!identity) throw new AppError('请先登录本地管理员', 401);
        if (mutating) auth.csrf(req, identity);
        const authenticatedBody = async () => {
          const data = await body(req);
          // Reading a streamed body yields: logout/expiry may revoke this session meanwhile.
          auth.revalidate(req, identity);
          return data;
        };
        if (route === '/api/auth/logout' && method === 'POST') { res.setHeader('Set-Cookie', auth.logout(identity)); return send(res, 200, { ok: true }); }
        if (route === '/api/dashboard' && method === 'GET') {
          const dashboard: Dashboard = {
            employees: store.all('employees'), projects: store.all('projects'), tasks: store.all('tasks'),
            runs: store.all('runs').slice(0, 100), tests: store.all('tests').slice(0, 100), approvals: store.all('approvals'),
            incidents: store.all('incidents'), audit: store.all('audit').slice(0, 100), monitors: store.all('monitors'),
            capabilities: await workflow.capabilities(), appVersion: '0.5.0',
            skillDrafts: store.all('skillDrafts'), skillVersions: store.all('skillVersions'),
            skillAssignments: store.all('skillAssignments'), skillReviews: store.all('skillReviews'), skillAvailability: store.all('skillAvailability'),
            employeeModels: store.all('employees').map(employee => workflow.execution.models.readEmployee(employee.id)),
          };
          return send(res, 200, dashboard);
        }
        const employeeModelMatch = route.match(/^\/api\/employees\/([^/]+)\/model$/);
        if (employeeModelMatch && method === 'GET') return send(res, 200, workflow.execution.models.readEmployee(employeeModelMatch[1]));
        if (employeeModelMatch && method === 'PATCH') {
          const data = await authenticatedBody();
          return send(res, 200, workflow.selectEmployeeModel({ type: 'user', id: identity.id }, employeeModelMatch[1], data));
        }
        if (route === '/api/execution/model-api-tests' && method === 'GET') {
          const scope = requestUrl.searchParams.get('scope');
          if (scope !== 'app' && scope !== 'employee') throw new AppError('测试作用域无效');
          const employeeId = scope === 'employee' ? text(requestUrl.searchParams.get('employeeId'), '员工 ID', 100) : null;
          return send(res, 200, workflow.modelApiTests.state(scope, employeeId));
        }
        if (route === '/api/execution/model-api-tests' && method === 'POST') {
          const data = await authenticatedBody();
          return send(res, 202, await workflow.modelApiTests.start({ type: 'user', id: identity.id }, data, () => auth.sessionValid(identity)));
        }
        const apiTestCancel = route.match(/^\/api\/execution\/model-api-tests\/([^/]+)\/cancel$/);
        if (apiTestCancel && method === 'POST') {
          assertFields(await authenticatedBody(), []);
          return send(res, 200, workflow.modelApiTests.cancel({ type: 'user', id: identity.id }, apiTestCancel[1]));
        }
        if (route === '/api/execution/models' && method === 'GET') return send(res, 200, workflow.execution.models.read());
        if (route === '/api/execution/model' && method === 'PATCH') {
          const data = await authenticatedBody();
          return send(res, 200, workflow.selectModel({ type: 'user', id: identity.id }, data));
        }
        if (route === '/api/execution' && method === 'GET') return send(res, 200, workflow.execution.status());
        if (route === '/api/execution/check' && method === 'POST') {
          const data = await authenticatedBody(); assertFields(data, ['target', 'projectId', 'employeeId']);
          if (data.target !== 'zcode' && data.target !== 'docker') throw new AppError('检查目标必须是 zcode 或 docker');
          const projectId = data.target === 'docker' ? text(data.projectId, '项目 ID', 100) : null;
          const employeeId = data.target === 'zcode' && data.employeeId != null ? text(data.employeeId, '员工 ID', 100) : null;
          return send(res, 202, await workflow.execution.startCheck(data.target, identity.id, projectId, employeeId));
        }
        if (route === '/api/execution/revoke' && method === 'POST') {
          const data = await authenticatedBody(); assertFields(data, ['target']);
          if (data.target !== 'zcode' && data.target !== 'docker') throw new AppError('撤销目标必须是 zcode 或 docker');
          return send(res, 200, workflow.revokeExecution(data.target, identity.id));
        }
        if (route === '/api/skills' && method === 'GET') return send(res, 200, workflow.skills.catalog());
        const human = { type: 'user' as const, id: identity.id };
        if (route === '/api/skills/drafts' && method === 'POST') {
          const data = await authenticatedBody();
          return send(res, 201, workflow.skills.createManual(human, data));
        }
        const draftMatch = route.match(/^\/api\/skills\/drafts\/([^/]+)(?:\/(publish|reject))?$/);
        if (draftMatch) {
          const [, draftId, action] = draftMatch;
          if (!action && method === 'GET') return send(res, 200, workflow.skills.detail('draft', draftId));
          if (!action && method === 'PATCH') return send(res, 200, workflow.skills.updateDraft(human, draftId, await authenticatedBody()));
          if (action === 'publish' && method === 'POST') return send(res, 201, workflow.skills.publish(human, draftId, await authenticatedBody()));
          if (action === 'reject' && method === 'POST') return send(res, 200, workflow.skills.reject(human, draftId, await authenticatedBody()));
        }
        const versionMatch = route.match(/^\/api\/skills\/versions\/([^/]+)(?:\/(revise|availability))?$/);
        if (versionMatch) {
          const [, versionId, action] = versionMatch;
          if (!action && method === 'GET') return send(res, 200, workflow.skills.detail('version', versionId));
          if (action === 'revise' && method === 'POST') { assertFields(await authenticatedBody(), []); return send(res, 201, workflow.skills.reviseVersion(human, versionId)); }
          if (action === 'availability' && method === 'PATCH') {
            const data = await authenticatedBody(); assertFields(data, ['enabled']);
            if (typeof data.enabled !== 'boolean') throw new AppError('技能启用状态必须是布尔值');
            return send(res, 200, workflow.skills.setAvailability(human, versionId, data.enabled));
          }
        }
        const employeeSkillsMatch = route.match(/^\/api\/employees\/([^/]+)\/skills$/);
        if (employeeSkillsMatch && method === 'POST') return send(res, 200, workflow.skills.assign(human, employeeSkillsMatch[1], await authenticatedBody()));
        if ((route === '/api/employees' && method === 'POST') || (/^\/api\/employees\/[^/]+$/.test(route) && method === 'PATCH')) {
          const data = await authenticatedBody(); assertFields(data, ['name', 'role', 'duties', 'reportsTo', 'projectIds', 'enabled']);
          const previous = method === 'PATCH' ? store.get('employees', route.split('/')[3]) : null;
          if (method === 'PATCH' && !previous) throw new AppError('员工不存在', 404);
          const employeeId = previous?.id ?? id('employee');
          if (previous && store.all('tasks').some(task => busyStatuses.includes(task.status) && [task.leaderId, task.developerId, task.qaId].includes(employeeId))) throw new AppError('员工有运行中任务，不能修改岗位或权限', 409);
          const merged = { ...previous, ...data };
          if (typeof merged.role !== 'string' || !roles.includes(merged.role as Role)) throw new AppError('岗位不在允许列表');
          if (!Array.isArray(merged.projectIds) || !merged.projectIds.every(value => typeof value === 'string' && store.get('projects', value))) throw new AppError('负责项目列表无效');
          if (typeof merged.enabled !== 'boolean') throw new AppError('启用状态必须是布尔值');
          const employee: Employee = { id: employeeId, name: text(merged.name, '员工姓名', 60), role: merged.role as Role, duties: text(merged.duties, '岗位职责', 5000), reportsTo: optionalId(merged.reportsTo), projectIds: [...new Set(merged.projectIds as string[])], enabled: merged.enabled, createdAt: previous?.createdAt ?? now() };
          validateHierarchy(employee.id, employee.reportsTo, store.all('employees'));
          store.transaction(() => { store.put('employees', employee); store.audit(identity.id, previous ? '修改员工资料' : '创建员工', employee.id, `${employee.name} · ${employee.role}；资料变更不触发执行`); });
          return send(res, previous ? 200 : 201, employee);
        }
        if (route === '/api/projects' && method === 'POST') {
          const data = await authenticatedBody(); assertFields(data, ['name', 'description', 'leadId']);
          const name = text(data.name, '项目名称', 100);
          const description = data.description === undefined ? '' : text(data.description, '描述', 3000, 0);
          const leadId = optionalId(data.leadId);
          if (leadId && !['director', 'lead'].includes(store.get('employees', leadId)?.role ?? '')) throw new AppError('项目负责人必须是领导岗位');
          const projectId = id('project');
          const cleanup = prepareProjectCleanup(config.workspaceRoot, projectId);
          let project: Project;
          try {
            const workspace = workflow.workspaces.createProject(projectId);
            project = { id: projectId, name, description, leadId, workspace, stack: 'Node.js · 隔离演示项目', testCommand: ['node', '--test', 'tests'], dockerImage: config.docker.image, createdAt: now() };
            store.transaction(() => {
              store.put('projects', project);
              if (leadId) { const lead = store.get('employees', leadId)!; store.put('employees', { ...lead, projectIds: [...new Set([...lead.projectIds, projectId])] }); }
              store.audit(identity.id, '创建隔离演示项目', projectId, '不接入现有业务目录；请在组织页面明确分配开发和测试员工');
            });
          } catch (error) {
            cleanup();
            throw error;
          }
          return send(res, 201, project);
        }
        if (route === '/api/tasks' && method === 'POST') {
          const data = await authenticatedBody(); assertFields(data, ['title', 'goal', 'projectId', 'leaderId', 'developerId', 'qaId']);
          const projectId = text(data.projectId, '项目 ID', 100);
          if (!store.get('projects', projectId)) throw new AppError('项目不存在');
          const task: Task = { id: id('task'), title: text(data.title, '任务标题', 150), goal: text(data.goal, '目标', 12_000), projectId, leaderId: text(data.leaderId, '领导 ID', 100), developerId: text(data.developerId, '开发 ID', 100), qaId: text(data.qaId, '测试 ID', 100), status: 'draft', mode: null, version: 1, contentHash: null, plan: null, blockedReason: null, createdAt: now(), updatedAt: now() };
          validateTeam(task, store.all('employees'));
          store.transaction(() => { store.put('tasks', task); store.audit(identity.id, '创建领导指令', task.id, '待规划；创建本身不启动执行'); });
          return send(res, 201, task);
        }
        const taskMatch = route.match(/^\/api\/tasks\/([^/]+)(?:\/(run|cancel|revise|approve|reject))?$/);
        if (taskMatch) {
          const [, taskId, action] = taskMatch;
          if (!action && method === 'GET') {
            const task = workflow.task(taskId); let files: { path: string; sha256: string; bytes: number }[] = []; let diff = '';
            if (fs.existsSync(workflow.taskWorkspace(taskId))) { files = workflow.workspaces.snapshot(workflow.taskWorkspace(taskId)).files; diff = workflow.workspaces.diff(workflow.taskWorkspace(taskId)); }
            return send(res, 200, { task, files, diff, runs: store.all('runs').filter(run => run.taskId === taskId), tests: store.all('tests').filter(run => run.taskId === taskId), approvals: store.all('approvals').filter(item => item.taskId === taskId) });
          }
          if (method === 'POST' && action) {
            const data = await authenticatedBody();
            if (action === 'run') { assertFields(data, ['mode']); if (typeof data.mode !== 'string' || (data.mode !== 'simulation' && data.mode !== 'zcode')) throw new AppError('无效执行模式'); return send(res, 202, await workflow.enqueue(taskId, data.mode, identity.id)); }
            if (action === 'cancel') { assertFields(data, []); return send(res, 200, workflow.cancel(taskId, identity.id)); }
            if (action === 'revise') { assertFields(data, ['goal']); return send(res, 200, workflow.revise(taskId, text(data.goal, '修订目标', 12_000), identity.id)); }
            if (action === 'reject') { assertFields(data, ['note']); return send(res, 200, workflow.reject(taskId, identity.id, text(data.note, '退回原因', 3000))); }
            if (action === 'approve') {
              assertFields(data, ['kind', 'taskVersion', 'contentHash', 'note']);
              if (typeof data.kind !== 'string' || (data.kind !== 'merge' && data.kind !== 'release') || !Number.isInteger(data.taskVersion)) throw new AppError('审批参数无效');
              return send(res, 200, workflow.approve(taskId, { type: 'user', id: identity.id }, data.kind, data.taskVersion as number, text(data.contentHash, '内容哈希', 100), text(data.note ?? '', '审批说明', 3000, 0)));
            }
          }
        }
        if (route === '/api/monitors' && method === 'POST') {
          const data = await authenticatedBody(); assertFields(data, ['projectId', 'url', 'intervalSeconds']);
          const projectId = text(data.projectId, '项目 ID', 100); if (!store.get('projects', projectId)) throw new AppError('项目不存在');
          const url = validateMonitorUrl(text(data.url, '健康地址', 600));
          if (Number(url.port) === config.port) throw new AppError('业务监控不能用管理平台自身的健康状态冒充');
          const seconds = Number(data.intervalSeconds ?? 60); if (!Number.isInteger(seconds) || seconds < 30 || seconds > 3600) throw new AppError('检查周期为 30–3600 秒');
          const monitor = { id: id('monitor'), projectId, url: url.toString(), enabled: config.monitoringEnabled, intervalSeconds: seconds, lastCheckedAt: null, lastStatus: 'unknown' as const, detail: config.monitoringEnabled ? '等待第一次只读检查' : '自动检查关闭，可手动检查已登记的本机演示服务' };
          store.put('monitors', monitor); store.audit(identity.id, '登记只读监控', monitor.id, monitor.url); return send(res, 201, monitor);
        }
        const checkMatch = route.match(/^\/api\/monitors\/([^/]+)\/check$/);
        if (checkMatch && method === 'POST') { assertFields(await authenticatedBody(), []); return send(res, 200, await monitoring.check(checkMatch[1], identity.id)); }
        const incidentMatch = route.match(/^\/api\/incidents\/([^/]+)$/);
        if (incidentMatch && method === 'PATCH') {
          const data = await authenticatedBody(); assertFields(data, ['status']); if (typeof data.status !== 'string' || (data.status !== 'acknowledged' && data.status !== 'resolved')) throw new AppError('事件状态无效');
          const incident = store.get('incidents', incidentMatch[1]); if (!incident) throw new AppError('事件不存在', 404);
          const next: typeof incident = { ...incident, status: data.status }; store.put('incidents', next); store.audit(identity.id, '处理监控事件', next.id, next.status); return send(res, 200, next);
        }
        throw new AppError('接口不存在', 404);
      }
      if (method !== 'GET' && method !== 'HEAD') throw new AppError('方法不允许', 405);
      const webRoot = path.join(root, 'dist', 'web');
      let pathname: string; try { pathname = decodeURIComponent(route); } catch { throw new AppError('路径无效'); }
      const file = path.resolve(webRoot, '.' + pathname);
      if (!file.startsWith(webRoot + path.sep) && file !== webRoot) throw new AppError('路径越界', 403);
      const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(webRoot, 'index.html');
      if (!fs.existsSync(target)) return send(res, 503, { error: '前端尚未构建，请运行 npm run build' });
      res.writeHead(200, { 'Content-Type': mime[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      if (method === 'HEAD') res.end(); else fs.createReadStream(target).pipe(res);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof AppError ? error.status : 500;
      send(res, status, { error: error instanceof Error ? error.message : '服务异常' });
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  return { server, store, workflow, monitoring, close: async () => { monitoring.stop(); await workflow.shutdown(); if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close(); } };
}
