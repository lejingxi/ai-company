import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { Dashboard, Role, SkillAvailability, SkillCatalog, SkillContent, SkillDetail, SkillDraft, SkillSource, SkillUsePolicy, SkillVersion } from '../shared/types';
import { api, ApiError, errorMessage } from './api';
import { Badge, Empty, ErrorNotice, Field, formatDate, Icon, Loading, Modal, ModeBadge, roleLabels } from './ui';

export type SkillSelection = { kind: 'draft' | 'version'; id: string };
export type SkillEvidenceLink = { taskId: string; initialTab: 'runs' | 'tests'; focusRecordId: string };
type SkillRecord = SkillDraft | SkillVersion;
const policyLabels: Record<SkillUsePolicy, string> = { simulation_only: '仅限模拟演练', manual_unverified: '人工编写 · 未经验证', task_observation: '任务观察 · 非验证保证' };
const outcomeLabels: Record<SkillSource['outcome'], string> = { manual: '人工录入 · 未验证', passed: '通过', failed: '失败', blocked: '阻塞', cancelled: '取消', interrupted: '中断', unknown: '结果未知' };
const draftLabels: Record<SkillDraft['status'], string> = { draft: '待人工审核', rejected: '已驳回', published: '已发布' };
const isVersion = (value: SkillRecord): value is SkillVersion => 'version' in value;
const versionEnabled = (id: string, availability: SkillAvailability[]) => availability.find(item => item.versionId === id)?.enabled === true;
const projectNames = (ids: string[], data: Dashboard) => ids.map(id => data.projects.find(project => project.id === id)?.name ?? id).join('、') || '未设置';
const simulationOnly = (record: SkillRecord) => record.usePolicy === 'simulation_only' || record.source.mode === 'simulation';
const restrictionLabel = (record: SkillRecord) => simulationOnly(record) ? policyLabels.simulation_only : policyLabels[record.usePolicy];
const lines = (value: string) => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

function useSkillCatalog() {
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    let controller: AbortController | null = null;
    const load = async () => {
      if (pending || disposed) return;
      pending = true; controller = new AbortController();
      try {
        const next = await api<SkillCatalog>('/api/skills', { signal: controller.signal });
        if (!disposed) { setCatalog(next); setError(''); }
      } catch (err) { if (!disposed && !controller.signal.aborted) setError(errorMessage(err)); }
      finally { pending = false; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => { disposed = true; window.clearInterval(timer); controller?.abort(); };
  }, [revision]);
  return { catalog, error, refresh: () => setRevision(value => value + 1) };
}

function SkillTabs<T extends string>({ value, items, onChange, label }: { value: T; items: { id: T; label: string }[]; onChange: (value: T) => void; label: string }) {
  return <div className="detail-tabs skill-tabs" role="tablist" aria-label={label}>{items.map((item, index) => <button key={item.id} type="button" role="tab" aria-selected={value === item.id} tabIndex={value === item.id ? 0 : -1} onClick={() => onChange(item.id)} onKeyDown={event => {
    const next = event.key === 'ArrowRight' ? (index + 1) % items.length : event.key === 'ArrowLeft' ? (index + items.length - 1) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); onChange(items[next].id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }}>{item.label}</button>)}</div>;
}

function PolicyNotice({ record }: { record: SkillRecord }) {
  return <div className={`notice ${simulationOnly(record) ? 'notice-warning simulation-warning' : record.source.kind === 'manual' || record.usePolicy === 'manual_unverified' ? 'notice-warning' : 'notice-info'}`}><Icon name="shield" /><span><strong>{restrictionLabel(record)}</strong><br />{simulationOnly(record) ? '此技能源自模拟，不是真实测试证据。人工发布后仍限定仅演练，不得宣称已经真实验证。' : record.source.kind === 'manual' || record.usePolicy === 'manual_unverified' ? '手工知识尚未经过关联运行与测试验证；人工审核不等于执行验证。' : '记录的是该次任务的观察与局限，不保证在其他任务有效。'} 技能只提供内部知识，不授予执行、合并或发布权限。</span></div>;
}

export default function Skills({ data, open, create }: { data: Dashboard; open: (selection: SkillSelection) => void; create: () => void }) {
  const [tab, setTab] = useState<'versions' | 'drafts'>('versions');
  const [query, setQuery] = useState('');
  const [employeeId, setEmployeeId] = useState('all');
  const [projectId, setProjectId] = useState('all');
  const [role, setRole] = useState('all');
  const [status, setStatus] = useState('all');
  const records: SkillRecord[] = tab === 'versions' ? data.skillVersions ?? [] : data.skillDrafts ?? [];
  const assignments = data.skillAssignments ?? [];
  const availability = data.skillAvailability ?? [];
  const visible = records.filter(item => {
    const employeeMatch = employeeId === 'all' || item.source.employeeId === employeeId || (isVersion(item) && assignments.some(pin => pin.employeeId === employeeId && pin.versionId === item.id));
    const statusMatch = status === 'all' || (isVersion(item) ? (status === 'enabled') === versionEnabled(item.id, availability) : item.status === status);
    const search = [item.content.title, item.content.purpose, item.content.conditions, ...item.content.tags, item.skillId, item.id].join(' ').toLowerCase();
    return employeeMatch && (projectId === 'all' || (projectId === 'manual' ? item.source.kind === 'manual' : item.source.projectId === projectId)) && (role === 'all' || item.roles.includes(role as Role)) && statusMatch && search.includes(query.toLowerCase().trim());
  }).sort((a, b) => (isVersion(b) ? b.publishedAt : b.updatedAt).localeCompare(isVersion(a) ? a.publishedAt : a.updatedAt));
  return <>
    <div className="notice notice-info"><Icon name="shield" /><span>经验先进入草稿，必须由人审核后发布不可变版本，再显式分配给员工和项目。新版本不会自动升级已有配置；技能审核与任务合并 / 发布审批相互独立。</span></div>
    <SkillTabs value={tab} items={[{ id: 'versions', label: `已发布技能 (${data.skillVersions?.length ?? 0})` }, { id: 'drafts', label: `经验草稿 (${data.skillDrafts?.length ?? 0})` }]} label="技能库分类" onChange={next => { setTab(next); setStatus('all'); }} />
    <div className="view-toolbar skill-toolbar"><div className="search-field"><Icon name="search" size={18} /><input aria-label="搜索技能" placeholder="搜索标题、用途、标签或 ID…" value={query} onChange={event => setQuery(event.target.value)} /></div><select aria-label="按来源或已配置员工筛选技能" value={employeeId} onChange={event => setEmployeeId(event.target.value)}><option value="all">全部员工（来源 / 已配置）</option>{data.employees.map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select><select aria-label="按来源项目筛选技能" value={projectId} onChange={event => setProjectId(event.target.value)}><option value="all">全部来源项目</option><option value="manual">人工录入（无任务来源）</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><select aria-label="按适用角色筛选技能" value={role} onChange={event => setRole(event.target.value)}><option value="all">全部适用角色</option>{Object.entries(roleLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><select aria-label="按技能状态筛选" value={status} onChange={event => setStatus(event.target.value)}><option value="all">全部状态</option>{(tab === 'versions' ? [['enabled', '可配置'], ['disabled', '已停用']] : Object.entries(draftLabels)).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><span className="toolbar-count">{visible.length} 条记录</span></div>
    {!visible.length ? <section className="panel"><Empty icon="file" title={records.length ? '没有匹配的技能' : tab === 'versions' ? '还没有已发布技能' : '还没有经验草稿'} description={records.length ? '调整员工、来源项目、角色、状态或搜索条件。' : '可人工新建草稿，或等待服务端从运行经验中提取。打开页面不会生成技能、发布或配置员工。'} action={!records.length && <button className="button button-primary" onClick={create}>新建技能草稿</button>} /></section> : <div className="skill-list">{visible.map(item => <article className="panel skill-card" key={item.id}><header><div><button className="table-title" onClick={() => open({ kind: isVersion(item) ? 'version' : 'draft', id: item.id })}>{item.content.title}</button><p>{item.content.purpose}</p></div><Badge tone={isVersion(item) ? versionEnabled(item.id, availability) ? 'teal' : 'neutral' : item.status === 'rejected' ? 'red' : 'amber'}>{isVersion(item) ? versionEnabled(item.id, availability) ? '可配置' : '已停用' : draftLabels[item.status]}</Badge></header><div className="skill-card-row"><Badge>{isVersion(item) ? `固定版本 v${item.version}` : `草稿 r${item.revision}`}</Badge><Badge tone={item.source.outcome === 'failed' || item.source.outcome === 'blocked' ? 'red' : 'neutral'}>{item.source.mode === 'simulation' ? '模拟结果：' : '来源结果：'}{outcomeLabels[item.source.outcome]}</Badge><Badge tone={simulationOnly(item) || item.usePolicy === 'manual_unverified' ? 'amber' : 'indigo'}>{restrictionLabel(item)}</Badge></div><dl className="skill-card-meta"><div><dt>来源</dt><dd>{item.source.kind === 'manual' ? '人工录入 · 无运行验证' : `${data.employees.find(employee => employee.id === item.source.employeeId)?.name ?? item.source.employeeId ?? '员工未知'} / ${data.projects.find(project => project.id === item.source.projectId)?.name ?? item.source.projectId ?? '项目未知'} / ${item.source.taskVersion == null ? '任务版本未知' : `任务 v${item.source.taskVersion}`}`}</dd></div><div><dt>适用范围</dt><dd>{item.roles.map(value => roleLabels[value]).join('、') || '无角色'} · {projectNames(item.projectIds, data)}</dd></div></dl><footer><code title={item.contentHash}>{item.contentHash.slice(0, 16)}…</code><span>{isVersion(item) ? `${assignments.filter(pin => pin.versionId === item.id).length} 位员工固定配置` : item.status === 'published' ? '已发布，请到正式版本配置员工' : '未发布的知识不可分配'}</span><button className="text-button" onClick={() => open({ kind: isVersion(item) ? 'version' : 'draft', id: item.id })}>查看详情<Icon name="chevron" size={15} /></button></footer></article>)}</div>}
  </>;
}

interface DraftFields extends Omit<SkillContent, 'steps' | 'cautions' | 'tags'> { steps: string; cautions: string; tags: string; roles: Role[]; projectIds: string[]; }
const emptyFields = (): DraftFields => ({ title: '', purpose: '', conditions: '', steps: '', cautions: '', verification: '', tags: '', roles: [], projectIds: [] });
const draftFields = (draft: SkillDraft): DraftFields => ({ ...draft.content, steps: draft.content.steps.join('\n'), cautions: draft.content.cautions.join('\n'), tags: draft.content.tags.join('\n'), roles: [...draft.roles], projectIds: [...draft.projectIds] });
function draftPayload(value: DraftFields) {
  const content: SkillContent = { title: value.title.trim(), purpose: value.purpose.trim(), conditions: value.conditions.trim(), steps: lines(value.steps), cautions: lines(value.cautions), verification: value.verification.trim(), tags: lines(value.tags) };
  if (!content.title || !content.purpose || !content.conditions || !content.steps.length || !content.verification) throw new Error('请填写标题、用途、适用条件、至少一个步骤与验证方法。');
  if (!value.roles.length || !value.projectIds.length) throw new Error('请至少选择一个适用角色和一个项目。');
  return { content, roles: value.roles, projectIds: value.projectIds };
}
function DraftFormFields({ value, onChange, data }: { value: DraftFields; onChange: (value: DraftFields) => void; data: Dashboard }) {
  const update = <K extends keyof DraftFields,>(key: K, next: DraftFields[K]) => onChange({ ...value, [key]: next });
  return <>
    <Field label="技能标题"><input required value={value.title} onChange={event => update('title', event.target.value)} /></Field>
    <Field label="用途"><textarea required rows={3} value={value.purpose} onChange={event => update('purpose', event.target.value)} /></Field>
    <Field label="适用条件"><textarea required rows={3} value={value.conditions} onChange={event => update('conditions', event.target.value)} /></Field>
    <div className="form-grid"><Field label="操作步骤" hint="每行一个步骤，仅为知识文本，不会执行。"><textarea required rows={6} value={value.steps} onChange={event => update('steps', event.target.value)} /></Field><Field label="注意事项" hint="每行一项；来源限制由服务端保留，不可在此修改。"><textarea rows={6} value={value.cautions} onChange={event => update('cautions', event.target.value)} /></Field></div>
    <Field label="验证方法" hint="说明如何验证，不代表验证已经发生。"><textarea required rows={3} value={value.verification} onChange={event => update('verification', event.target.value)} /></Field>
    <Field label="标签" hint="每行一个标签，可留空。"><textarea rows={2} value={value.tags} onChange={event => update('tags', event.target.value)} /></Field>
    <fieldset className="skill-choices"><legend className="field-label">适用角色（至少一个）</legend><div className="checkbox-grid">{(Object.keys(roleLabels) as Role[]).map(role => <label className="checkbox-label" key={role}><input type="checkbox" checked={value.roles.includes(role)} onChange={event => update('roles', event.target.checked ? [...value.roles, role] : value.roles.filter(item => item !== role))} />{roleLabels[role]}</label>)}</div></fieldset>
    <fieldset className="skill-choices"><legend className="field-label">适用项目（至少一个）</legend>{data.projects.length ? <div className="checkbox-grid">{data.projects.map(project => <label className="checkbox-label" key={project.id}><input type="checkbox" checked={value.projectIds.includes(project.id)} onChange={event => update('projectIds', event.target.checked ? [...value.projectIds, project.id] : value.projectIds.filter(id => id !== project.id))} />{project.name}</label>)}</div> : <p className="field-hint">暂无项目，先创建项目后再保存技能草稿。</p>}{value.projectIds.filter(id => !data.projects.some(project => project.id === id)).map(id => <label className="checkbox-label" key={id}><input type="checkbox" checked onChange={() => update('projectIds', value.projectIds.filter(item => item !== id))} />不可用项目 {id}（取消选择可移除）</label>)}</fieldset>
  </>;
}

export function NewSkillDraft({ data, onClose, onCreated }: { data: Dashboard; onClose: () => void; onCreated: (draft: SkillDraft) => void }) {
  const [value, setValue] = useState(emptyFields);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy) return;
    setError('');
    const controller = new AbortController(); request.current = controller;
    try {
      const body = draftPayload(value); setBusy(true);
      const draft = await api<SkillDraft>('/api/skills/drafts', { method: 'POST', body, signal: controller.signal });
      if (!controller.signal.aborted) onCreated(draft);
    } catch (err) { if (!controller.signal.aborted) setError(errorMessage(err)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  return <Modal title="新建技能草稿" eyebrow="MANUAL KNOWLEDGE / 人工知识" onClose={onClose} busy={busy} wide><form onSubmit={submit}><div className="modal-body"><div className="notice notice-warning"><Icon name="shield" /><span><strong>人工编写 · 未经验证</strong><br />只创建未审核草稿。来源、限制与发布信息由服务端生成，不可编辑；不会自动发布或配置给员工。</span></div><fieldset className="form-fields" disabled={busy}><DraftFormFields value={value} onChange={setValue} data={data} /></fieldset>{error && <ErrorNotice message={error} />}</div><footer className="modal-footer"><button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="button button-primary" disabled={busy || !data.projects.length}>{busy ? '保存中…' : '创建草稿，不发布'}</button></footer></form></Modal>;
}

function SkillBody({ record, data }: { record: SkillRecord; data: Dashboard }) {
  return <>
    <div className="detail-section"><h3>用途</h3><p className="preserve-lines">{record.content.purpose}</p></div>
    <div className="detail-section"><h3>适用条件</h3><p className="preserve-lines">{record.content.conditions}</p></div>
    <div className="detail-section"><h3>操作步骤</h3><ol className="skill-content-list">{record.content.steps.map((step, index) => <li key={index}>{step}</li>)}</ol></div>
    <div className="detail-section"><h3>注意事项</h3>{record.content.cautions.length ? <ul className="skill-content-list">{record.content.cautions.map((caution, index) => <li key={index}>{caution}</li>)}</ul> : <p className="muted">未填写注意事项，不代表没有使用限制。</p>}</div>
    <div className="detail-section"><h3>验证方法（不是已验证结论）</h3><p className="preserve-lines">{record.content.verification}</p></div>
    <div className="skill-card-row">{record.content.tags.map((tag, index) => <Badge key={index}>{tag}</Badge>)}</div>
    <dl className="detail-metadata"><div><dt>适用角色</dt><dd>{record.roles.map(role => roleLabels[role]).join('、')}</dd></div><div><dt>适用项目</dt><dd>{projectNames(record.projectIds, data)}</dd></div><div><dt>技能 ID</dt><dd><code>{record.skillId}</code></dd></div><div><dt>记录 ID</dt><dd><code>{record.id}</code></dd></div><div><dt>内容哈希</dt><dd><code className="full-hash">{record.contentHash}</code></dd></div><div><dt>{isVersion(record) ? '人工发布人 / 时间' : '创建者 / 更新时间'}</dt><dd>{isVersion(record) ? `${record.publishedBy} / ${formatDate(record.publishedAt)}` : `${record.createdBy} / ${formatDate(record.updatedAt)}`}</dd></div></dl>
  </>;
}
function SkillSourceEvidence({ detail, record, openEvidence }: { detail: SkillDetail; record: SkillRecord; openEvidence: (link: SkillEvidenceLink) => void }) {
  const source = record.source;
  // Use only the exact linked records returned by this detail response, never current task evidence.
  const run = detail.run?.id === source.runId && detail.run.taskId === source.taskId ? detail.run : null;
  const tests = detail.tests.filter(test => source.testIds.includes(test.id) && test.taskId === source.taskId);
  return <>
    <p className="field-hint">以下为此知识来源的固定关联，不会用任务最新一次运行或测试替代。</p>
    <dl className="detail-metadata"><div><dt>来源类别 / 结果</dt><dd>{source.kind === 'manual' ? '人工录入' : '任务经验'} / {source.mode === 'simulation' ? '模拟 ' : ''}{outcomeLabels[source.outcome]}</dd></div><div><dt>任务 ID / 来源任务版本</dt><dd><code>{source.taskId ?? '无关联任务'}</code><br />{source.taskVersion == null ? '任务版本未知（未记录，不能推定当前版本）' : `v${source.taskVersion}`}</dd></div><div><dt>batchId</dt><dd><code>{source.batchId ?? '未记录'}</code></dd></div><div><dt>employeeId</dt><dd><code>{source.employeeId ?? '无来源员工'}</code></dd></div><div><dt>projectId</dt><dd><code>{source.projectId ?? '无来源项目'}</code></dd></div><div><dt>stage / mode</dt><dd>{source.stage ?? '未记录'} / {source.mode === 'simulation' ? 'simulation · 仅模拟' : source.mode ?? '未执行'}</dd></div><div><dt>runId</dt><dd>{source.runId && source.taskId ? <button className="text-button skill-record-link" onClick={() => openEvidence({ taskId: source.taskId!, initialTab: 'runs', focusRecordId: source.runId! })}>{source.runId}</button> : '无关联运行'}</dd></div><div><dt>testIds</dt><dd>{source.testIds.length ? source.testIds.map(id => source.taskId ? <button className="text-button skill-record-link" key={id} onClick={() => openEvidence({ taskId: source.taskId!, initialTab: 'tests', focusRecordId: id })}>{id}</button> : <code key={id}>{id}</code>) : '无关联测试'}</dd></div><div><dt>证据哈希</dt><dd><code className="full-hash">{source.evidenceHash || '未记录'}</code></dd></div></dl>
    <div className="detail-section"><h3>来源局限（不可编辑）</h3>{source.limitations.length ? <ul className="skill-content-list">{source.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="muted">服务端未记录额外局限，不表示没有风险或已完成真实验证。</p>}</div>
    {source.kind === 'manual' && <p className="muted">人工草稿没有自动推断的运行或测试证据。</p>}
    {source.runId && !run && <ErrorNotice message={`关联运行 ${source.runId} 不可用。不会替换为当前任务的其他运行。`} />}
    {run && <article className="evidence-card"><header><h3>精确关联运行</h3><ModeBadge mode={run.mode} /></header><p><code>{run.id}</code> · {run.status} · {run.taskVersion == null ? '历史任务版本未知' : `任务 v${run.taskVersion}`}</p><p>退出码 {run.exitCode ?? '未返回'} · {formatDate(run.startedAt)}</p>{run.error && <ErrorNotice message={run.error} />}<details className="log-details"><summary>来源运行输出（只读）{run.outputTruncated ? ' · 输出已截断' : ''}</summary><pre className="log-output">{run.output || '技能详情不复制运行日志，请点击上方 runId 跳转原始记录。'}</pre></details></article>}
    {source.testIds.filter(id => !tests.some(test => test.id === id)).map(id => <ErrorNotice key={id} message={`关联测试 ${id} 不可用，不推定已通过。`} />)}
    {tests.map(test => <article className="evidence-card section-gap" key={test.id}><header><h3>{test.mode === 'simulation' ? '模拟测试 · 非真实验证' : '精确关联测试'}</h3><ModeBadge mode={test.mode} /></header><p><code>{test.id}</code> · {test.status} · {test.taskVersion == null ? '历史任务版本未知' : `任务 v${test.taskVersion}`}</p><p>{test.mode === 'simulation' ? '模拟' : '真实进程'}退出码 {test.exitCode ?? '未返回'} · {formatDate(test.createdAt)}</p><code className="full-hash">{test.contentHash}</code><details className="log-details"><summary>来源测试日志（只读）</summary><pre className="log-output">{test.log || '技能详情不复制测试日志，请点击上方 testId 跳转原始记录。'}</pre></details></article>)}
  </>;
}
function SkillDiff({ record, base, data }: { record: SkillRecord; base: SkillVersion | null; data: Dashboard }) {
  if (!base) return <Empty icon="file" title={record.baseVersionId ? '基础版本不可用' : '首个版本，没有对比基线'} description={record.baseVersionId ? `未返回基础版本 ${record.baseVersionId}，不会与最新版本猜测比较。` : '这里仅比较明确关联的基础版本，不推测其他技能或任务内容。'} />;
  const fields: [string, string, string][] = [
    ['标题', base.content.title, record.content.title], ['用途', base.content.purpose, record.content.purpose], ['适用条件', base.content.conditions, record.content.conditions],
    ['操作步骤', base.content.steps.join('\n'), record.content.steps.join('\n')], ['注意事项', base.content.cautions.join('\n'), record.content.cautions.join('\n')], ['验证方法', base.content.verification, record.content.verification],
    ['标签', base.content.tags.join('\n'), record.content.tags.join('\n')], ['角色', base.roles.map(role => roleLabels[role]).join('、'), record.roles.map(role => roleLabels[role]).join('、')], ['项目', projectNames(base.projectIds, data), projectNames(record.projectIds, data)],
  ];
  const changed = fields.filter(([, before, after]) => before !== after);
  return <><p className="field-hint">对比固定基础版本 v{base.version} · {base.id}；下面只展示变化字段。</p><code className="full-hash">基础哈希 {base.contentHash}</code>{changed.length ? changed.map(([label, before, after]) => <section key={label} className="skill-diff-field"><h3>{label}</h3><div className="form-grid"><div><h4>基础版本</h4><p className="preserve-lines skill-diff-before">{before || '（空）'}</p></div><div><h4>当前{isVersion(record) ? '版本' : '草稿'}</h4><p className="preserve-lines skill-diff-after">{after || '（空）'}</p></div></div></section>) : <p className="subtle-note">正文和适用范围与基础版本相同。来源限制仍然保留。</p>}</>;
}

export function SkillDetailDialog({ selection, data, onClose, onChanged, onSelect, openEvidence }: { selection: SkillSelection; data: Dashboard; onClose: () => void; onChanged: () => void; onSelect: (selection: SkillSelection) => void; openEvidence: (link: SkillEvidenceLink) => void }) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loadError, setLoadError] = useState('');
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState<'body' | 'source' | 'diff' | 'reviews'>('body');
  // Local edits deliberately live apart from the five-second server snapshot.
  const [edit, setEdit] = useState<{ base: SkillDraft; value: DraftFields } | null>(null);
  const [review, setReview] = useState<{ action: 'publish' | 'reject'; draft: SkillDraft; note: string; confirmed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState('');
  const request = useRef<AbortController | null>(null);
  const endpoint = `/api/skills/${selection.kind === 'draft' ? 'drafts' : 'versions'}/${encodeURIComponent(selection.id)}`;
  useEffect(() => {
    let disposed = false; let pending = false; let controller: AbortController | null = null;
    const load = async () => {
      if (disposed || pending) return;
      pending = true; controller = new AbortController();
      try {
        const next = await api<SkillDetail>(endpoint, { signal: controller.signal });
        const target = selection.kind === 'draft' ? next.draft : next.version;
        if (!target || target.id !== selection.id) throw new Error('服务未返回请求的技能详情，请重试。');
        if (!disposed) { setDetail(next); setLoadError(''); }
      }
      catch (err) { if (!disposed && !controller.signal.aborted) setLoadError(errorMessage(err)); }
      finally { pending = false; }
    };
    void load(); const timer = window.setInterval(() => void load(), 5_000);
    return () => { disposed = true; window.clearInterval(timer); controller?.abort(); };
  }, [endpoint, revision]);
  useEffect(() => () => request.current?.abort(), []);
  const record = selection.kind === 'draft' ? detail?.draft : detail?.version;
  const draft = detail?.draft;
  const staleEdit = Boolean(edit && draft && (draft.revision !== edit.base.revision || draft.contentHash !== edit.base.contentHash || draft.status !== edit.base.status));
  const staleReview = Boolean(review && draft && (draft.revision !== review.draft.revision || draft.contentHash !== review.draft.contentHash || draft.status !== review.draft.status));
  const refresh = () => setRevision(value => value + 1);
  const mutate = async (work: (signal: AbortSignal) => Promise<void>) => {
    if (busy) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setActionError(''); setNotice('');
    try { await work(controller.signal); if (!controller.signal.aborted) { refresh(); onChanged(); } }
    catch (err) {
      if (!controller.signal.aborted) { setActionError(errorMessage(err)); if (err instanceof ApiError && err.status === 409) { setConflict(true); refresh(); } }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!edit || staleEdit || conflict || loadError || !draft || draft.status === 'published') return;
    void mutate(async signal => {
      await api<SkillDraft>(endpoint, { method: 'PATCH', body: { expectedRevision: edit.base.revision, expectedHash: edit.base.contentHash, ...draftPayload(edit.value) }, signal });
      if (!signal.aborted) { setEdit(null); setNotice('草稿已保存，尚未发布。'); }
    });
  };
  const decide = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!review || !review.confirmed || !review.note.trim() || staleReview || conflict || loadError || draft?.status !== 'draft') return;
    void mutate(async signal => {
      const result = await api<SkillVersion | SkillDraft>(`${endpoint}/${review.action}`, { method: 'POST', body: { expectedRevision: review.draft.revision, expectedHash: review.draft.contentHash, note: review.note.trim() }, signal });
      if (signal.aborted) return;
      setReview(null);
      if (review.action === 'publish') onSelect({ kind: 'version', id: result.id });
      else setNotice('驳回已记录，未发布或配置给员工。');
    });
  };
  const beginReview = (action: 'publish' | 'reject') => {
    if (!draft || draft.status !== 'draft') return;
    setConflict(false); setActionError(''); setReview({ action, draft, note: '', confirmed: false });
  };
  const close = () => { if (!busy && (!edit || window.confirm('关闭将丢弃未保存的本地正文，确认关闭？'))) onClose(); };
  let body: ReactNode;
  if (!detail || !record) body = <div className="modal-body">{loadError ? <Empty icon="file" title="无法读取技能详情" description="重试读取，不会根据其他技能或当前任务推断内容。" /> : <Loading />}</div>;
  else if (edit) body = <form onSubmit={save}><div className="modal-body"><PolicyNotice record={edit.base} /><p className="field-hint">编辑基线 r{edit.base.revision} · {edit.base.contentHash}；自动刷新不会覆盖下方本地文本。</p>{(staleEdit || conflict) && <div className="notice notice-warning" role="alert"><Icon name="alert" /><span><strong>草稿已变化或发生冲突，本地文本完整保留。</strong><br />先刷新并核对服务端当前正文，再明确选择新的保存基线。不会自动重试写入。<div className="button-row"><button className="text-button" type="button" disabled={busy} onClick={refresh}>刷新服务端版本（保留文本）</button>{draft && draft.status !== 'published' && <button className="text-button" type="button" disabled={busy || Boolean(loadError)} onClick={() => { if (window.confirm('已核对服务端当前正文？下一次保存会使用最新修订号提交你保留的本地全文，不会自动合并。')) { setEdit({ ...edit, base: draft }); setConflict(false); setActionError(''); } }}>已核对，保留本地正文并采用最新基线</button>}</div></span></div>}{detail.draft && (staleEdit || conflict) && <details className="skill-conflict-copy" open><summary>服务端当前正文 · r{detail.draft.revision} · {draftLabels[detail.draft.status]}</summary><SkillBody record={detail.draft} data={data} /></details>}<fieldset className="form-fields" disabled={busy}><DraftFormFields data={data} value={edit.value} onChange={value => setEdit({ ...edit, value })} /></fieldset>{actionError && <ErrorNotice message={actionError} />}</div><footer className="modal-footer"><button type="button" className="button button-secondary" disabled={busy} onClick={() => { if (window.confirm('放弃尚未保存的本地编辑并返回详情？')) { setEdit(null); setConflict(false); setActionError(''); } }}>放弃编辑</button><button type="submit" className="button button-primary" disabled={busy || staleEdit || conflict || Boolean(loadError) || !draft || draft.status === 'published'}>{busy ? '保存中…' : '保存草稿，不发布'}</button></footer></form>;
  else body = <>
    <div className="detail-statusbar"><Badge>{isVersion(record) ? `不可变版本 v${record.version}` : `草稿 r${record.revision} · ${draftLabels[record.status]}`}</Badge>{isVersion(record) && <Badge tone={versionEnabled(record.id, data.skillAvailability ?? []) ? 'teal' : 'neutral'}>{versionEnabled(record.id, data.skillAvailability ?? []) ? '可配置' : '已停用'}</Badge>}<code title={record.contentHash}>{record.contentHash.slice(0, 16)}…</code></div>
    <SkillTabs value={tab} items={[{ id: 'body', label: '正文' }, { id: 'source', label: '来源证据' }, { id: 'diff', label: '版本差异' }, { id: 'reviews', label: '审核记录' }]} onChange={setTab} label="技能详情分类" />
    <div className="modal-body detail-body" role="tabpanel" aria-label={{ body: '正文', source: '来源证据', diff: '版本差异', reviews: '审核记录' }[tab]}><PolicyNotice record={record} />{notice && <div className="notice notice-success" role="status"><Icon name="check" /><span>{notice}</span></div>}{actionError && <ErrorNotice message={actionError} />}{detail.warnings.map((warning, index) => <div className="notice notice-warning" key={index}><Icon name="alert" /><span>{warning}</span></div>)}{!isVersion(record) && record.rejectionReason && <ErrorNotice message={`驳回原因：${record.rejectionReason}`} />}
      {tab === 'body' && <SkillBody record={record} data={data} />}
      {tab === 'source' && <SkillSourceEvidence detail={detail} record={record} openEvidence={openEvidence} />}
      {tab === 'diff' && <SkillDiff record={record} base={detail.baseVersion} data={data} />}
      {tab === 'reviews' && (detail.reviews.length ? <div className="evidence-list">{[...detail.reviews].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(item => <article className="evidence-card" key={item.id}><header><h3>{item.action === 'publish' ? '人工发布知识版本' : '人工驳回草稿'}</h3><Badge tone={item.action === 'publish' ? 'teal' : 'red'}>r{item.revision}</Badge></header><p>审核人 {item.userId} · {formatDate(item.createdAt)}</p><p className="preserve-lines">{item.note || '未记录备注'}</p><code className="full-hash">{item.contentHash}</code><p className="field-hint">草稿 {item.draftId}{item.versionId ? ` / 发布版本 ${item.versionId}` : ''} · 仅技能审核，不是任务合并或发布授权。</p></article>)}</div> : <Empty icon="approval" title="尚无技能审核记录" description="只有人工提交的发布或驳回决定会记录在这里，与任务审批分开。" />)}
    </div><footer className="modal-footer skill-detail-footer"><span className="detail-poll-note">每 5 秒只读同步</span><div className="button-row">{!isVersion(record) && record.status !== 'published' && <button className="button button-secondary" disabled={busy || Boolean(loadError)} onClick={() => { setEdit({ base: record, value: draftFields(record) }); setConflict(false); setActionError(''); }}>{record.status === 'rejected' ? '编辑后重新送审' : '编辑草稿'}</button>}{!isVersion(record) && record.status === 'draft' && <><button className="button button-danger-soft" disabled={busy || Boolean(loadError)} onClick={() => beginReview('reject')}>人工驳回</button><button className="button button-primary" disabled={busy || Boolean(loadError)} onClick={() => beginReview('publish')}>{simulationOnly(record) ? '人工审核发布（仅演练）' : '人工审核发布'}</button></>}{!isVersion(record) && record.publishedVersionId && <button className="button button-secondary" onClick={() => onSelect({ kind: 'version', id: record.publishedVersionId! })}>查看已发布版本</button>}{isVersion(record) && <><button className="button button-secondary" disabled={busy || Boolean(loadError)} onClick={() => { if (window.confirm('从此不可变版本创建新的修订草稿？现有员工配置不会自动升级。')) void mutate(async signal => { const next = await api<SkillDraft>(`${endpoint}/revise`, { method: 'POST', body: {}, signal }); if (!signal.aborted) onSelect({ kind: 'draft', id: next.id }); }); }}>创建修订草稿</button><button className="button button-secondary" disabled={busy || Boolean(loadError)} onClick={() => { const enabled = !versionEnabled(record.id, data.skillAvailability ?? []); if (window.confirm(enabled ? '恢复此版本的可配置状态？不会自动配置员工。' : '停用此版本？正文和历史快照不会改变，员工旧配置可单独移除。')) void mutate(async signal => { await api(`${endpoint}/availability`, { method: 'PATCH', body: { enabled }, signal }); if (!signal.aborted) setNotice(enabled ? '此版本已恢复可用，不会自动配置员工。' : '此版本已停用，历史记录保留。'); }); }}>{versionEnabled(record.id, data.skillAvailability ?? []) ? '停用此版本' : '恢复此版本'}</button></>}<button type="button" className="button button-secondary" disabled={busy} onClick={close}>关闭</button></div></footer>
  </>;
  return <><Modal title={edit ? '编辑技能草稿' : record?.content.title ?? '技能详情'} eyebrow="INTERNAL KNOWLEDGE / 不授予执行权限" onClose={close} wide busy={busy}>{loadError && <div className="detail-inline-error"><ErrorNotice message={`${loadError} 请重新读取后再修改。`} retry={refresh} /></div>}{body}</Modal>{review && <Modal title={review.action === 'publish' ? simulationOnly(review.draft) ? '确认人工发布 · 限定仅演练' : '确认人工发布知识版本' : '确认人工驳回草稿'} eyebrow="HUMAN REVIEW / 仅限人工审核" onClose={() => { if (!busy) { setReview(null); setConflict(false); setActionError(''); } }} busy={busy}><form onSubmit={decide}><div className="modal-body"><PolicyNotice record={review.draft} /><p className="preserve-lines">{review.draft.content.title}</p><p className="field-hint">本次审核固定草稿 r{review.draft.revision}，不可变内容摘要</p><code className="hash-block">{review.draft.contentHash}</code><p className="subtle-note">此操作不是任务合并 / 发布审批，不启动执行，不分配给员工。工作代理不能发布技能。</p>{(staleReview || conflict) && <ErrorNotice message="草稿已变化或审核冲突。备注已保留；请关闭此确认框，刷新并重新核对正文后再审核。" retry={refresh} />}{loadError && <ErrorNotice message={loadError} />}<fieldset disabled={busy} className="form-fields section-gap"><Field label={review.action === 'publish' ? '人工审核备注（必填）' : '驳回原因（必填）'}><textarea required rows={4} value={review.note} onChange={event => setReview({ ...review, note: event.target.value })} placeholder="说明核对结论与使用边界，不得将模拟描述为真实验证。" /></Field><label className="checkbox-label consent"><input type="checkbox" required checked={review.confirmed} onChange={event => setReview({ ...review, confirmed: event.target.checked })} />{review.action === 'reject' ? '我确认人工驳回此草稿并记录原因。' : simulationOnly(review.draft) ? '我已核对正文、来源证据与差异，确认发布后仍限定仅演练，不能作为真实验证或执行授权。' : '我已核对正文、来源证据与差异，确认仅发布内部知识不可变版本，不授予执行权限。'}</label></fieldset>{actionError && <ErrorNotice message={actionError} />}</div><footer className="modal-footer"><button type="button" className="button button-secondary" disabled={busy} onClick={() => { setReview(null); setConflict(false); setActionError(''); }}>返回核对</button><button type="submit" className={`button ${review.action === 'publish' ? 'button-primary' : 'button-danger'}`} disabled={busy || !review.confirmed || !review.note.trim() || staleReview || conflict || Boolean(loadError) || draft?.status !== 'draft'}>{busy ? '提交中…' : review.action === 'reject' ? '确认记录驳回' : simulationOnly(review.draft) ? '确认发布（仅演练）' : '确认发布知识版本'}</button></footer></form></Modal>}</>;
}

interface Pin { versionId: string; projectIds: string[]; }
export function EmployeeSkills({ employeeId, data, onClose, onSaved }: { employeeId: string; data: Dashboard; onClose: () => void; onSaved: () => void }) {
  const { catalog, error: loadError, refresh } = useSkillCatalog();
  const employee = data.employees.find(item => item.id === employeeId);
  const [pins, setPins] = useState<Pin[] | null>(null);
  const [baseline, setBaseline] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const serverPins = catalog?.assignments.filter(item => item.employeeId === employeeId) ?? [];
  const signature = JSON.stringify(serverPins.map(item => ({ versionId: item.versionId, projectIds: [...item.projectIds].sort() })).sort((a, b) => a.versionId.localeCompare(b.versionId)));
  useEffect(() => {
    if (!catalog || pins !== null) return;
    setPins(serverPins.map(item => ({ versionId: item.versionId, projectIds: [...item.projectIds] }))); setBaseline(signature);
  }, [catalog, pins, signature]);
  const changedElsewhere = pins !== null && signature !== baseline;
  const intersection = (version: SkillVersion) => employee ? version.projectIds.filter(id => employee.projectIds.includes(id) && data.projects.some(project => project.id === id)) : [];
  const eligible = (version: SkillVersion) => Boolean(employee?.enabled && version.roles.includes(employee.role) && intersection(version).length && versionEnabled(version.id, catalog?.availability ?? []));
  const selectable = catalog?.versions.filter(version => eligible(version) || pins?.some(pin => pin.versionId === version.id)) ?? [];
  const groups = [...new Set(selectable.map(version => version.skillId))].map(skillId => ({ skillId, versions: selectable.filter(version => version.skillId === skillId).sort((a, b) => b.version - a.version) }));
  const updatePin = (skillId: string, versionId: string) => {
    if (!pins || !catalog) return;
    const previous = pins.find(pin => catalog.versions.find(version => version.id === pin.versionId)?.skillId === skillId);
    const rest = pins.filter(pin => catalog.versions.find(version => version.id === pin.versionId)?.skillId !== skillId);
    if (!versionId) { setPins(rest); return; }
    const version = catalog.versions.find(item => item.id === versionId);
    if (!version || !eligible(version)) return;
    setPins([...rest, { versionId, projectIds: previous?.projectIds.filter(id => intersection(version).includes(id)) ?? [] }]);
  };
  const validation = (() => {
    if (!employee) return '员工已不可用。';
    if (!pins || !catalog) return '技能配置尚未载入。';
    if (!employee.enabled && pins.length > 0) return '员工已停用，只能撤销全部技能；请移除所有固定版本后保存空配置。';
    const skillIds = new Set<string>();
    for (const pin of pins) {
      const version = catalog.versions.find(item => item.id === pin.versionId);
      if (!version || !eligible(version)) return '存在已停用、角色不匹配或无共同项目的固定版本，请移除后保存。';
      if (skillIds.has(version.skillId)) return '同一技能不能同时配置两个版本。';
      skillIds.add(version.skillId);
      if (!pin.projectIds.length || pin.projectIds.some(id => !intersection(version).includes(id))) return '每个固定版本须明确选择至少一个员工与技能共同拥有的项目，移除失效项目后保存。';
    }
    return '';
  })();
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy || validation || loadError || changedElsewhere || !pins) return;
    const controller = new AbortController(); request.current = controller; setBusy(true); setError('');
    try { await api(`/api/employees/${encodeURIComponent(employeeId)}/skills`, { method: 'POST', body: { assignments: pins.map(pin => ({ versionId: pin.versionId, projectIds: pin.projectIds })) }, signal: controller.signal }); if (!controller.signal.aborted) onSaved(); }
    catch (err) { if (!controller.signal.aborted) { setError(errorMessage(err)); refresh(); } }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  return <Modal title={`配置技能 · ${employee?.name ?? employeeId}`} eyebrow="EXPLICIT VERSION PINS / 显式固定版本" onClose={onClose} busy={busy} wide><form onSubmit={submit}><div className="modal-body"><div className="notice notice-info"><Icon name="shield" /><span>技能数量不设上限，同一技能只选一个固定版本；逐项选择员工与版本的共同项目。单次运行的知识注入仍有 24 KiB 内容大小保护。保存会替换该员工全部技能配置，不修改员工资料，不升级为新版本、不触发执行。</span></div>{loadError && <ErrorNotice message={loadError} retry={refresh} />}{!catalog || !pins ? <Loading label="正在读取已发布版本和当前固定配置…" /> : <>
      {changedElsewhere && <ErrorNotice message="服务端配置已变化，本地选择未被覆盖。先核对最新配置，再保存。" />}{changedElsewhere && <div className="skill-conflict-copy"><p className="preserve-lines">最新配置：{serverPins.map(pin => `${catalog.versions.find(version => version.id === pin.versionId)?.content.title ?? pin.versionId} · ${pin.versionId} · ${projectNames(pin.projectIds, data)}`).join('\n') || '无'}</p><button type="button" className="text-button" disabled={busy || Boolean(loadError)} onClick={() => { if (window.confirm('已核对最新配置？继续保存将以本地选择完整替换该员工的配置。')) setBaseline(signature); }}>已核对，保留本地选择</button></div>}
      <p className="skill-pin-count">已选择 {pins.length} 个技能 · {employee ? roleLabels[employee.role] : '员工未知'}</p>
      {!groups.length && !pins.length && <Empty icon="file" title="暂无可配置的已发布技能" description="需先由人工发布技能，且角色匹配、至少有一个共同项目、版本未停用。草稿不能分配。" />}
      <fieldset className="form-fields" disabled={busy}>{groups.map(group => {
        const selected = pins.find(pin => group.versions.some(version => version.id === pin.versionId));
        const version = group.versions.find(item => item.id === selected?.versionId);
        return <section className="evidence-card" key={group.skillId}><Field label={version?.content.title ?? group.versions[0].content.title} hint="新发布的版本不会自动替换当前固定版本。"><select value={selected?.versionId ?? ''} onChange={event => updatePin(group.skillId, event.target.value)}><option value="">不配置此技能</option>{group.versions.map(item => <option key={item.id} value={item.id} disabled={!eligible(item)}>{item.content.title} · v{item.version} · {item.contentHash.slice(0, 12)}{!eligible(item) ? '（已失效，仅可移除）' : ''}</option>)}</select></Field>{selected && version && <><div className="skill-card-row"><Badge tone={simulationOnly(version) || version.usePolicy === 'manual_unverified' ? 'amber' : 'indigo'}>{restrictionLabel(version)}</Badge><code>{version.id}</code><button type="button" className="text-button" onClick={() => setPins(pins.filter(pin => pin.versionId !== selected.versionId))}>移除此固定版本</button></div>{!eligible(version) && <ErrorNotice message="此旧配置已停用或不再符合角色 / 项目限制。可以移除，不能新增分配。" />}<fieldset className="skill-choices"><legend className="field-label">明确选择生效项目</legend><div className="checkbox-grid">{[...new Set([...intersection(version), ...selected.projectIds])].map(id => { const allowed = intersection(version).includes(id); return <label className="checkbox-label" key={id}><input type="checkbox" checked={selected.projectIds.includes(id)} disabled={(!allowed || !eligible(version)) && !selected.projectIds.includes(id)} onChange={event => setPins(pins.map(pin => pin.versionId === selected.versionId ? { ...pin, projectIds: event.target.checked ? [...pin.projectIds, id] : pin.projectIds.filter(project => project !== id) } : pin))} />{data.projects.find(project => project.id === id)?.name ?? id}{!allowed ? '（不在共同项目内，请移除）' : ''}</label>; })}</div></fieldset></>}</section>;
      })}{pins.filter(pin => !catalog.versions.some(version => version.id === pin.versionId)).map(pin => <section className="evidence-card" key={pin.versionId}><ErrorNotice message={`已配置版本 ${pin.versionId} 无法读取，只能移除。`} /><button type="button" className="button button-danger-soft" onClick={() => setPins(pins.filter(item => item.versionId !== pin.versionId))}>移除不可用配置</button></section>)}</fieldset>{validation && <ErrorNotice message={validation} />}
    </>}{error && <ErrorNotice message={error} />}</div><footer className="modal-footer"><button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="button button-primary" disabled={busy || Boolean(validation) || Boolean(loadError) || changedElsewhere}>{busy ? '保存中…' : pins?.length === 0 ? '保存为空配置' : '保存固定版本与项目'}</button></footer></form></Modal>;
}
