import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AppModelSelection, ExecutionCheck, ExecutionStatus, ModelCatalogState } from '../shared/types';
import { api, ApiError, errorMessage } from './api';
import ModelSelection from './ModelSelection';
import type { ModelSelectionChange } from './ModelSelection';
import { Badge, Empty, ErrorNotice, Field, formatDate, Icon, Loading, Modal } from './ui';
import type { Tone } from './ui';

type Target = ExecutionCheck['target'];
type ExecutionProject = ExecutionStatus['projects'][number];
type CheckState = ExecutionCheck['status'] | 'expired' | 'unchecked';
type Confirmation = { action: 'check'; target: 'zcode'; selectionRevision: number; catalogRevision: string; selectionFingerprint: string }
  | { action: 'check'; target: 'docker'; project: ExecutionProject }
  | { action: 'revoke'; target: Target; checkId: string };
const targetLabels: Record<Target, string> = { zcode: 'ZCode', docker: 'Docker' };
const stateLabels: Record<CheckState, string> = { checking: '检查中', ready: '检查通过', blocked: '已阻塞', revoked: '已撤销', expired: '已过期', unchecked: '尚未检查' };
const stateTones: Record<CheckState, Tone> = { checking: 'indigo', ready: 'teal', blocked: 'red', revoked: 'neutral', expired: 'amber', unchecked: 'neutral' };
function checkState(check: ExecutionCheck | null, now: number): CheckState {
  if (!check) return 'unchecked';
  if (check.status === 'ready' && check.expiresAt && Date.parse(check.expiresAt) <= now) return 'expired';
  return check.status;
}
function CheckBadge({ check, target, now }: { check: ExecutionCheck | null; target: Target; now: number }) {
  const state = checkState(check, now);
  return <Badge tone={stateTones[state]} dot>{state === 'ready' && target === 'zcode' ? '连接就绪 · 非任务就绪' : stateLabels[state]}</Badge>;
}
function sameModelSelection(left: AppModelSelection | null, right: AppModelSelection | null): boolean {
  return left === null || right === null ? left === right : left.selectionRevision === right.selectionRevision
    && left.catalogRevision === right.catalogRevision && left.selectionFingerprint === right.selectionFingerprint;
}
function CheckEvidence({ check }: { check: ExecutionCheck | null }) {
  if (!check) return <p className="field-hint">尚无本目标的检查记录。打开页面、刷新与选择项目均不会启动检查。</p>;
  return <>
    <dl className="detail-metadata">
      <div><dt>最近检查时间</dt><dd>{formatDate(check.checkedAt)}</dd></div>
      <div><dt>有效期截止</dt><dd>{check.expiresAt ? formatDate(check.expiresAt) : '未提供，不推定长期有效'}</dd></div>
      {check.target === 'zcode' && <div><dt>实际返回的模型</dt><dd><code>{check.model || '未确认'}</code></dd></div>}
      <div><dt>检查 ID</dt><dd><code>{check.id}</code></dd></div>
      {check.target === 'docker' && <><div><dt>本次检查的镜像</dt><dd><code>{check.image || '未确认'}</code></dd></div><div><dt>镜像摘要</dt><dd><code>{check.imageDigest || '未确认'}</code></dd></div></>}
    </dl>
    {check.target === 'zcode' && <div className="detail-section"><h3>本次观察到的工具</h3><div className="execution-tool-badges">{check.observedTools.length ? check.observedTools.map((tool, index) => <Badge key={`${tool}-${index}`}>{tool}</Badge>) : <span className="field-hint">未观察到工具，不推定可用。</span>}</div><p className="field-hint">仅展示本次返回的工具名，不代表每个已安装插件或技能都已验证、可用。</p></div>}
    <div className="detail-section"><h3>检查结果 / 诊断（纯文本）</h3><pre className="log-output">{check.result || '尚未返回诊断结果，不推定检查通过。'}</pre></div>
  </>;
}

export default function Execution({ refreshKey = 0, onChanged }: { refreshKey?: number; onChanged: () => void }) {
  const [status, setStatus] = useState<ExecutionStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [projectId, setProjectId] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [modelState, setModelState] = useState<ModelCatalogState | null>(null);
  const [modelLoading, setModelLoading] = useState(true);
  const [modelError, setModelError] = useState('');
  const [modelSaveError, setModelSaveError] = useState('');
  const [modelNotice, setModelNotice] = useState('');
  const [modelSaving, setModelSaving] = useState(false);
  const [modelNeedsRefresh, setModelNeedsRefresh] = useState(false);
  const readRequest = useRef<AbortController | null>(null);
  const modelReadRequest = useRef<AbortController | null>(null);
  const writeRequest = useRef<AbortController | null>(null);
  const refresh = () => setRevision(value => value + 1);
  useEffect(() => () => { writeRequest.current?.abort(); modelReadRequest.current?.abort(); }, []);
  const refreshModels = useCallback(async () => {
    if (writeRequest.current) return;
    modelReadRequest.current?.abort();
    const controller = new AbortController(); modelReadRequest.current = controller;
    setModelLoading(true); setModelError('');
    try {
      const next = await api<ModelCatalogState>('/api/execution/models', { signal: controller.signal });
      if (controller.signal.aborted) return;
      // Metadata refresh updates saved values, not the editor's unsaved draft.
      setModelState(next); setModelNeedsRefresh(false); setModelSaveError('');
      readRequest.current?.abort();
      setStatus(current => current ? { ...current, modelSelection: next.selection, modelBindingSupport: next.bindingSupport } : current);
      setRevision(value => value + 1);
    } catch (err) {
      if (!controller.signal.aborted) setModelError(errorMessage(err));
    } finally {
      if (modelReadRequest.current === controller) modelReadRequest.current = null;
      if (!controller.signal.aborted) setModelLoading(false);
    }
  }, []);
  // Deliberately separate from execution polling: no repeated provider-file reads.
  useEffect(() => {
    void refreshModels();
    return () => modelReadRequest.current?.abort();
  }, [refreshModels]);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    let controller: AbortController | null = null;
    const load = async () => {
      if (disposed || pending || writeRequest.current || modelReadRequest.current) return;
      pending = true;
      const request = new AbortController(); controller = request; readRequest.current = request;
      try {
        const next = await api<ExecutionStatus>('/api/execution', { signal: request.signal });
        if (!disposed && !request.signal.aborted) { setStatus(next); setLoadError(''); setNow(Date.now()); }
      } catch (err) {
        if (!disposed && !request.signal.aborted) setLoadError(errorMessage(err));
      } finally {
        pending = false;
        if (readRequest.current === request) readRequest.current = null;
      }
    };
    void load();
    const timer = window.setInterval(() => { setNow(Date.now()); void load(); }, 5_000);
    return () => { disposed = true; window.clearInterval(timer); controller?.abort(); };
  }, [refreshKey, revision]);

  const project = status?.projects.find(item => item.id === projectId);
  const checking = Boolean(status?.checking || status?.zcodeCheck?.status === 'checking' || status?.dockerCheck?.status === 'checking');
  const actionBusy = busy || modelSaving;
  const modelChangedElsewhere = Boolean(modelState && status?.modelSelection !== undefined && !sameModelSelection(status.modelSelection, modelState.selection));
  const zcodeModelBlocked = modelLoading ? '正在读取模型元数据，请等待后核对应用默认模型。'
    : modelNeedsRefresh || modelChangedElsewhere ? '应用模型选择已变化或保存结果未确认，请手动刷新模型元数据并重新核对。'
      : modelError || !modelState ? '模型元数据不可用，请先手动刷新；不会自动选用其他模型。'
        : modelState.selectionStatus === 'unset' || !modelState.selection ? '尚未保存应用默认模型，不能发起 ZCode 检查。'
          : modelState.selectionStatus === 'stale' ? '应用默认模型已失效，请刷新模型元数据并重新确认保存。'
            : !modelState.bindingSupport.ready ? modelState.bindingSupport.reason || '原生 ZCode 会话尚未通过真实读写验收。'
              : status?.modelBindingSupport?.ready === false ? status.modelBindingSupport.reason || '服务端模型绑定能力不可用，不能发起 ZCode 检查。' : '';
  const cannotCheck = actionBusy || modelLoading || checking || !status || Boolean(loadError);
  const currentCheck = confirmation?.target === 'zcode' ? status?.zcodeCheck : status?.dockerCheck;
  const changedProject = confirmation?.action === 'check' && confirmation.target === 'docker'
    && !status?.projects.some(item => item.id === confirmation.project.id && item.image === confirmation.project.image);
  const changedCheck = confirmation?.action === 'revoke'
    && (!currentCheck || currentCheck.id !== confirmation.checkId || currentCheck.status === 'revoked');
  const changedModel = confirmation?.action === 'check' && confirmation.target === 'zcode'
    && (confirmation.selectionRevision !== modelState?.selectionRevision || confirmation.catalogRevision !== modelState?.catalog.catalogRevision
      || confirmation.selectionFingerprint !== modelState?.selection?.selectionFingerprint || Boolean(zcodeModelBlocked));
  const confirmationBlocked = actionBusy || modelLoading || !status || Boolean(loadError) || changedProject || changedCheck || changedModel
    || (confirmation?.action === 'check' && checking);
  const begin = (next: Confirmation) => { setConfirmation(next); setConsent(false); setActionError(''); setNotice(''); };
  const beginZcodeCheck = () => {
    if (cannotCheck || zcodeModelBlocked || !modelState?.selection || !modelState.catalog.catalogRevision) return;
    begin({ action: 'check', target: 'zcode', selectionRevision: modelState.selectionRevision,
      catalogRevision: modelState.catalog.catalogRevision, selectionFingerprint: modelState.selection.selectionFingerprint });
  };
  const close = () => { if (!writeRequest.current) { setConfirmation(null); setConsent(false); } };
  const saveModel = async (change: ModelSelectionChange) => {
    if (writeRequest.current || modelReadRequest.current || confirmation) return;
    if (!modelState || modelNeedsRefresh || modelChangedElsewhere || modelError || change.expectedRevision !== modelState.selectionRevision
      || change.expectedCatalogRevision !== modelState.catalog.catalogRevision) {
      setModelNeedsRefresh(true); setModelSaveError('所确认的模型状态已变化，请刷新元数据后重新确认；未提交保存。'); return;
    }
    const controller = new AbortController(); writeRequest.current = controller;
    readRequest.current?.abort(); setModelSaving(true); setModelSaveError(''); setModelNotice(''); setNotice('');
    try {
      const next = await api<ModelCatalogState>('/api/execution/model', { method: 'PATCH', body: change, signal: controller.signal });
      if (controller.signal.aborted) return;
      setModelState(next); setModelNeedsRefresh(false); setModelError('');
      // The PATCH invalidates checks server-side. Hide the older ready snapshot
      // until a read-only status sync returns; never initiate another check.
      setStatus(null); setLoadError(''); setNow(Date.now());
      setModelNotice('应用默认模型已保存。既有检查已失效，排队或运行中的真实（ZCode）任务已取消，模拟任务不受影响。此次未调用模型、未修改用户级或上游默认配置，也不会自动发起检查。');
      onChanged();
    } catch (err) {
      if (!controller.signal.aborted) {
        setModelNeedsRefresh(true);
        setModelSaveError(err instanceof ApiError && err.status === 409
          ? '保存冲突：应用选择版本或目录指纹已变化。本地选择已保留，请刷新元数据、核对最新状态并重新确认保存。'
          : `${errorMessage(err)} 保存结果尚未确认，本地选择已保留；请先刷新模型元数据，页面不会自动重试。`);
        setLoadError('模型保存后状态尚未重新确认，旧检查记录不能作为当前就绪依据。');
      }
    } finally {
      if (writeRequest.current === controller) writeRequest.current = null;
      if (!controller.signal.aborted) { setModelSaving(false); refresh(); }
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!confirmation || !consent || confirmationBlocked || writeRequest.current) return;
    const action = confirmation;
    const controller = new AbortController(); writeRequest.current = controller;
    // A pre-action GET must never overwrite the accepted check/revocation snapshot.
    readRequest.current?.abort(); setBusy(true); setActionError(''); setNotice('');
    try {
      let next: ExecutionStatus;
      if (action.action === 'check') {
        next = await api<ExecutionStatus>('/api/execution/check', { method: 'POST', body: action.target === 'zcode' ? { target: 'zcode' } : { target: 'docker', projectId: action.project.id }, signal: controller.signal });
      } else {
        await api('/api/execution/revoke', { method: 'POST', body: { target: action.target }, signal: controller.signal });
        next = await api<ExecutionStatus>('/api/execution', { signal: controller.signal });
      }
      if (controller.signal.aborted) return;
      setStatus(next); setLoadError(''); setNow(Date.now()); setConfirmation(null); setConsent(false);
      setNotice(action.action === 'check' ? `${targetLabels[action.target]} 检查请求已受理，不等于检查通过。后续仅只读同步结果，不会启动任务。` : `${action.target === 'docker' ? '所有项目的 Docker' : 'ZCode'} 全部历史检查已撤销，同时已取消所有排队或运行中的真实（ZCode）任务；模拟任务不受影响。这不是操作系统权限回收，不注销现有账号、不修改上游配置，不会自动重试或启动新任务。`);
      onChanged();
    } catch (err) {
      if (!controller.signal.aborted) {
        setActionError(`${errorMessage(err)} 请先读取最新状态再决定是否重试；页面不会自动重发检查请求。`);
        setLoadError('操作结果尚未重新确认，上次快照不能作为当前就绪依据。');
        setConfirmation(null); setConsent(false);
      }
    } finally {
      if (writeRequest.current === controller) writeRequest.current = null;
      if (!controller.signal.aborted) { setBusy(false); refresh(); }
    }
  };

  return <>
    <div className="notice notice-warning"><Icon name="shield" /><span><strong>复用现有用户环境 · 宿主程序控制，不是操作系统硬沙箱。</strong><br />复用现有 ZCode 账号、全局配置、插件与技能，以当前用户权限运行。本页不显示或导入密钥、环境变量，不修改上游配置。仅限新建演示探针，不接入生产业务。</span></div>
    {status?.warning && <div className="notice notice-info"><Icon name="alert" /><span className="preserve-lines">{status.warning}</span></div>}
    <ModelSelection state={modelState} loading={modelLoading} error={modelError} saveError={modelSaveError} notice={modelNotice}
      saving={modelSaving} disabled={busy || Boolean(confirmation)} needsRefresh={modelNeedsRefresh || modelChangedElsewhere}
      observedCheck={status?.zcodeCheck ?? null} onRefresh={() => void refreshModels()} onSave={saveModel} />
    {loadError && <ErrorNotice message={`${loadError}${status ? ' 下方保留上次同步记录，可能已过期；检查操作已暂停。' : ''}`} retry={refresh} />}
    {actionError && <ErrorNotice message={actionError} />}
    {notice && <div className="notice notice-success" role="status"><Icon name="check" /><span>{notice}</span></div>}
    <div className="view-toolbar section-gap"><Badge tone="neutral">现有用户环境 / existing-user</Badge><span className="field-hint">检查状态每 5 秒只读同步 · 模型目录仅打开页面 / 手动刷新 · 不自动检查</span>{checking && <Badge tone="indigo" dot>服务端检查中</Badge>}</div>
    {!status ? loadError ? <section className="panel"><Empty icon="monitor" title="执行状态暂不可用" description="请重试读取服务端状态。不会自动安装、拉取镜像、检查或执行任务。" /></section> : <Loading label="正在读取执行接入状态，不会发起检查…" /> : <div className="execution-access-grid">
      <section className="panel execution-access-card" aria-labelledby="zcode-connection-title">
        <header><h2 id="zcode-connection-title"><Icon name="shield" size={19} />ZCode 连接</h2><CheckBadge check={status.zcodeCheck} target="zcode" now={now} /></header>
        <p className="preserve-lines">{status.zcode.reason || '服务端尚未提供连接诊断，不推定已就绪。'}</p>
        {!status.zcode.ready && checkState(status.zcodeCheck, now) === 'ready' && <p className="field-hint">最近检查曾通过，但服务端当前连接能力不可用；以上诊断为准。</p>}
        <p className="field-hint">认证失败时，请在原有 ZCode 中完成登录，再由你重新确认检查；无需在此粘贴 API Key。</p>
        {modelState?.selection && <p className="field-hint">检查目标为已保存的应用默认模型：{modelState.selection.providerLabel} · {modelState.selection.label}；推理级别：{modelState.selection.reasoningLevel ?? '配置默认 / 不覆盖'}。下拉框中未保存的选择不会用于检查。</p>}
        {zcodeModelBlocked && <p id="zcode-model-blocked" className="field-hint" role="status">检查已禁用：{zcodeModelBlocked}</p>}
        <div className="button-row"><button type="button" className="button button-primary" disabled={cannotCheck || Boolean(zcodeModelBlocked)} aria-describedby={zcodeModelBlocked ? 'zcode-model-blocked' : undefined} onClick={beginZcodeCheck}><Icon name="play" size={16} />检查 ZCode 连接</button><button type="button" className="button button-danger-soft" disabled={actionBusy || modelLoading || Boolean(loadError) || !status.zcodeCheck || status.zcodeCheck.status === 'revoked'} onClick={() => { if (status.zcodeCheck) begin({ action: 'revoke', target: 'zcode', checkId: status.zcodeCheck.id }); }}>撤销 ZCode 检查</button></div>
        <div className="notice notice-info"><Icon name="shield" /><span>连接就绪只说明最近的连接探针通过。真实任务还需要所选项目的 Docker 测试条件及服务端校验，不会因为此检查通过而自动启动。</span></div>
        <h3>最近一次 ZCode 检查</h3>
        {!status.zcodeCheck && <p className="field-hint">实际返回的模型：未确认 · 工具：未确认</p>}
        <CheckEvidence check={status.zcodeCheck} />
      </section>
      <section className="panel execution-access-card" aria-labelledby="docker-connection-title">
        <header><h2 id="docker-connection-title"><Icon name="monitor" size={19} />Docker 测试条件</h2><CheckBadge check={status.dockerCheck} target="docker" now={now} /></header>
        <p className="preserve-lines">{status.docker.reason || '服务端尚未提供 Docker 诊断，不推定已就绪。'}</p>
        {!status.docker.ready && checkState(status.dockerCheck, now) === 'ready' && <p className="field-hint">最近检查曾通过，但服务端当前 Docker 能力不可用；以上诊断为准。</p>}
        <Field label="选择演示项目" hint="按所选项目的镜像检查。选择项目不会发起请求检查，也不会运行项目业务测试。"><select value={projectId} disabled={actionBusy || !status.projects.length} onChange={event => setProjectId(event.target.value)}><option value="">{status.projects.length ? '请选择要检查的项目' : '暂无项目，请先在「项目」页创建演示项目'}</option>{status.projects.map(item => <option key={item.id} value={item.id}>{item.name} · {item.ready ? 'Docker 就绪' : 'Docker 未就绪'}</option>)}</select></Field>
        {project && <div className="execution-project-state"><div className="button-row"><Badge tone={project.ready ? 'teal' : 'amber'}>{project.ready ? '所选项目 Docker 就绪' : '所选项目 Docker 未就绪'}</Badge><code>{project.image || '未配置镜像'}</code></div><p className="preserve-lines">{project.reason || '未提供项目测试条件诊断。'}</p></div>}
        {projectId && !project && <p className="field-hint">原选择的项目已不可用，请重新选择。</p>}
        <div className="button-row"><button type="button" className="button button-primary" disabled={cannotCheck || !project?.image} onClick={() => { if (project) begin({ action: 'check', target: 'docker', project }); }}><Icon name="play" size={16} />检查此项目 Docker</button><button type="button" className="button button-danger-soft" disabled={actionBusy || modelLoading || Boolean(loadError) || !status.dockerCheck || status.dockerCheck.status === 'revoked'} onClick={() => { if (status.dockerCheck) begin({ action: 'revoke', target: 'docker', checkId: status.dockerCheck.id }); }}>撤销 Docker 检查</button></div>
        <p className="field-hint">只检查本机已有镜像并执行固定安全探针；不自动安装 Docker、不拉取镜像。此检查不是项目业务测试通过的证据。</p>
        <h3>最近一次 Docker 检查（不随选择切换）</h3>
        {status.dockerCheck && <p className="field-hint">检查项目：{status.projects.find(item => item.id === status.dockerCheck?.projectId)?.name ?? status.dockerCheck.projectId ?? '未记录'}{status.dockerCheck.projectId && status.dockerCheck.projectId !== projectId ? ' · 不是当前所选项目' : ''}</p>}
        <CheckEvidence check={status.dockerCheck} />
      </section>
    </div>}
    <div className="subtle-note"><Icon name="shield" size={16} /><span>生产执行关闭。本页不启动研发任务，不实际合并、不实际发布；撤销会使该目标全部历史检查失效（Docker 包括所有项目），同时取消所有排队或运行中的真实（ZCode）任务，模拟任务不受影响。这不是操作系统权限回收，也不注销现有账号。</span></div>
    {confirmation && <Modal title={confirmation.action === 'revoke' ? `确认撤销 ${targetLabels[confirmation.target]} 检查` : `确认检查 ${targetLabels[confirmation.target]}${confirmation.target === 'zcode' ? ' 连接' : ' 测试条件'}`} eyebrow="EXPLICIT CONSENT / 仅限演示检查" busy={busy} onClose={close}><form onSubmit={submit}><div className="modal-body action-body">
      {confirmation.action === 'revoke' ? <><p className="form-context">撤销 {targetLabels[confirmation.target]} 全部历史检查并取消真实任务</p><p className="preserve-lines section-gap">使该目标的全部历史检查失效，同时取消所有排队或运行中的真实（ZCode）任务，并中止其执行进程；模拟任务不受影响。这不是操作系统权限回收，也不注销现有账号。不删除检查记录、不修改上游配置、不卸载工具、不发起新检查或任务。</p>{confirmation.target === 'docker' && <p className="field-hint">撤销范围包括所有项目的全部 Docker 检查，不限于最近一次记录或当前下拉框所选项目。</p>}</> : confirmation.target === 'zcode' ? <>
        <p className="form-context">使用已保存的应用模型：{modelState?.selection?.providerLabel} · {modelState?.selection?.label}<br />推理级别：{modelState?.selection?.reasoningLevel ?? '配置默认 / 不覆盖'}；不使用未保存草稿，不自动回退到其他模型。</p>
        <div className="notice notice-warning section-gap"><Icon name="shield" /><span><strong>这是实际模型调用，可能消耗现有账号额度。</strong><br />不是免费模拟；最多进行 2 次小型模型交互。</span></div>
        <ol className="skill-content-list"><li>使用现有 ZCode 登录凭据与全局配置，保留访问已配置插件、技能和工具的能力；本页不显示或导入密钥、环境变量，不改写上游配置。</li><li>由宿主程序控制，以当前用户权限运行，不是操作系统硬沙箱，不能承诺隔离当前用户可访问的资源。</li><li>只向模型提交新生成的探针项目，不提交用户业务项目或生产项目；不会因此启动研发任务。</li><li>检查只记录本次实际模型和观察到的工具，不保证所有已安装插件可用。认证失败需先在原有 ZCode 中登录，再手动重试。</li></ol>
      </> : <>
        <p className="form-context">检查项目：{confirmation.project.name}</p><p className="section-gap">本机已有镜像：<code>{confirmation.project.image}</code></p>
        <p className="preserve-lines section-gap">检查镜像并在容器内执行固定安全探针，不运行项目业务测试命令。不自动安装 Docker，不自动拉取镜像；缺少条件将返回阻塞原因。</p><p className="field-hint section-gap">此处不调用 ZCode 模型，但会实际使用本机 Docker 资源。通过不代表任务就绪或生产授权。</p>
      </>}
      {loadError && <ErrorNotice message="状态读取失败，请先刷新状态再确认。" retry={refresh} />}
      {(changedProject || changedCheck || changedModel) && <ErrorNotice message="所确认的项目镜像、模型选择或检查记录已变化，请取消后刷新并重新核对。" />}
      {confirmation.action === 'check' && checking && <p className="field-hint section-gap" role="status">服务端已有检查正在运行；只同步结果，不重复发起。</p>}
      <label className="checkbox-label consent section-gap"><input type="checkbox" required checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} /><span>{confirmation.action === 'revoke' ? '我确认撤销上述目标的全部历史检查（Docker 包括所有项目），并取消所有排队或运行中的真实任务；模拟任务不受影响。' : confirmation.target === 'zcode' ? '我理解当前用户权限、全局插件访问及额度消耗，同意发起这一次连接检查。' : '我同意使用上述项目的现有镜像执行一次固定安全探针。'}</span></label>
    </div><footer className="modal-footer"><button type="button" className="button button-secondary" disabled={busy} onClick={close}>取消</button><button type="submit" className={`button ${confirmation.action === 'revoke' ? 'button-danger' : 'button-primary'}`} disabled={Boolean(confirmationBlocked) || !consent}>{busy ? '提交中…' : confirmation.action === 'revoke' ? '确认撤销检查' : confirmation.target === 'zcode' ? '确认检查（可能消耗额度）' : '确认执行 Docker 探针'}</button></footer></form></Modal>}
  </>;
}
