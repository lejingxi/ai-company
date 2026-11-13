import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModelApiTest, ModelApiTestState, ModelBinding, ModelCatalog } from '../shared/types';
import { api, errorMessage } from './api';
import { Badge, ErrorNotice, Icon, Loading } from './ui';
import { effectiveModelSummary, modelForBinding, modelIdLabel, modelLabel, reasoningValueLabel } from './ModelPresentation';

export type ModelApiTestScope = 'app' | 'employee';

const statusLabels: Record<ModelApiTest['status'], string> = {
  running: '测试中',
  passed: '已通过',
  failed: '失败',
  cancelled: '已取消',
  stale: '已失效',
};
const statusTones: Record<ModelApiTest['status'], 'neutral' | 'teal' | 'indigo' | 'amber' | 'red'> = {
  running: 'indigo',
  passed: 'teal',
  failed: 'red',
  cancelled: 'neutral',
  stale: 'amber',
};

function testPath(scope: ModelApiTestScope, employeeId?: string): string {
  const query = new URLSearchParams({ scope });
  if (scope === 'employee' && employeeId) query.set('employeeId', employeeId);
  return `/api/execution/model-api-tests?${query.toString()}`;
}

function resultReasoning(test: ModelApiTest): string {
  return test.effectiveReasoning === null ? '未确认 / 未声明' : reasoningValueLabel(test.effectiveReasoning);
}

function TestResult({ test, personLabel }: { test: ModelApiTest; personLabel?: string }) {
  return <div className="model-test-result" aria-live="polite">
    <div className="model-test-result-header"><div><strong>最近一次独立模型连接测试</strong><small>{test.status === 'running' ? '服务端仍在处理；页面只读同步结果。' : '此结果只代表这一次模型 API 测试，不代表 ZCode 连接就绪或任务可执行。'}</small></div><Badge tone={statusTones[test.status]} dot>{statusLabels[test.status]}</Badge></div>
    <dl className="detail-metadata model-test-metadata">
      <div><dt>测试范围</dt><dd>{test.scope === 'employee' ? `员工 · ${personLabel ?? test.employeeId ?? '员工 ID 未提供'}` : '应用默认模型'}</dd></div>
      <div><dt>测试绑定目录 ID</dt><dd><code>{test.binding.catalogId}</code></dd></div>
      <div><dt>结果代码</dt><dd><code>{test.code || '未提供'}</code></dd></div>
      <div><dt>延迟</dt><dd>{test.durationMs == null ? '未返回' : `${test.durationMs} ms`}</dd></div>
      <div><dt>请求的思考强度</dt><dd>{resultReasoning(test)}</dd></div>
      <div><dt>思考强度是否被确认</dt><dd>{test.reasoningHonored === 'reported' ? '服务端返回已报告' : '未确认模型是否采用请求强度'}</dd></div>
    </dl>
    <p className="model-test-message preserve-lines">{test.message || '服务端未返回补充说明。'}</p>
  </div>;
}

export interface ModelApiTestPanelProps {
  scope: ModelApiTestScope;
  employeeId?: string;
  personLabel?: string;
  binding: ModelBinding | null | undefined;
  catalog: ModelCatalog | null | undefined;
  effectiveReasoning?: string | null;
  invalidationKey?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export default function ModelApiTestPanel({
  scope, employeeId, personLabel, binding, catalog, effectiveReasoning, invalidationKey = '', disabled = false, disabledReason,
}: ModelApiTestPanelProps) {
  const scopeKey = `${scope}:${employeeId ?? ''}:${binding?.selectionFingerprint ?? 'unset'}:${invalidationKey}`;
  const [state, setState] = useState<ModelApiTestState | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const actionRequest = useRef<AbortController | null>(null);
  const generation = useRef(0);

  const summary = useMemo(() => effectiveModelSummary(binding, catalog, effectiveReasoning), [binding, catalog, effectiveReasoning]);
  const model = modelForBinding(binding, catalog);
  const selectedSaved = Boolean(binding && model);
  const testDisabledReason = disabledReason || (disabled ? '当前配置正在保存或页面正在处理另一项操作。' : loadError ? '最近一次测试状态读取失败，请刷新后再确认。' : loading ? '正在读取最近一次测试状态，请等待完成。' : !selectedSaved ? '尚未读取可测试的已保存模型选择。' : !summary.reasoning.known ? summary.reasoning.reason : '');
  const canTest = selectedSaved && summary.reasoning.known && !disabled && !busy && !cancelBusy && !loading && !loadError && !state?.active;

  const readState = useCallback(async (signal?: AbortSignal) => {
    if (!selectedSaved) {
      setState(null);
      setLoadError('');
      return;
    }
    const ownedController = signal ? null : new AbortController();
    const activeSignal = signal ?? ownedController!.signal;
    if (ownedController) {
      request.current?.abort();
      request.current = ownedController;
    }
    const startedGeneration = generation.current;
    setLoading(true);
    try {
      const next = await api<ModelApiTestState>(testPath(scope, employeeId), { signal: activeSignal });
      if (activeSignal.aborted || startedGeneration !== generation.current) return;
      setState(next);
      setLoadError('');
    } catch (error) {
      if (!activeSignal.aborted && startedGeneration === generation.current) setLoadError(errorMessage(error));
    } finally {
      if (ownedController && request.current === ownedController) request.current = null;
      if (!activeSignal.aborted && startedGeneration === generation.current) setLoading(false);
    }
  }, [employeeId, scope, selectedSaved]);

  useEffect(() => {
    generation.current += 1;
    request.current?.abort();
    actionRequest.current?.abort();
    request.current = null;
    actionRequest.current = null;
    setBusy(false);
    setCancelBusy(false);
    setState(null);
    setConfirming(false);
    setConsent(false);
    setActionError('');
    void readState();
    return () => {
      request.current?.abort();
      actionRequest.current?.abort();
    };
  }, [scopeKey, readState]);

  useEffect(() => {
    if (!state?.active || !selectedSaved) return;
    let disposed = false;
    const timer = window.setInterval(() => {
      if (!disposed && !actionRequest.current && !request.current) void readState();
    }, 2_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [readState, selectedSaved, state?.active]);

  const begin = () => {
    if (!canTest) return;
    setActionError('');
    setConsent(false);
    setConfirming(true);
  };
  const closeConfirmation = () => {
    if (!busy) { setConfirming(false); setConsent(false); }
  };
  const submit = async () => {
    if (!canTest || !confirming || !consent || !binding || !summary.reasoning.known) return;
    const controller = new AbortController();
    actionRequest.current = controller;
    setBusy(true);
    setActionError('');
    try {
      const result = await api<ModelApiTest>('/api/execution/model-api-tests', {
        method: 'POST',
        body: {
          scope,
          employeeId: scope === 'employee' ? employeeId ?? null : null,
          expectedSelectionFingerprint: binding.selectionFingerprint,
          effectiveReasoning: summary.reasoning.value,
          requestId: crypto.randomUUID(),
          confirmCharge: true,
        },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setState({ active: result.status === 'running', latest: result });
      setConfirming(false);
      setConsent(false);
    } catch (error) {
      if (!controller.signal.aborted) setActionError(errorMessage(error));
    } finally {
      if (actionRequest.current === controller) actionRequest.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const cancel = async () => {
    const test = state?.latest;
    if (!test || !state.active || cancelBusy || busy) return;
    const controller = new AbortController();
    actionRequest.current = controller;
    setCancelBusy(true);
    setActionError('');
    try {
      const result = await api<ModelApiTest>(`/api/execution/model-api-tests/${encodeURIComponent(test.id)}/cancel`, { method: 'POST', body: {}, signal: controller.signal });
      if (!controller.signal.aborted) setState({ active: result.status === 'running', latest: result });
    } catch (error) {
      if (!controller.signal.aborted) setActionError(errorMessage(error));
    } finally {
      if (actionRequest.current === controller) actionRequest.current = null;
      if (!controller.signal.aborted) setCancelBusy(false);
    }
  };

  return <section className="model-test-panel" aria-labelledby={`model-test-${scope}-${employeeId ?? 'app'}`}>
    <header className="model-test-header"><div><h3 id={`model-test-${scope}-${employeeId ?? 'app'}`}>独立模型 API 测试</h3><p>只测试当前已保存的{scope === 'employee' ? '员工有效模型' : '应用默认模型'}，不读取项目内容、不改变 ZCode 就绪状态。</p></div>{state?.latest && <Badge tone={statusTones[state.latest.status]} dot>{statusLabels[state.latest.status]}</Badge>}</header>
    {selectedSaved ? <div className="model-test-target"><div><span className="field-hint">测试目标{personLabel ? ` · ${personLabel}` : ''}</span><strong>{modelLabel(model, binding)}</strong><code>{modelIdLabel(model, binding)}</code></div><div><span className="field-hint">生效思考强度</span><strong>{summary.reasoning.display}</strong></div></div> : <p className="field-hint">仅展示已保存选择；当前没有可测试的有效模型。</p>}
    {testDisabledReason && <p className="field-hint model-test-disabled" role="status">测试已禁用：{testDisabledReason}</p>}
    {loadError && <ErrorNotice message={`${loadError} 测试状态不会影响模型配置。`} />}
    {actionError && <ErrorNotice message={actionError} />}
    {loading && !state && <Loading label="正在读取最近一次测试状态…" />}
    {state?.latest && <TestResult test={state.latest} personLabel={personLabel} />}
    <div className="button-row model-test-actions"><button type="button" className="button button-secondary" disabled={!selectedSaved || loading || busy || cancelBusy} onClick={() => void readState()}><Icon name="refresh" size={15} />刷新测试状态</button>{state?.active ? <button type="button" className="button button-danger-soft" disabled={cancelBusy || busy} onClick={() => void cancel()}>{cancelBusy ? <span className="spinner" /> : <Icon name="stop" size={15} />}{cancelBusy ? '取消中…' : '取消服务端测试'}</button> : <button type="button" className="button button-primary" disabled={!canTest} onClick={begin}><Icon name="play" size={15} />测试模型连接（可能消耗额度）</button>}</div>
    {confirming && <div className="model-test-confirmation"><div className="notice notice-warning"><Icon name="shield" /><span><strong>确认一次真实模型 API 请求</strong><br />目标：{scope === 'employee' ? `${personLabel ?? employeeId ?? '员工'} 的有效模型` : '应用默认模型'} · {modelLabel(model, binding)}<br />思考强度：{summary.reasoning.display}<br />最多 2048 输出 token，仅发送一次请求，不包含项目内容。可能消耗当前账号额度；测试通过不代表 ZCode 连接就绪或可以启动编码。</span></div><label className="checkbox-label consent"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} /><span>我确认上述目标、思考强度、输出上限和额度影响，同意只发起这一次模型 API 测试。</span></label><div className="button-row"><button type="button" className="button button-secondary" disabled={busy} onClick={closeConfirmation}>取消</button><button type="button" className="button button-primary" disabled={!consent || busy} onClick={() => void submit()}>{busy ? <span className="spinner" /> : <Icon name="check" size={15} />}{busy ? '提交中…' : '确认测试（可能消耗额度）'}</button></div></div>}
  </section>;
}
