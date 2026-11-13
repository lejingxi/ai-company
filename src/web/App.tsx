import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { AuthState, Dashboard, Employee, Incident, Role, Task } from '../shared/types';
import { api, errorMessage, setCsrfToken } from './api';
import { activeStatuses, Badge, Brand, Empty, ErrorNotice, Field, FormDialog, formatDate, Icon, Loading, ModeBadge, roleLabels, statusLabels, TaskBadge, text } from './ui';
import type { IconName } from './ui';
import TaskDetail from './TaskDetail';
import Execution from './Execution';
import EmployeeModel, { employeeModelSummary } from './EmployeeModel';
import Skills, { EmployeeSkills, NewSkillDraft, SkillDetailDialog } from './Skills';
import type { SkillEvidenceLink, SkillSelection } from './Skills';

type Page = 'overview' | 'people' | 'projects' | 'tasks' | 'skills' | 'execution' | 'approvals' | 'monitoring' | 'audit';
type Editor = { type: 'employee'; employee?: Employee } | { type: 'project' } | { type: 'task'; projectId?: string } | { type: 'monitor' } | { type: 'incident'; incident: Incident };
const navigation: { id: Page; label: string; icon: IconName; group?: string }[] = [
  { id: 'overview', label: '总览', icon: 'overview', group: '工作空间' },
  { id: 'people', label: '组织员工', icon: 'people' },
  { id: 'projects', label: '项目', icon: 'project' },
  { id: 'tasks', label: '任务指挥', icon: 'task' },
  { id: 'skills', label: '技能库', icon: 'file' },
  { id: 'execution', label: '执行接入', icon: 'shield' },
  { id: 'approvals', label: '审批中心', icon: 'approval', group: '治理与观察' },
  { id: 'monitoring', label: '运维观察', icon: 'monitor' },
  { id: 'audit', label: '审计记录', icon: 'audit' },
];
const pageCopy: Record<Page, [string, string]> = {
  overview: ['让协作有序，让每一步可见。', '从目标到交付，在一个工作台里管理 AI 研发团队。'],
  people: ['组织员工', '定义职责与汇报关系。启用员工不会自动触发任何执行。'],
  projects: ['项目空间', '每个项目都有独立的本机演示工作区，边界清楚，变更可查。'],
  tasks: ['任务指挥', '明确目标、分配角色，再由你决定何时启动。'],
  skills: ['技能库', '经验沉淀为草稿，由人审核发布，再显式配置固定版本。知识不授予执行权限。'],
  execution: ['执行接入', '复用现有 ZCode 环境；由你明确确认连接与 Docker 探针检查，仅限演示，生产执行关闭。'],
  approvals: ['审批中心', '先核验真实测试与内容摘要，再记录你的审批决定。'],
  monitoring: ['运维观察', '观察获准的端点与事件，不代表生产环境已部署或受到保障。'],
  audit: ['审计记录', '查看服务端记录的操作事实，追溯参与者、对象与时间。'],
};

function useDashboard(enabled: boolean) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!enabled) { setData(null); setError(''); setUpdatedAt(null); return; }
    let disposed = false;
    let pending = false;
    let controller: AbortController | null = null;
    async function load() {
      if (pending || disposed) return;
      pending = true;
      controller = new AbortController();
      setRefreshing(true);
      try {
        const next = await api<Dashboard>('/api/dashboard', { signal: controller.signal });
        if (!disposed) { setData(next); setError(''); setUpdatedAt(new Date().toISOString()); }
      } catch (err) {
        if (!disposed && !controller.signal.aborted) setError(errorMessage(err));
      } finally {
        pending = false;
        if (!disposed) setRefreshing(false);
      }
    }
    void load();
    const timer = window.setInterval(() => { void load(); }, 5_000);
    return () => { disposed = true; window.clearInterval(timer); controller?.abort(); };
  }, [enabled, revision]);
  return { data, error, refreshing, updatedAt, refresh };
}

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [authError, setAuthError] = useState('');
  const [authRevision, setAuthRevision] = useState(0);
  const [page, setPage] = useState<Page>('overview');
  const [mobileNav, setMobileNav] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [taskFocus, setTaskFocus] = useState<SkillEvidenceLink | null>(null);
  const [skillSelection, setSkillSelection] = useState<SkillSelection | null>(null);
  const [newSkill, setNewSkill] = useState(false);
  const [executionRevision, setExecutionRevision] = useState(0);
  const [skillEmployeeId, setSkillEmployeeId] = useState<string | null>(null);
  const [modelEmployeeId, setModelEmployeeId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [logoutError, setLogoutError] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const { data, error, refreshing, updatedAt, refresh } = useDashboard(Boolean(auth?.user));
  useEffect(() => {
    const controller = new AbortController();
    setAuthError('');
    api<AuthState>('/api/auth/status', { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      setCsrfToken(value.csrfToken); setAuth(value);
    }).catch(err => { if (!controller.signal.aborted) setAuthError(errorMessage(err)); });
    return () => controller.abort();
  }, [authRevision]);
  useEffect(() => {
    const expire = () => { setCsrfToken(); setAuth({ setupRequired: false, user: null }); setEditor(null); setTaskId(null); setTaskFocus(null); setSkillSelection(null); setNewSkill(false); setSkillEmployeeId(null); setModelEmployeeId(null); setNotice(''); setAuthError('会话已过期，请重新登录。'); };
    window.addEventListener('zhiyansi:session-expired', expire);
    return () => window.removeEventListener('zhiyansi:session-expired', expire);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 6_000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const navigate = (next: Page) => { setPage(next); setMobileNav(false); };
  const saved = (message: string) => { setEditor(null); setNotice(message); refresh(); };
  const logout = async () => {
    setSigningOut(true); setLogoutError('');
    try {
      await api('/api/auth/logout', { method: 'POST', body: {} });
      setCsrfToken(); setAuth({ setupRequired: false, user: null }); setEditor(null); setTaskId(null); setTaskFocus(null); setSkillSelection(null); setNewSkill(false); setSkillEmployeeId(null); setModelEmployeeId(null); setPage('overview'); setNotice('');
    } catch (err) { setLogoutError(errorMessage(err)); }
    finally { setSigningOut(false); }
  };
  if (!auth?.user) {
    return <AuthScreen auth={auth} error={authError} retry={() => setAuthRevision(value => value + 1)} onSuccess={value => { setCsrfToken(value.csrfToken); setAuth({ ...value, setupRequired: false }); setAuthError(''); }} />;
  }
  const pendingApprovals = data?.tasks.filter(task => ['awaiting_merge', 'awaiting_release'].includes(task.status)).length ?? 0;
  return <div className="app-shell">
    <a className="skip-link" href="#workspace">跳至工作区</a>
    {mobileNav && <button className="nav-backdrop" onClick={() => setMobileNav(false)} aria-label="关闭导航" />}
    <aside className={`sidebar ${mobileNav ? 'is-open' : ''}`}>
      <div className="sidebar-brand"><Brand /><button className="icon-button mobile-only" aria-label="关闭导航" onClick={() => setMobileNav(false)}><Icon name="close" /></button></div>
      <div className="workspace-switch"><span className="workspace-avatar">研</span><div><strong>本机研发空间</strong><small>人来决策 · AI 来协作</small></div><span className="tiny-status" /></div>
      <nav aria-label="主导航">{navigation.map(item => <div key={item.id}>{item.group && <p className="nav-group">{item.group}</p>}<button className={`nav-item ${page === item.id ? 'is-active' : ''}`} aria-current={page === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><Icon name={item.icon} /><span>{item.label}</span>{item.id === 'approvals' && pendingApprovals > 0 && <span className="nav-count">{pendingApprovals}</span>}</button></div>)}</nav>
      <div className="sidebar-bottom"><div className="local-card"><Icon name="shield" size={19} /><div><strong>本机模式</strong><p>生产执行关闭<br />所有操作均保留审计记录</p></div></div><div className="sidebar-version"><span>智研司</span><span>v{data?.appVersion ?? '—'}</span></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-only" aria-label="打开导航" aria-expanded={mobileNav} onClick={() => setMobileNav(true)}><Icon name="menu" /></button><span className="breadcrumb-parent">工作台</span><Icon name="chevron" size={13} /><strong>{navigation.find(item => item.id === page)?.label}</strong></div><div className="topbar-right"><span className="environment"><span className="status-dot" />本机模式 · 生产执行关闭</span><span className="topbar-divider" /><span className="user-avatar">{auth.user.username.slice(0, 1).toUpperCase()}</span><span className="username">{auth.user.username}</span><button className="icon-button logout-button" aria-label="退出登录" title="退出登录" disabled={signingOut} onClick={() => void logout()}>{signingOut ? <span className="spinner" /> : <Icon name="logout" size={18} />}</button></div></header>
      <main id="workspace" className="workspace" tabIndex={-1}>
        <div className="page-heading"><div><p className="eyebrow">{page === 'overview' ? 'WORKSPACE OVERVIEW' : 'ZHIYANSI / ' + page.toUpperCase()}</p><h1>{pageCopy[page][0]}</h1><p className="page-description">{pageCopy[page][1]}</p></div><div className="page-actions"><button className="button button-secondary" onClick={() => { refresh(); if (page === 'execution') setExecutionRevision(value => value + 1); }} disabled={refreshing}><Icon name="refresh" size={16} /><span>{refreshing ? '同步中' : page === 'execution' ? '刷新接入状态' : '刷新'}</span></button>{data && page !== 'execution' && page !== 'approvals' && page !== 'audit' && <button className="button button-primary" onClick={() => page === 'skills' ? setNewSkill(true) : setEditor(page === 'people' ? { type: 'employee' } : page === 'projects' ? { type: 'project' } : page === 'monitoring' ? { type: 'monitor' } : { type: 'task' })}><Icon name="plus" size={17} />{page === 'skills' ? '新建技能草稿' : page === 'people' ? '新增员工' : page === 'projects' ? '新建项目' : page === 'monitoring' ? '添加观察端点' : '创建任务'}</button>}</div></div>
        {notice && <div className="notice notice-success" role="status"><Icon name="check" /><span>{notice}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice('')}><Icon name="close" size={16} /></button></div>}
        {logoutError && <ErrorNotice message={logoutError} />}
        {error && <ErrorNotice message={`${error}${data ? ' 当前保留上次同步数据，可能已过期。' : ''}`} retry={refresh} />}
        {page === 'execution' ? <Execution refreshKey={executionRevision} onChanged={refresh} /> : !data ? error ? <Empty title="数据暂时不可用" description="连接恢复前不会显示虚构的任务、员工或运行指标。请重试读取服务端数据。" icon="monitor" /> : <Loading /> : <>
          {page === 'overview' && <Overview data={data} navigate={navigate} openTask={setTaskId} openEditor={setEditor} />}
          {page === 'people' && <People data={data} edit={employee => setEditor({ type: 'employee', employee })} add={() => setEditor({ type: 'employee' })} configureSkills={setSkillEmployeeId} configureModel={setModelEmployeeId} />}
          {page === 'skills' && <Skills data={data} open={setSkillSelection} create={() => setNewSkill(true)} />}
          {page === 'projects' && <Projects data={data} createTask={projectId => setEditor({ type: 'task', projectId })} add={() => setEditor({ type: 'project' })} />}
          {page === 'tasks' && <Tasks data={data} openTask={setTaskId} add={() => setEditor({ type: 'task' })} />}
          {page === 'approvals' && <Approvals data={data} openTask={setTaskId} />}
          {page === 'monitoring' && <Monitoring data={data} refresh={refresh} editIncident={incident => setEditor({ type: 'incident', incident })} add={() => setEditor({ type: 'monitor' })} />}
          {page === 'audit' && <Audit data={data} />}
        </>}
        <footer className="workspace-footer"><span>智研司 · 可追溯的 AI 研发协作</span><span className="sync-state"><span className={`status-dot ${error ? 'dot-error' : ''}`} />{updatedAt ? `上次同步 ${formatDate(updatedAt)} · 每 5 秒更新` : '等待本机服务数据'}</span></footer>
      </main>
    </div>
    {editor && data && <EntityEditor key={`${editor.type}-${'employee' in editor ? editor.employee?.id ?? 'new' : 'incident' in editor ? editor.incident.id : 'new'}`} editor={editor} data={data} onClose={() => setEditor(null)} saved={saved} />}
    {newSkill && data && <NewSkillDraft data={data} onClose={() => setNewSkill(false)} onCreated={draft => { setNewSkill(false); setSkillSelection({ kind: 'draft', id: draft.id }); setNotice('人工技能草稿已创建，尚未发布或分配。'); refresh(); }} />}
    {modelEmployeeId && data && <EmployeeModel key={modelEmployeeId} employeeId={modelEmployeeId} employeeName={data.employees.find(employee => employee.id === modelEmployeeId)?.name ?? modelEmployeeId} initialState={data.employeeModels?.find(state => state.employeeId === modelEmployeeId)} onClose={() => setModelEmployeeId(null)} onSaved={() => { refresh(); setNotice('员工模型配置已保存，不会自动测试或启动任务。'); }} />}
    {skillEmployeeId && data && <EmployeeSkills key={skillEmployeeId} employeeId={skillEmployeeId} data={data} onClose={() => setSkillEmployeeId(null)} onSaved={() => { setSkillEmployeeId(null); setNotice('固定技能版本与项目已保存，没有触发执行。'); refresh(); }} />}
    {skillSelection && data && <SkillDetailDialog key={`${skillSelection.kind}-${skillSelection.id}`} selection={skillSelection} data={data} onClose={() => setSkillSelection(null)} onChanged={refresh} onSelect={setSkillSelection} openEvidence={link => { setTaskFocus(link); setTaskId(link.taskId); }} />}
    {taskId && data && <TaskDetail key={`${taskId}-${taskFocus?.focusRecordId ?? ''}`} taskId={taskId} data={data} initialTab={taskFocus?.initialTab} focusRecordId={taskFocus?.focusRecordId} onClose={() => { setTaskId(null); setTaskFocus(null); }} onChanged={refresh} />}
  </div>;
}

function AuthScreen({ auth, error, retry, onSuccess }: { auth: AuthState | null; error: string; retry: () => void; onSuccess: (auth: AuthState) => void }) {
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const setup = auth?.setupRequired ?? false;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !auth) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    controller.current?.abort(); controller.current = new AbortController();
    setBusy(true); setFormError('');
    try {
      const result = await api<AuthState>(setup ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body: { username: text(values, 'username'), password: String(values.get('password') ?? '') }, signal: controller.current.signal });
      if (!result.user || !result.csrfToken) throw new Error('服务未返回完整的会话凭证，请重试。');
      form.reset(); onSuccess(result);
    } catch (err) { if (!controller.current.signal.aborted) setFormError(errorMessage(err)); }
    finally { if (!controller.current.signal.aborted) setBusy(false); }
  };
  return <main className="auth-shell"><section className="auth-story"><Brand /><div className="auth-story-content"><span className="auth-kicker">你的 AI 研发组织，从这里开始</span><h1>把想法交给团队，<br />把决策留给自己。</h1><p>为每一位 AI 员工明确职责，<br />让每一次执行、测试与批准都有据可查。</p><div className="auth-flow"><span><Icon name="people" />组织</span><i /><span><Icon name="code" />执行</span><i /><span><Icon name="approval" />审批</span></div><div className="auth-architecture" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="architecture-core"><Brand compact /></div><span className="architecture-node node-one">目标规划</span><span className="architecture-node node-two">独立测试</span><span className="architecture-node node-three">人工决策</span></div></div><div className="auth-story-footer"><span>本机模式 · 生产执行关闭</span><span>ZH I YAN SI / 智研司</span></div></section><section className="auth-panel"><div className="auth-form-wrap"><div className="auth-mobile-brand"><Brand /></div><Badge tone="teal" dot>本机研发工作台</Badge><h2>{setup ? '建立你的工作空间' : '欢迎回到智研司'}</h2><p className="auth-subtitle">{setup ? '设置首位管理员，即可开始组织你的 AI 研发团队。' : '登录管理员账户，继续掌握团队的每一步进展。'}</p>{!auth ? <>{error ? <ErrorNotice message={error} retry={retry} /> : <Loading label="正在确认本机初始化状态…" />}</> : <form onSubmit={submit}><fieldset disabled={busy} className="form-fields"><Field label="管理员用户名"><input name="username" autoComplete="username" required minLength={setup ? 2 : 1} maxLength={60} placeholder="输入用户名" autoFocus /></Field><Field label={setup ? '设置密码' : '密码'} hint={setup ? '密码须为 12–128 位，请勿与其他账户重复使用。' : undefined}><input name="password" type="password" minLength={setup ? 12 : 1} maxLength={128} autoComplete={setup ? 'new-password' : 'current-password'} required placeholder={setup ? '设置一个安全的密码' : '输入密码'} /></Field></fieldset>{(formError || error) && <ErrorNotice message={formError || error} />}<button type="submit" className="button button-primary auth-submit" disabled={busy}>{busy ? <span className="spinner" /> : null}{busy ? '正在验证…' : setup ? '创建管理员并进入' : '登录工作台'}{!busy && <Icon name="arrow" size={18} />}</button></form>}<div className="auth-security"><Icon name="shield" size={19} /><p>凭据仅由浏览器提交至本机服务。<br />会话验证信息不写入浏览器持久化存储。</p></div></div><p className="auth-bottom-note">本系统不自动连接、修改或部署你的生产项目。</p></section></main>;
}

function SectionHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="section-heading"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>;
}
function CapabilityPanel({ data }: { data: Dashboard }) {
  const entries = [['zcode', 'ZCode CLI'], ['docker', 'Docker 测试环境'], ['realExecution', '真实执行'], ['mergeExecution', '实际合并'], ['releaseExecution', '实际发布']] as const;
  return <section className="panel capability-panel"><SectionHeader title="本机能力检查" description="服务端实时状态，不等同于生产授权" /><div className="capability-list">{entries.map(([key, label]) => { const item = data.capabilities[key]; return <div className="capability-row" key={key}><span className={`capability-symbol ${item.ready ? 'is-ready' : ''}`}><Icon name={item.ready ? 'check' : 'shield'} size={15} /></span><div><div className="capability-title"><strong>{label}</strong><Badge tone={item.ready ? 'teal' : 'neutral'}>{item.ready ? '就绪' : '不可用'}</Badge></div><p>{item.reason || (item.ready ? '服务端已确认可用' : '服务端未提供原因')}</p></div></div>; })}</div></section>;
}
function Overview({ data, navigate, openTask, openEditor }: { data: Dashboard; navigate: (page: Page) => void; openTask: (id: string) => void; openEditor: (editor: Editor) => void }) {
  const activeTasks = data.tasks.filter(task => activeStatuses.includes(task.status));
  const pending = data.tasks.filter(task => ['awaiting_merge', 'awaiting_release'].includes(task.status));
  const activeIncidents = data.incidents.filter(item => item.status !== 'resolved');
  const stats = [
    { label: '在岗员工', value: data.employees.filter(item => item.enabled).length, icon: 'people' as const, detail: `共 ${data.employees.length} 位 · 职责分工协作`, tone: 'teal', page: 'people' as Page },
    { label: '项目空间', value: data.projects.length, icon: 'project' as const, detail: '独立的本机演示工作区', tone: 'indigo', page: 'projects' as Page },
    { label: '进行中任务', value: activeTasks.length, icon: 'task' as const, detail: `全部 ${data.tasks.length} 项 · 由你手动启动`, tone: 'teal', page: 'tasks' as Page },
    { label: '待处理审批', value: pending.length, icon: 'approval' as const, detail: '合并与发布均需人工决策', tone: 'amber', page: 'approvals' as Page },
  ];
  return <><section className="overview-banner"><div><span className="banner-label"><span className="status-dot" />HUMAN IN CONTROL</span><h2>AI 团队协作，人类始终掌舵</h2><p>任务由你发起，真实变更需经独立测试与明确审批。</p></div><div className="banner-flow" aria-label="研发流程"><span><Icon name="task" />目标</span><Icon name="arrow" size={15} /><span><Icon name="code" />研发</span><Icon name="arrow" size={15} /><span><Icon name="check" />测试</span><Icon name="arrow" size={15} /><span className="flow-human"><Icon name="approval" />你批准</span></div></section>
    <section className="stats-grid" aria-label="服务端实时统计">{stats.map(stat => <button className="stat-card" key={stat.label} onClick={() => navigate(stat.page)}><div className="stat-top"><span>{stat.label}</span><span className={`stat-icon ${stat.tone}`}><Icon name={stat.icon} /></span></div><strong className="stat-number">{stat.value}<small>{stat.label.includes('员工') ? '位' : '项'}</small></strong><div className="stat-bottom"><span>{stat.detail}</span><Icon name="arrow" size={14} /></div></button>)}</section>
    <div className="overview-grid"><div className="overview-primary"><section className="panel"><SectionHeader title="任务进展" description="从规划到批准，查看最近的协作动态" action={<button className="text-button" onClick={() => navigate('tasks')}>全部任务<Icon name="arrow" size={15} /></button>} />{data.tasks.length ? <div className="task-preview-list">{[...data.tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5).map(task => <button key={task.id} className="task-preview" onClick={() => openTask(task.id)}><span className="task-preview-icon"><Icon name="task" /></span><span className="task-preview-copy"><strong>{task.title}</strong><small>{data.projects.find(project => project.id === task.projectId)?.name ?? '未知项目'}<span>·</span>{formatDate(task.updatedAt)}</small></span><TaskBadge status={task.status} /><Icon name="chevron" size={16} /></button>)}</div> : <Empty icon="task" title="把第一个目标交给团队" description="尚未创建任务。先建立演示项目，再选择负责人、开发与测试员工；创建后也不会自动运行。" action={<button className="button button-primary" onClick={() => openEditor(data.projects.length ? { type: 'task' } : { type: 'project' })}><Icon name="plus" size={16} />{data.projects.length ? '创建第一个任务' : '创建第一个项目'}</button>} />}</section>
      <section className="panel"><SectionHeader title="协作路径" description="清晰的职责边界，是可靠交付的起点" /><div className="workflow-steps">{[{ icon: 'people', title: '组建团队', desc: '明确员工职责' }, { icon: 'project', title: '建立项目', desc: '隔离演示工作区' }, { icon: 'task', title: '发起任务', desc: '手动选择执行模式' }, { icon: 'approval', title: '核验与审批', desc: '保留人工决策' }].map((step, index) => <div className="workflow-step" key={step.title}><span className="step-number">0{index + 1}</span><Icon name={step.icon as IconName} size={22} /><strong>{step.title}</strong><p>{step.desc}</p></div>)}</div></section>
      {activeIncidents.length > 0 && <button className="incident-callout" onClick={() => navigate('monitoring')}><Icon name="alert" /><span><strong>{activeIncidents.length} 条事件需要关注</strong><small>前往运维观察查看服务端事件详情</small></span><Icon name="arrow" /></button>}
    </div><div className="overview-secondary"><CapabilityPanel data={data} /><section className="panel boundary-card"><span className="boundary-icon"><Icon name="shield" /></span><h3>安全边界，不因自动化而模糊</h3><p>模拟结果不可用于真实批准。审批仅记录决定，不实际合并或发布。</p><button className="text-button" onClick={() => navigate('approvals')}>查看审批中心<Icon name="arrow" size={15} /></button></section></div></div></>;
}

function People({ data, edit, add, configureSkills, configureModel }: { data: Dashboard; edit: (employee: Employee) => void; add: () => void; configureSkills: (employeeId: string) => void; configureModel: (employeeId: string) => void }) {
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('all');
  const employees = data.employees.filter(employee => (role === 'all' || employee.role === role) && `${employee.name} ${employee.duties}`.toLowerCase().includes(query.toLowerCase()));
  return <><div className="view-toolbar"><div className="search-field"><Icon name="search" size={18} /><input aria-label="搜索员工" placeholder="搜索姓名或职责…" value={query} onChange={event => setQuery(event.target.value)} /></div><select aria-label="按员工角色筛选" value={role} onChange={event => setRole(event.target.value)}><option value="all">全部角色</option>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><span className="toolbar-count">{employees.length} 位员工</span></div>{!employees.length ? <section className="panel"><Empty icon="people" title={data.employees.length ? '没有匹配的员工' : '团队席位已准备好'} description={data.employees.length ? '试试其他关键词或角色筛选。' : '创建员工，明确职责与汇报关系。员工信息由本机服务保存。'} action={!data.employees.length && <button className="button button-primary" onClick={add}>新增员工</button>} /></section> : <div className="employee-grid">{employees.map(employee => <article className={`panel employee-card ${!employee.enabled ? 'employee-disabled' : ''}`} key={employee.id}><header><span className={`employee-avatar role-${employee.role}`}>{employee.name.slice(0, 1)}</span><div className="employee-heading"><h2>{employee.name}</h2><span>{roleLabels[employee.role]}</span></div><Badge tone={employee.enabled ? 'teal' : 'neutral'} dot>{employee.enabled ? '在岗' : '已停用'}</Badge></header><p className="employee-duties">{employee.duties || '尚未填写职责'}</p><dl className="employee-meta"><div><dt>汇报对象</dt><dd>{employee.reportsTo ? data.employees.find(item => item.id === employee.reportsTo)?.name ?? '未知员工' : '无 · 顶级角色'}</dd></div><div><dt>所属项目</dt><dd>{employee.projectIds.length ? employee.projectIds.map(id => data.projects.find(project => project.id === id)?.name ?? '未知项目').join('、') : '暂未分配'}</dd></div><div><dt>模型与思考强度</dt><dd>{employeeModelSummary(data.employeeModels?.find(state => state.employeeId === employee.id))} <button className="text-button" onClick={() => configureModel(employee.id)}>配置模型</button></dd></div><div><dt>固定技能</dt><dd>{(data.skillAssignments ?? []).filter(pin => pin.employeeId === employee.id).length} 个 <button className="text-button" onClick={() => configureSkills(employee.id)}>配置技能</button></dd></div></dl><footer><span>{data.runs.filter(run => run.employeeId === employee.id && run.status === 'running').length ? <Badge tone="indigo" dot>执行中</Badge> : '当前无运行中的任务'}</span><button className="text-button" onClick={() => edit(employee)}><Icon name="edit" size={15} />编辑</button></footer></article>)}</div>}<div className="subtle-note"><Icon name="shield" size={16} />不提供硬删除：可通过编辑停用员工，以保留历史运行与审计关联。</div></>;
}

function Projects({ data, createTask, add }: { data: Dashboard; createTask: (projectId: string) => void; add: () => void }) {
  return <><div className="notice notice-info"><Icon name="shield" /><span>仅用于新建演示工作区。路径由服务端创建与管理，不接受任意本机路径，也不会导入已有生产项目。</span></div>{!data.projects.length ? <section className="panel"><Empty icon="project" title="为第一个目标创建项目空间" description="为项目命名并指定负责人。独立演示工作区将由服务端自动创建。" action={<button className="button button-primary" onClick={add}><Icon name="plus" size={16} />新建项目</button>} /></section> : <div className="project-grid">{data.projects.map(project => { const tasks = data.tasks.filter(task => task.projectId === project.id); return <article className="panel project-card" key={project.id}><header><span className="project-icon"><Icon name="project" size={24} /></span><Badge tone="indigo">演示工作区</Badge></header><h2>{project.name}</h2><p className="project-description">{project.description || '尚未填写项目说明'}</p><dl className="project-meta"><div><dt>项目负责人</dt><dd>{data.employees.find(employee => employee.id === project.leadId)?.name ?? '未指定'}</dd></div><div><dt>技术栈</dt><dd>{project.stack || '服务端未提供'}</dd></div><div><dt>任务</dt><dd>{tasks.length} 项 <span className="muted">/ {tasks.filter(task => task.status === 'closed').length} 项完成</span></dd></div></dl><details className="workspace-details"><summary>查看服务端工作区信息</summary><p><span>路径</span><code>{project.workspace}</code></p><p><span>测试命令</span><code>{project.testCommand.join(' ') || '未配置'}</code></p><p><span>测试镜像</span><code>{project.dockerImage || '未配置'}</code></p></details><footer><span>{formatDate(project.createdAt)} 创建</span><button className="text-button" onClick={() => createTask(project.id)}>创建任务<Icon name="arrow" size={15} /></button></footer></article>; })}</div>}</>;
}

function Tasks({ data, openTask, add }: { data: Dashboard; openTask: (id: string) => void; add: () => void }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [projectId, setProjectId] = useState('all');
  const tasks = useMemo(() => [...data.tasks].filter(task => (status === 'all' || task.status === status) && (projectId === 'all' || task.projectId === projectId) && `${task.title} ${task.goal}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [data.tasks, status, projectId, query]);
  return <><div className="view-toolbar"><div className="search-field"><Icon name="search" size={18} /><input aria-label="搜索任务" placeholder="搜索任务标题或目标…" value={query} onChange={event => setQuery(event.target.value)} /></div><select aria-label="按任务状态筛选" value={status} onChange={event => setStatus(event.target.value)}><option value="all">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select aria-label="按项目筛选任务" value={projectId} onChange={event => setProjectId(event.target.value)}><option value="all">全部项目</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><span className="toolbar-count">{tasks.length} 项任务</span></div><section className="panel">{!tasks.length ? <Empty icon="task" title={data.tasks.length ? '没有匹配的任务' : '还没有任务，正适合开始'} description={data.tasks.length ? '更改筛选条件以查看其他任务。' : '创建目标、分配负责人、开发与测试员工。任务仅在你手动启动后执行。'} action={!data.tasks.length && <button className="button button-primary" onClick={add}>创建任务</button>} /> : <TaskTable tasks={tasks} data={data} openTask={openTask} />}</section><div className="subtle-note"><Icon name="shield" size={16} />浏览页面、刷新和创建任务均不会自动发起执行。模拟与真实执行在任务详情中明确区分。</div></>;
}
function TaskTable({ tasks, data, openTask }: { tasks: Task[]; data: Dashboard; openTask: (id: string) => void }) {
  return <div className="table-scroll"><table className="data-table"><thead><tr><th>任务 / 项目</th><th>负责人</th><th>状态</th><th>执行模式</th><th>最近更新</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{tasks.map(task => <tr key={task.id}><td><button className="table-title" onClick={() => openTask(task.id)}>{task.title}</button><small className="table-subtitle">{data.projects.find(project => project.id === task.projectId)?.name ?? '未知项目'} · v{task.version}</small></td><td>{data.employees.find(employee => employee.id === task.leaderId)?.name ?? '未知员工'}</td><td><TaskBadge status={task.status} /></td><td><ModeBadge mode={task.mode} /></td><td className="nowrap muted">{formatDate(task.updatedAt)}</td><td><button className="icon-button" aria-label={`查看任务：${task.title}`} onClick={() => openTask(task.id)}><Icon name="chevron" size={18} /></button></td></tr>)}</tbody></table></div>;
}

function Approvals({ data, openTask }: { data: Dashboard; openTask: (id: string) => void }) {
  const pending = data.tasks.filter(task => task.status === 'awaiting_merge' || task.status === 'awaiting_release');
  return <><div className="notice notice-warning"><Icon name="shield" /><span><strong>只记录批准，不实际合并/发布。</strong> 模拟 / 不可用于真实批准。请核验任务版本、差异内容哈希与真实测试退出码。</span></div><div className="approval-summary"><div><span className="approval-summary-icon"><Icon name="approval" size={26} /></span><div><h2>{pending.length} 项任务等待人工决策</h2><p>审批与具体版本、内容哈希绑定；修订目标后原审批失效。</p></div></div><Badge tone="neutral">人工决策关卡</Badge></div><section className="panel"><SectionHeader title="待审批任务" description="进入任务详情检查变更与测试证据" />{pending.length ? <TaskTable tasks={pending} data={data} openTask={openTask} /> : <Empty icon="approval" title="当前没有待处理审批" description="真实任务完成测试并进入审批阶段后，会出现在这里。初次运行不会自动生成任务或审批。" />}</section><section className="panel section-gap"><SectionHeader title="审批历史" description="服务端记录的审批与驳回决定" />{!data.approvals.length ? <Empty icon="audit" title="尚无审批记录" description="每一次人工决定都会关联任务版本与内容摘要，并保留记录。" /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>任务</th><th>审批类型</th><th>决定</th><th>版本 / 内容哈希</th><th>备注 / 时间</th></tr></thead><tbody>{[...data.approvals].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(approval => <tr key={approval.id}><td><button className="table-title" onClick={() => openTask(approval.taskId)}>{data.tasks.find(task => task.id === approval.taskId)?.title ?? approval.taskId}</button><small className="table-subtitle">操作人 {approval.userId}</small></td><td>{approval.kind === 'merge' ? '合并审批' : '发布审批'}</td><td><Badge tone={approval.decision === 'approved' ? 'teal' : 'red'}>{approval.decision === 'approved' ? '已批准（仅记录）' : '已驳回'}</Badge></td><td><span>v{approval.taskVersion}</span><code className="hash-preview" title={approval.contentHash}>{approval.contentHash.slice(0, 16)}…</code></td><td className="wrap-cell">{approval.note || '无备注'}<small className="table-subtitle">{formatDate(approval.createdAt)}</small></td></tr>)}</tbody></table></div>}</section></>;
}

function Monitoring({ data, refresh, editIncident, add }: { data: Dashboard; refresh: () => void; editIncident: (incident: Incident) => void; add: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const check = async (id: string) => {
    if (busyId) return;
    setBusyId(id); setErrors(previous => ({ ...previous, [id]: '' }));
    try { await api(`/api/monitors/${encodeURIComponent(id)}/check`, { method: 'POST', body: {} }); refresh(); }
    catch (err) { setErrors(previous => ({ ...previous, [id]: errorMessage(err) })); }
    finally { setBusyId(null); }
  };
  const monitorLabels = { healthy: '检查正常', failed: '检查失败', unknown: '尚未检查' };
  const incidentLabels = { open: '待处理', acknowledged: '已确认', resolved: '已解决' };
  return <><div className="notice notice-info"><Icon name="shield" /><span>仅允许服务端批准的公共或本机端点；地址范围与访问策略由服务端校验。此处不提供生产部署或可用性承诺。</span></div><section className="panel"><SectionHeader title="端点观察" description="展示最近一次实际检查结果，不推测历史可用率" />{!data.monitors.length ? <Empty icon="monitor" title="尚未添加观察端点" description="选择项目并添加获准的 HTTP(S) 端点。检查结果将由本机服务返回。" action={<button className="button button-primary" onClick={add}>添加观察端点</button>} /> : <div className="monitor-list">{data.monitors.map(monitor => <article className="monitor-row" key={monitor.id}><div className="monitor-main"><span className={`monitor-icon monitor-${monitor.lastStatus}`}><Icon name="monitor" size={22} /></span><div><h3>{data.projects.find(project => project.id === monitor.projectId)?.name ?? '未知项目'}</h3><code className="monitor-url">{monitor.url}</code><p>{monitor.detail || '等待服务端返回检查详情'}</p></div><Badge tone={monitor.lastStatus === 'healthy' ? 'teal' : monitor.lastStatus === 'failed' ? 'red' : 'neutral'} dot>{monitorLabels[monitor.lastStatus]}</Badge></div><div className="monitor-footer"><span>{monitor.enabled ? `观察间隔 ${monitor.intervalSeconds} 秒` : '已停用'} · 最近检查 {formatDate(monitor.lastCheckedAt)}</span><button className="button button-secondary button-small" onClick={() => void check(monitor.id)} disabled={busyId !== null}>{busyId === monitor.id ? <span className="spinner" /> : <Icon name="refresh" size={14} />}{busyId === monitor.id ? '检查中…' : '立即检查'}</button></div>{errors[monitor.id] && <ErrorNotice message={errors[monitor.id]} />}</article>)}</div>}</section><section className="panel section-gap"><SectionHeader title="事件记录" description="确认问题、跟踪处理状态；变更状态不代表服务已自动修复" />{!data.incidents.length ? <Empty icon="check" title="当前没有事件记录" description="没有记录不代表系统已接受生产健康认证。后续检查产生的事件会显示在这里。" /> : <div className="incident-list">{data.incidents.map(incident => <article className="incident-row" key={incident.id}><div className="incident-heading"><Badge tone={incident.severity === 'critical' ? 'red' : 'amber'}>{incident.severity === 'critical' ? '严重' : '警告'}</Badge><h3>{incident.title}</h3><Badge tone={incident.status === 'resolved' ? 'teal' : 'neutral'}>{incidentLabels[incident.status]}</Badge></div><p>{incident.detail}</p><footer><span>{data.projects.find(project => project.id === incident.projectId)?.name ?? '未知项目'} · {formatDate(incident.createdAt)}</span><button className="text-button" onClick={() => editIncident(incident)}>更新状态<Icon name="arrow" size={14} /></button></footer></article>)}</div>}</section></>;
}

const auditLabels: Record<string, string> = {
  'auth.setup': '初始化管理员', 'auth.login': '管理员登录', 'auth.logout': '管理员退出',
  'employee.created': '创建员工', 'employee.updated': '更新员工', 'project.created': '创建项目',
  'task.created': '创建任务', 'task.started': '启动任务', 'task.cancelled': '取消任务', 'task.revised': '修订目标',
  'task.approved': '批准任务', 'task.rejected': '驳回任务', 'monitor.created': '添加观察端点',
  'monitor.checked': '检查端点', 'incident.updated': '更新事件',
};
function Audit({ data }: { data: Dashboard }) {
  const [query, setQuery] = useState('');
  const events = [...data.audit].filter(event => `${event.actor} ${event.action} ${event.detail} ${event.targetId ?? ''}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return <><div className="view-toolbar"><div className="search-field"><Icon name="search" size={18} /><input aria-label="搜索审计记录" placeholder="搜索操作、参与者或详情…" value={query} onChange={event => setQuery(event.target.value)} /></div><span className="toolbar-count">{events.length} 条记录</span><Badge>只读记录</Badge></div><section className="panel">{!events.length ? <Empty icon="audit" title={data.audit.length ? '没有匹配的审计记录' : '尚无审计记录'} description="此处仅展示服务端已记录的操作，不生成示例事件。" /> : <div className="table-scroll"><table className="data-table audit-table"><thead><tr><th>时间</th><th>操作</th><th>参与者</th><th>对象 / 详情</th></tr></thead><tbody>{events.map(event => <tr key={event.id}><td className="nowrap muted">{formatDate(event.createdAt)}</td><td><strong>{auditLabels[event.action] ?? event.action}</strong>{auditLabels[event.action] && <small className="table-subtitle">{event.action}</small>}</td><td>{event.actor}</td><td className="audit-detail">{event.targetId && <code>{event.targetId}</code>}<p>{event.detail || '无补充详情'}</p></td></tr>)}</tbody></table></div>}</section></>;
}

function EmployeeSelect({ data, name, roles, projectId, defaultValue = '', required = false, placeholder = '未指定' }: { data: Dashboard; name: string; roles?: Role[]; projectId?: string; defaultValue?: string; required?: boolean; placeholder?: string }) {
  const options = data.employees.filter(employee => (employee.enabled && (!roles || roles.includes(employee.role)) && (projectId === undefined || employee.projectIds.includes(projectId))) || employee.id === defaultValue);
  return <select name={name} required={required} defaultValue={defaultValue}><option value="">{placeholder}</option>{options.map(employee => <option key={employee.id} value={employee.id} disabled={!employee.enabled}>{employee.name} · {roleLabels[employee.role]}{!employee.enabled ? '（已停用）' : ''}</option>)}</select>;
}
function EntityEditor({ editor, data, onClose, saved }: { editor: Editor; data: Dashboard; onClose: () => void; saved: (message: string) => void }) {
  const [selectedProject, setSelectedProject] = useState(editor.type === 'task' ? editor.projectId ?? data.projects[0]?.id ?? '' : '');
  if (editor.type === 'employee') {
    const employee = editor.employee;
    return <FormDialog title={employee ? '编辑员工' : '新增 AI 员工'} eyebrow="ORGANIZATION" onClose={onClose} submitLabel={employee ? '保存员工' : '创建员工'} onSubmit={async form => {
      await api(employee ? `/api/employees/${encodeURIComponent(employee.id)}` : '/api/employees', { method: employee ? 'PATCH' : 'POST', body: { name: text(form, 'name'), role: text(form, 'role'), duties: text(form, 'duties'), reportsTo: text(form, 'reportsTo') || null, projectIds: form.getAll('projectIds').map(String), enabled: form.get('enabled') === 'on' } });
      saved(employee ? '员工信息已保存。停用不会删除历史记录。' : '员工已创建，不会自动执行任务。');
    }}><div className="form-grid"><Field label="员工姓名"><input name="name" required maxLength={100} defaultValue={employee?.name} placeholder="例如：前端开发工程师" /></Field><Field label="角色"><select name="role" defaultValue={employee?.role ?? 'developer'}>{Object.entries(roleLabels).map(([role, label]) => <option key={role} value={role}>{label}</option>)}</select></Field></div><Field label="职责说明"><textarea name="duties" required rows={4} defaultValue={employee?.duties} placeholder="清楚描述负责范围、交付标准与协作要求。" /></Field><Field label="汇报对象"><select name="reportsTo" defaultValue={employee?.reportsTo ?? ''}><option value="">无 · 顶级角色</option>{data.employees.filter(item => item.id !== employee?.id && ['director', 'lead'].includes(item.role)).map(item => <option key={item.id} value={item.id}>{item.name} · {roleLabels[item.role]}</option>)}</select></Field><div className="field"><span className="field-label">参与项目</span>{data.projects.length ? <div className="checkbox-grid">{data.projects.map(project => <label className="checkbox-label" key={project.id}><input type="checkbox" name="projectIds" value={project.id} defaultChecked={employee?.projectIds.includes(project.id)} />{project.name}</label>)}</div> : <p className="field-hint">暂无项目；创建项目后可在此分配。</p>}</div><label className="checkbox-label enable-checkbox"><input type="checkbox" name="enabled" defaultChecked={employee?.enabled ?? true} /><span>启用员工<small>关闭后保留历史记录，不用于新任务分派。</small></span></label></FormDialog>;
  }
  if (editor.type === 'project') return <FormDialog title="新建演示项目" eyebrow="PROJECT WORKSPACE" onClose={onClose} submitLabel="创建项目" onSubmit={async form => { await api('/api/projects', { method: 'POST', body: { name: text(form, 'name'), description: text(form, 'description'), leadId: text(form, 'leadId') || null } }); saved('项目已创建。下一步请到「组织员工」编辑开发与测试员工，勾选该项目后即可派工。'); }}><div className="notice notice-warning"><Icon name="shield" /><span>仅创建新的演示工作区。不连接现有生产项目，不支持指定任意本机路径。</span></div><Field label="项目名称"><input name="name" required maxLength={100} placeholder="例如：产品介绍页演示" /></Field><Field label="项目说明"><textarea name="description" required rows={4} placeholder="描述项目的目的、范围与预期结果。" /></Field><Field label="项目负责人"><EmployeeSelect data={data} name="leadId" roles={['director', 'lead']} /></Field></FormDialog>;
  if (editor.type === 'task') {
    const missing = !selectedProject || !([['director', 'lead'], ['developer'], ['qa']] as Role[][]).every(roles => data.employees.some(employee => roles.includes(employee.role) && employee.enabled && employee.projectIds.includes(selectedProject)));
    return <FormDialog title="创建研发任务" eyebrow="TASK COMMAND" onClose={onClose} submitLabel="创建任务，不立即执行" disabled={missing} wide onSubmit={async form => { await api('/api/tasks', { method: 'POST', body: { title: text(form, 'title'), goal: text(form, 'goal'), projectId: text(form, 'projectId'), leaderId: text(form, 'leaderId'), developerId: text(form, 'developerId'), qaId: text(form, 'qaId') } }); saved('任务已创建。进入任务详情，由你手动选择模拟或真实执行。'); }}><div className="notice notice-info"><Icon name="shield" /><span>创建只保存目标与分工，不会自动运行。测试员工与开发员工独立，审批始终由人决定。</span></div>{missing && <ErrorNotice message="请先选择项目，并在「组织员工 → 编辑 → 参与项目」为该项目授权负责人、开发工程师与质量工程师。新建项目仅自动授权所选负责人。" />}<Field label="任务标题"><input name="title" required maxLength={150} placeholder="一句话描述要交付的成果" /></Field><Field label="目标与验收标准" hint="建议写清页面行为、边界条件和可验证的完成标准。"><textarea name="goal" required rows={5} placeholder="要解决什么问题？完成后如何验证？" /></Field><Field label="所属项目"><select name="projectId" required value={selectedProject} onChange={event => setSelectedProject(event.target.value)}><option value="">请选择项目</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field><div className="form-grid form-grid-three" key={selectedProject}><Field label="项目负责人"><EmployeeSelect data={data} name="leaderId" projectId={selectedProject} required roles={['director', 'lead']} placeholder="选择已授权负责人" /></Field><Field label="开发工程师"><EmployeeSelect data={data} name="developerId" projectId={selectedProject} required roles={['developer']} placeholder="选择已授权开发员工" /></Field><Field label="独立测试员工"><EmployeeSelect data={data} name="qaId" projectId={selectedProject} required roles={['qa']} placeholder="选择已授权质量员工" /></Field></div></FormDialog>;
  }
  if (editor.type === 'monitor') return <FormDialog title="添加观察端点" eyebrow="OPERATIONS OBSERVATION" onClose={onClose} submitLabel="添加端点" disabled={!data.projects.length} onSubmit={async form => { await api('/api/monitors', { method: 'POST', body: { projectId: text(form, 'projectId'), url: text(form, 'url'), intervalSeconds: Number(form.get('intervalSeconds')) } }); saved('观察端点已添加。可手动检查并查看服务端返回结果。'); }}><div className="notice notice-info"><Icon name="shield" /><span>只接受服务端批准的公共或本机 HTTP(S) 端点。不提供生产部署与健康保障。</span></div>{!data.projects.length && <ErrorNotice message="请先创建一个项目，再添加观察端点。" />}<Field label="关联项目"><select name="projectId" required defaultValue=""><option value="">请选择项目</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field><Field label="观察地址" hint="地址、端口与重定向策略由服务端检查。"><input name="url" type="url" required placeholder="https://example.com/health" /></Field><Field label="观察间隔（秒）" hint="允许范围为 30–3600 秒，实际调度由服务端控制。"><input name="intervalSeconds" type="number" min={30} max={3600} step={1} required defaultValue={60} /></Field></FormDialog>;
  return <FormDialog title="更新事件状态" eyebrow="INCIDENT" onClose={onClose} submitLabel="记录状态变更" onSubmit={async form => { await api(`/api/incidents/${encodeURIComponent(editor.incident.id)}`, { method: 'PATCH', body: { status: text(form, 'status') } }); saved('事件状态已记录。该操作不会自动修复服务。'); }}><p className="form-context">{editor.incident.title}</p><Field label="处理状态"><select name="status" defaultValue={editor.incident.status === 'resolved' ? 'resolved' : 'acknowledged'}><option value="acknowledged">已确认</option><option value="resolved">已解决</option></select></Field><p className="field-hint">更新状态只记录处理进展，不会自动修复端点或部署应用。</p></FormDialog>;
}
