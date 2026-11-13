import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ConfiguredModel, EmployeeModelState, ModelBinding } from '../shared/types';
import { api, ApiError, errorMessage } from './api';
import ModelApiTestPanel from './ModelApiTest';
import { effectiveModelSummary, modelForBinding, modelIdLabel, modelLabel, reasoningOptionLabel, reasoningValueLabel } from './ModelPresentation';
import { Badge, ErrorNotice, Field, Icon, Loading, Modal } from './ui';

interface Draft {
  mode: EmployeeModelState['mode'];
  providerId: string;
  modelId: string;
  reasoningLevel: string | null;
}

function draftFromState(state: EmployeeModelState | null | undefined): Draft {
  const binding = state?.selection;
  return {
    mode: state?.mode ?? 'inherit-app',
    providerId: binding?.providerId ?? '',
    modelId: binding?.catalogId ?? '',
    reasoningLevel: binding?.reasoningLevel ?? null,
  };
}

function catalogModel(state: EmployeeModelState | null, draft: Draft): ConfiguredModel | null {
  return state?.catalog.models.find(model => model.id === draft.modelId)
    ?? state?.catalog.models.find(model => model.providerId === draft.providerId && model.modelId === draft.modelId)
    ?? null;
}

function currentReasoning(state: EmployeeModelState): string {
  if (state.effectiveStatus !== 'configured' || !state.effectiveBinding) return '思考强度未知';
  if (state.effectiveReasoning != null && state.effectiveReasoning !== '') return reasoningValueLabel(state.effectiveReasoning);
  return '思考强度未知（服务端未解析默认值）';
}

export function employeeModelSummary(state: EmployeeModelState | undefined): string {
  if (!state) return '模型未读取';
  if (!state.effectiveBinding || state.effectiveStatus !== 'configured') {
    return `${state.mode === 'inherit-app' ? '跟随应用默认' : '员工覆盖'} · ${state.reason || '当前模型未生效'}`;
  }
  return `${state.mode === 'inherit-app' ? '跟随应用' : '员工覆盖'} · ${modelLabel(modelForBinding(state.effectiveBinding, state.catalog), state.effectiveBinding)} · ${currentReasoning(state)}`;
}

export default function EmployeeModel({ employeeId, employeeName, initialState, onSaved, onClose }: {
  employeeId: string;
  employeeName: string;
  initialState?: EmployeeModelState | null;
  onSaved: (state: EmployeeModelState) => void;
  onClose: () => void;
}) {
  const endpoint = `/api/employees/${encodeURIComponent(employeeId)}/model`;
  const [source, setSource] = useState<EmployeeModelState | null>(initialState ?? null);
  const [draft, setDraft] = useState<Draft>(() => draftFromState(initialState));
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef<AbortController | null>(null);
  const writeRequest = useRef<AbortController | null>(null);

  const load = useCallback(async (preserveDraft = dirty) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setLoadError('');
    try {
      const next = await api<EmployeeModelState>(endpoint, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const serverChanged = Boolean(source && (source.preferenceRevision !== next.preferenceRevision || source.catalog.catalogRevision !== next.catalog.catalogRevision));
      setSource(next);
      if (!preserveDraft) {
        setDraft(draftFromState(next));
        setDirty(false);
        setConflict(false);
      } else if (serverChanged) {
        setConflict(true);
      }
    } catch (error) {
      if (!controller.signal.aborted) setLoadError(errorMessage(error));
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [dirty, endpoint, source]);

  useEffect(() => {
    void load(false);
    return () => { request.current?.abort(); writeRequest.current?.abort(); };
  }, [endpoint]); // The modal reads its own authoritative snapshot once; refresh is explicit.

  const catalog = source?.catalog ?? null;
  const providers = useMemo(() => Array.from(new Map((catalog?.models ?? []).map(model => [model.providerId, model.providerLabel || model.providerId])).entries()), [catalog]);
  const models = useMemo(() => catalog?.models.filter(model => model.providerId === draft.providerId) ?? [], [catalog, draft.providerId]);
  const selected = catalogModel(source, draft);
  const selectedMatchesProvider = Boolean(selected && selected.providerId === draft.providerId);
  const validReasoning = draft.reasoningLevel === null || Boolean(selected?.reasoningLevels.includes(draft.reasoningLevel));
  const validOverride = draft.mode === 'override' && Boolean(
    catalog?.coverage === 'partial' && catalog.catalogRevision && selectedMatchesProvider && selected?.enabled && selected.availabilityConfigured && validReasoning,
  );
  const canSave = Boolean(source && dirty && !conflict && !loading && !saving && !loadError && (draft.mode === 'inherit-app' || validOverride));
  const effectiveSummary = source ? effectiveModelSummary(source.effectiveBinding, source.catalog, source.effectiveReasoning) : null;
  const savedConfigKey = source ? `${source.preferenceRevision}:${source.effectiveBinding?.selectionFingerprint ?? 'unset'}:${source.effectiveReasoning ?? 'unknown'}` : 'unset';

  const updateDraft = (next: Draft) => {
    setDraft(next);
    setDirty(true);
    setConflict(false);
    setSaveError('');
    setNotice('');
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave || !source || writeRequest.current) return;
    const controller = new AbortController();
    writeRequest.current = controller;
    setSaving(true);
    setSaveError('');
    setNotice('');
    try {
      const body = draft.mode === 'inherit-app'
        ? { mode: 'inherit-app' as const, expectedRevision: source.preferenceRevision }
        : { mode: 'override' as const, modelId: selected!.id, reasoningLevel: draft.reasoningLevel, expectedRevision: source.preferenceRevision, expectedCatalogRevision: source.catalog.catalogRevision! };
      const next = await api<EmployeeModelState>(endpoint, { method: 'PATCH', body, signal: controller.signal });
      if (controller.signal.aborted) return;
      setSource(next);
      setDraft(draftFromState(next));
      setDirty(false);
      setConflict(false);
      setNotice('员工模型配置已保存。未调用模型；既有模型测试已由服务端按新配置失效。');
      onSaved(next);
    } catch (error) {
      if (!controller.signal.aborted) {
        setConflict(error instanceof ApiError && error.status === 409);
        setSaveError(error instanceof ApiError && error.status === 409
          ? '保存未完成：员工有运行中任务或模型配置已变化。服务端未修改配置；请刷新最新状态后重新核对。'
          : errorMessage(error));
      }
    } finally {
      if (writeRequest.current === controller) writeRequest.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  };

  const close = () => { if (!saving) onClose(); };
  return <Modal title={`配置模型 · ${employeeName}`} eyebrow="EMPLOYEE MODEL / 员工级覆盖" onClose={close} busy={saving} wide><form onSubmit={save}><div className="modal-body">
    <div className="notice notice-info"><Icon name="shield" /><span>员工默认跟随应用默认模型；只有明确选择「员工覆盖」并保存后才会改变。此处不提供密钥、服务地址或原始配置输入，也不会因打开、刷新或保存自动测试模型。</span></div>
    {loadError && <ErrorNotice message={`${loadError} 不会根据其他员工或硬编码模型推断配置。`} retry={() => void load(true)} />}
    {saveError && <ErrorNotice message={saveError} />}
    {notice && <div className="notice notice-success" role="status"><Icon name="check" /><span>{notice}</span></div>}
    {loading && !source ? <Loading label="正在读取员工模型快照…" /> : source && <>
      {conflict && <div className="notice notice-warning" role="alert"><Icon name="alert" /><span><strong>服务端模型快照已变化，本地草稿未被覆盖。</strong><br />请刷新并核对当前配置；确认后可选择保留本地草稿作为新的完整提交，不会自动合并或重试。<div className="button-row section-gap"><button type="button" className="text-button" disabled={saving || Boolean(loadError)} onClick={() => void load(true)}>刷新服务端快照（保留草稿）</button><button type="button" className="text-button" disabled={saving || Boolean(loadError)} onClick={() => { setConflict(false); setSaveError(''); }}>已核对，保留草稿继续</button><button type="button" className="text-button" disabled={saving} onClick={() => { setDraft(draftFromState(source)); setDirty(false); setConflict(false); setSaveError(''); }}>放弃草稿，采用服务端配置</button></div></span></div>}
      <div className="employee-model-current"><div><span className="field-hint">当前保存模式</span><strong>{source.mode === 'inherit-app' ? '跟随应用默认' : '员工覆盖'}</strong><small>{source.preferenceRevision ? `偏好版本 ${source.preferenceRevision}` : '尚无偏好版本'}</small></div><div><span className="field-hint">当前生效模型</span><strong>{effectiveSummary?.model ?? '未生效'}</strong><small>{effectiveSummary?.id ?? '没有可用绑定'}</small></div><div><span className="field-hint">当前生效思考强度</span><strong>{source.effectiveBinding ? (source.effectiveReasoning == null ? '未知' : reasoningValueLabel(source.effectiveReasoning)) : '未知'}</strong><small>{source.effectiveStatus === 'configured' ? '服务端已解析' : source.reason || '未配置'}</small></div></div>
      <fieldset className="form-fields" disabled={saving}><Field label="员工模型来源" hint="继承应用不会复制应用配置；员工覆盖只提交目录中的模型 ID。"><div className="model-mode-options"><label className={`model-mode-option ${draft.mode === 'inherit-app' ? 'is-selected' : ''}`}><input type="radio" name="employeeModelMode" checked={draft.mode === 'inherit-app'} onChange={() => updateDraft({ mode: 'inherit-app', providerId: '', modelId: '', reasoningLevel: null })} /><span><strong>跟随应用默认</strong><small>应用默认变化后员工随之生效</small></span></label><label className={`model-mode-option ${draft.mode === 'override' ? 'is-selected' : ''}`}><input type="radio" name="employeeModelMode" checked={draft.mode === 'override'} onChange={() => updateDraft({ ...draft, mode: 'override' })} /><span><strong>员工覆盖</strong><small>固定选择一个已配置模型和思考强度</small></span></label></div></Field>
        {draft.mode === 'override' && <><div className="form-grid-three"><Field label="提供商" hint="来自服务端目录，不自动回退。"><select value={draft.providerId} onChange={event => updateDraft({ ...draft, providerId: event.target.value, modelId: '', reasoningLevel: null })}><option value="">请选择已配置提供商</option>{draft.providerId && !providers.some(([id]) => id === draft.providerId) && <option value={draft.providerId} disabled>{draft.providerId} · 已不在目录</option>}{providers.map(([id, label]) => <option key={id} value={id}>{label}{label !== id ? ` · ${id}` : ''}</option>)}</select></Field><Field label="模型" hint="只允许启用且已声明可用性的目录条目。"><select value={draft.modelId} disabled={!draft.providerId} onChange={event => updateDraft({ ...draft, modelId: event.target.value, reasoningLevel: null })}><option value="">{models.length ? '请选择已配置模型' : '此提供商没有目录条目'}</option>{draft.modelId && !selectedMatchesProvider && <option value={draft.modelId} disabled>{draft.modelId} · 已不在目录</option>}{models.map(model => <option key={model.id} value={model.id} disabled={!model.enabled || !model.availabilityConfigured}>{model.label || model.modelId} · {model.modelId}{!model.enabled ? ' · 未启用' : !model.availabilityConfigured ? ' · 可用性未声明' : ''}</option>)}</select></Field><Field label="思考强度" hint="默认值仅在目录明确声明时展示；未知值不自行猜测。"><select value={draft.reasoningLevel ?? ''} disabled={!selectedMatchesProvider} onChange={event => updateDraft({ ...draft, reasoningLevel: event.target.value || null })}><option value="">{selected?.reasoningDefault ? `跟随默认：${reasoningValueLabel(selected.reasoningDefault)}${selected.reasoningSource ? `（${selected.reasoningSource === 'builtin' ? '内置' : selected.reasoningSource === 'personal' ? '个人配置' : selected.reasoningSource === 'unsupported' ? '不支持' : '来源未知'}）` : ''}` : '跟随默认（未声明）'}</option>{draft.reasoningLevel !== null && !validReasoning && <option value={draft.reasoningLevel} disabled>{reasoningOptionLabel(draft.reasoningLevel)} · 目录已不再声明</option>}{(selected?.reasoningLevels ?? []).filter(level => level !== '').map(level => <option key={level} value={level}>{reasoningOptionLabel(level)}</option>)}</select></Field></div>{selected && <p className="field-hint">目录条目：{selected.enabled ? '已启用' : '未启用'} · 可用性：{selected.availabilityConfigured ? '已声明（未验证）' : '未声明'} · 思考默认：{selected.reasoningDefault ? `跟随默认 ${reasoningValueLabel(selected.reasoningDefault)}` : '未声明'}。{selected.reason}</p>}{draft.modelId && (!selectedMatchesProvider || !selected?.enabled || !selected?.availabilityConfigured || !validReasoning) && <p className="field-hint" role="alert">当前覆盖草稿不可保存：目录条目、可用性或思考强度声明不完整；不会自动换成其他模型。</p>}</>}
      </fieldset>
      <div className="button-row"><button type="submit" className="button button-primary" disabled={!canSave}>{saving ? <span className="spinner" /> : <Icon name="check" size={16} />}{saving ? '保存中…' : '保存员工模型'}</button>{dirty && <Badge tone="amber">有未保存的选择</Badge>}</div>
      {source.effectiveBinding && <ModelApiTestPanel scope="employee" employeeId={employeeId} personLabel={employeeName} binding={source.effectiveBinding} catalog={source.catalog} effectiveReasoning={source.effectiveReasoning} invalidationKey={savedConfigKey} disabled={source.effectiveStatus !== 'configured' || Boolean(loadError) || dirty || saving || conflict} disabledReason={dirty ? '请先保存员工模型与思考强度，再测试。' : source.effectiveStatus === 'configured' ? undefined : source.reason || '员工当前有效模型未配置或已失效。'} />}
    </>}
  </div><footer className="modal-footer"><button type="button" className="button button-secondary" disabled={saving} onClick={close}>关闭</button></footer></form></Modal>;
}
