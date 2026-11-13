import { useState } from 'react';
import type { FormEvent } from 'react';
import type { ExecutionCheck, ModelCatalogState } from '../shared/types';
import { Badge, Empty, ErrorNotice, Field, formatDate, Icon, Loading, Modal } from './ui';
import ModelApiTestPanel from './ModelApiTest';
import { reasoningOptionLabel, reasoningSourceLabel, reasoningValueLabel } from './ModelPresentation';

export interface ModelSelectionChange {
  modelId: string;
  reasoningLevel: string | null;
  expectedRevision: number;
  expectedCatalogRevision: string;
}
type Draft = { providerId: string; modelId: string; reasoningLevel: string | null };
type SaveConfirmation = ModelSelectionChange & { providerLabel: string; label: string };
type Editor = {
  source: ModelCatalogState | null; draft: Draft; dirty: boolean; conflict: boolean;
  confirmation: SaveConfirmation | null; consent: boolean;
};
function savedDraft(state: ModelCatalogState | null): Draft {
  return { providerId: state?.selection?.providerId ?? '', modelId: state?.selection?.catalogId ?? '', reasoningLevel: state?.selection?.reasoningLevel ?? null };
}
function matchesSaved(draft: Draft, state: ModelCatalogState | null): boolean {
  return Boolean(state?.selection && draft.providerId === state.selection.providerId
    && draft.modelId === state.selection.catalogId && draft.reasoningLevel === state.selection.reasoningLevel);
}
const selectionLabels = { unset: '尚未保存', configured: '已配置 · 未验证调用', stale: '已失效 · 需重新选择 / 确认' };

export default function ModelSelection({ state, loading, error, saveError, notice, saving, disabled, needsRefresh, observedCheck, onRefresh, onSave }: {
  state: ModelCatalogState | null; loading: boolean; error: string; saveError: string; notice: string;
  saving: boolean; disabled: boolean; needsRefresh: boolean; observedCheck: ExecutionCheck | null;
  onRefresh: () => void; onSave: (change: ModelSelectionChange) => Promise<void>;
}) {
  const [editor, setEditor] = useState<Editor>(() => ({ source: state, draft: savedDraft(state), dirty: false, conflict: false, confirmation: null, consent: false }));
  // A new server snapshot must not replace an unsaved draft. Matching saved values
  // acknowledge a successful save; changed revisions require explicit review.
  if (editor.source !== state) {
    const accepted = state?.selectionStatus === 'configured' && state.selection?.catalogRevision === state.catalog.catalogRevision && matchesSaved(editor.draft, state);
    const preserve = editor.dirty && !accepted;
    const changed = editor.source !== null && state !== null && (editor.source.selectionRevision !== state.selectionRevision
      || editor.source.catalog.catalogRevision !== state.catalog.catalogRevision || editor.source.selectionStatus !== state.selectionStatus);
    setEditor({ source: state, draft: preserve ? editor.draft : savedDraft(state), dirty: preserve,
      conflict: preserve && (editor.conflict || changed), confirmation: null, consent: false });
  }
  const { draft, confirmation, consent } = editor;
  const catalog = state?.catalog;
  const providers = Array.from(new Map((catalog?.models ?? []).map(model => [model.providerId, model.providerLabel || model.providerId])).entries());
  const models = catalog?.models.filter(model => model.providerId === draft.providerId) ?? [];
  const selected = models.find(model => model.id === draft.modelId);
  const validReasoning = draft.reasoningLevel === null || Boolean(selected?.reasoningLevels.includes(draft.reasoningLevel));
  const controlsDisabled = disabled || saving || loading || !state;
  const canSave = !controlsDisabled && !error && !needsRefresh && !editor.conflict && catalog?.coverage === 'partial'
    && Boolean(catalog.catalogRevision && selected?.enabled && selected.availabilityConfigured && validReasoning) && (editor.dirty || state?.selectionStatus === 'stale');
  const confirmationCurrent = confirmation && state && confirmation.expectedRevision === state.selectionRevision
    && confirmation.expectedCatalogRevision === state.catalog.catalogRevision
    && confirmation.modelId === draft.modelId && confirmation.reasoningLevel === draft.reasoningLevel;
  const updateDraft = (next: Draft) => setEditor({ ...editor, draft: next, dirty: !matchesSaved(next, state), confirmation: null, consent: false });
  const close = () => { if (!saving) setEditor({ ...editor, confirmation: null, consent: false }); };
  const beginSave = () => {
    if (!canSave || !state || !selected || !catalog?.catalogRevision) return;
    setEditor({ ...editor, consent: false, confirmation: { modelId: selected.id, reasoningLevel: draft.reasoningLevel,
      expectedRevision: state.selectionRevision, expectedCatalogRevision: catalog.catalogRevision,
      providerLabel: selected.providerLabel || selected.providerId, label: selected.label || selected.modelId } });
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!confirmation || !confirmationCurrent || !consent || !canSave || saving) return;
    setEditor(current => ({ ...current, confirmation: null, consent: false }));
    await onSave({ modelId: confirmation.modelId, reasoningLevel: confirmation.reasoningLevel,
      expectedRevision: confirmation.expectedRevision, expectedCatalogRevision: confirmation.expectedCatalogRevision });
  };

  return <section className="panel execution-access-card model-selection-card" aria-labelledby="execution-model-title">
    <header><h2 id="execution-model-title"><Icon name="code" size={19} />应用默认模型</h2><div className="button-row">
      {state && <Badge tone={state.selectionStatus === 'stale' ? 'amber' : 'neutral'}>{selectionLabels[state.selectionStatus]}</Badge>}
      <button type="button" className="button button-secondary" disabled={saving || disabled || loading} onClick={onRefresh}><Icon name="refresh" size={16} />{loading ? '读取模型元数据…' : '刷新模型元数据'}</button>
    </div></header>
    <p>只读取已配置的模型元数据，不探测服务、不发起模型调用。目录仅在打开本页或手动刷新时读取；配置条目不代表模型已测试、可调用。</p>
    {error && <ErrorNotice message={`${error}${state ? ' 下方保留上次模型快照，保存和 ZCode 检查已暂停。' : ''}`} />}
    {saveError && <ErrorNotice message={saveError} />}
    {notice && <div className="notice notice-success" role="status"><Icon name="check" /><span>{notice}</span></div>}
    {needsRefresh && <div className="notice notice-warning" role="alert"><Icon name="alert" /><span><strong>模型状态已变化或保存结果尚未确认。</strong><br />本地未保存的选择仍保留。请先点击「刷新模型元数据」，核对最新应用选择和目录后重新确认；不会自动重试保存或覆盖其他页面的修改。</span></div>}
    {!state ? loading ? <Loading label="正在读取模型元数据，不会调用模型…" /> : <Empty icon="code" title="模型目录暂不可用" description="请手动刷新模型元数据。不会使用硬编码模型或自动回退到其他提供商。" /> : <>
      <div className="notice notice-info"><Icon name="alert" /><span><strong>{catalog?.coverage === 'partial' ? '部分目录 · 仅个人显式配置' : '模型目录不可用'}</strong><br />{catalog?.coverage === 'partial' ? '只展示个人配置中显式声明的条目，不是 ZCode 内置模型与各层配置合并后的完整目录。' : '当前无法可靠读取目录，不推定任何模型可用。'}{catalog?.reason && <><br />{catalog.reason}</>}</span></div>
      <dl className="detail-metadata">
        <div><dt>ZCode 配置声明的默认模型（不是桌面会话模型）</dt><dd>{catalog?.configuredDefault ? <code>{catalog.configuredDefault.providerId}/{catalog.configuredDefault.modelId}</code> : '配置未声明'}</dd></div>
        <div><dt>已保存的应用默认模型</dt><dd>{state.selection ? <>{state.selection.providerLabel || state.selection.providerId} · {state.selection.label || state.selection.modelId}<br /><code>{state.selection.providerId}/{state.selection.modelId}</code><br />推理级别：{state.selection.reasoningLevel ?? '配置默认 / 不覆盖'}<br />保存时间：{formatDate(state.selection.updatedAt)}</> : '尚未设置；不会自动采用 ZCode 默认或其他提供商'}</dd></div>
        <div><dt>最近检查实际观察到的模型（历史结果）</dt><dd><code>{observedCheck?.model || '未确认'}</code>{observedCheck && <><br />检查时间：{formatDate(observedCheck.checkedAt)}</>}<br />不代表当前配置或当前桌面会话；保存选择不会产生新的观察结果。</dd></div>
        <div><dt>目录来源 / 最近读取</dt><dd>个人显式配置（zcode-personal-config）<br />{formatDate(catalog?.refreshedAt)}<br />已配置不等于认证成功或调用通过。</dd></div>
      </dl>
      {!state.bindingSupport.ready && <div className="notice notice-warning"><Icon name="shield" /><span><strong>原生 ZCode 会话尚未完成真实读写验收</strong><br />{state.bindingSupport.reason || '没有可验证的模型绑定能力，ZCode 连接检查保持禁用。'}<br />不会自动回退到 Bigmodel 或任何其他模型。</span></div>}
      {state.selectionStatus === 'stale' && <div className="notice notice-warning"><Icon name="alert" /><span>已保存的模型选择已失效。请核对目录与推理级别，重新保存确认；失效期间不能发起 ZCode 检查。</span></div>}
      {editor.conflict && !needsRefresh && <div className="notice notice-warning" role="alert"><Icon name="alert" /><span><strong>已读到新的选择版本或目录指纹，本地草稿未被覆盖。</strong><br />请核对上方已保存值及下方草稿；重新确认前不能保存。<div className="button-row section-gap"><button type="button" className="text-button" disabled={controlsDisabled || Boolean(error)} onClick={() => setEditor({ ...editor, conflict: false, confirmation: null, consent: false })}>已核对最新状态，保留草稿继续</button><button type="button" className="text-button" disabled={controlsDisabled || Boolean(error)} onClick={() => setEditor({ source: state, draft: savedDraft(state), dirty: false, conflict: false, confirmation: null, consent: false })}>放弃草稿，采用已保存值</button></div></span></div>}
      <div className="form-grid form-grid-three">
        <Field label="提供商" hint="来自本次目录，不自动选择或回退。"><select value={draft.providerId} disabled={controlsDisabled || catalog?.coverage === 'unavailable'} onChange={event => updateDraft({ providerId: event.target.value, modelId: '', reasoningLevel: null })}>
          <option value="">请选择已配置提供商</option>
          {draft.providerId && !providers.some(([id]) => id === draft.providerId) && <option value={draft.providerId} disabled>{draft.providerId} · 已不在目录</option>}
          {providers.map(([id, label]) => <option key={id} value={id}>{label}{label !== id ? ` · ${id}` : ''}</option>)}
        </select></Field>
        <Field label="模型" hint="未启用或凭据可用性未声明的条目不可保存；协议不支持绑定不妨碍保存。"><select value={draft.modelId} disabled={controlsDisabled || !draft.providerId || catalog?.coverage === 'unavailable'} onChange={event => updateDraft({ ...draft, modelId: event.target.value, reasoningLevel: null })}>
          <option value="">{models.length ? '请选择已配置模型' : '此提供商没有目录条目'}</option>
          {draft.modelId && !selected && <option value={draft.modelId} disabled>{draft.modelId} · 已不在目录</option>}
          {models.map(model => <option key={model.id} value={model.id} disabled={!model.enabled || !model.availabilityConfigured}>{model.label || model.modelId} · {model.modelId}{!model.enabled ? ' · 未启用' : !model.availabilityConfigured ? ' · 可用性未声明' : ''}</option>)}
        </select></Field>
        <Field label="思考强度" hint={selected?.reasoningSupport === 'unknown' ? '模型规格未知，不能猜测档位。' : `来源：${reasoningSourceLabel(selected?.reasoningSource)}；保存不会调用模型。`}><select value={draft.reasoningLevel ?? ''} disabled={controlsDisabled || !selected || selected.reasoningSupport === 'unsupported'} onChange={event => updateDraft({ ...draft, reasoningLevel: event.target.value || null })}>
          <option value="">{selected?.reasoningDefault ? `跟随默认：${reasoningValueLabel(selected.reasoningDefault)}（${reasoningSourceLabel(selected.reasoningSource)}）` : selected?.reasoningSupport === 'unsupported' ? '不支持可调思考强度' : '默认强度未知'}</option>
          {draft.reasoningLevel !== null && !validReasoning && <option value={draft.reasoningLevel} disabled>{draft.reasoningLevel} · 目录已不再声明</option>}
          {(selected?.reasoningLevels ?? []).filter(level => level !== '').map(level => <option key={level} value={level}>{reasoningOptionLabel(level)}</option>)}
        </select></Field>
      </div>
      {selected && <p className="field-hint">目录条目：{selected.enabled ? '已启用' : '未启用'} · 可用性：{selected.availabilityConfigured ? '配置已声明（未验证）' : '配置未声明'} · 来源：个人显式配置。{selected.reason}</p>}
      {draft.modelId && (!selected || !validReasoning || !selected.enabled || !selected.availabilityConfigured) && <p className="field-hint" role="alert">草稿中的模型或推理级别已不可选，请重新选择。页面不会自动换成其他模型。</p>}
      <div className="button-row"><button type="button" className="button button-primary" disabled={!canSave} onClick={beginSave}><Icon name="check" size={16} />{saving ? '保存应用模型中…' : '保存应用默认模型'}</button>{editor.dirty && <Badge tone="amber">有未保存的选择</Badge>}</div>
    </>}
    <p className="field-hint">这里只保存应用默认。员工可在「组织员工 → 配置模型」单独覆盖；不改写 ZCode 默认值，不提供密钥或原始配置编辑。</p>
    <ModelApiTestPanel scope="app" binding={state?.selection} catalog={state?.catalog} invalidationKey={state?.selectionStatus} disabled={state?.selectionStatus !== 'configured' || saving || editor.dirty || needsRefresh || Boolean(error)} disabledReason={editor.dirty ? '请先保存当前模型与思考强度。' : state?.selectionStatus !== 'configured' ? '模型配置尚未保存或已失效，请重新确认。' : undefined} />
    {confirmation && <Modal title="确认保存应用默认模型" eyebrow="EXPLICIT CONSENT / 仅修改应用本地选择" busy={saving} onClose={close}><form onSubmit={submit}><div className="modal-body action-body">
      <p className="form-context">{confirmation.providerLabel} · {confirmation.label}<br />推理级别：{confirmation.reasoningLevel ?? '配置默认 / 不覆盖'}</p>
      <div className="notice notice-warning section-gap"><Icon name="shield" /><span><strong>保存会使既有检查失效，并取消所有排队或运行中的真实（ZCode）任务。</strong><br />实际执行进程会被中止；模拟任务不受影响。请在保存前确认可以取消这些真实任务。</span></div>
      <p className="section-gap">本次保存不调用模型、不自动发起连接检查、不修改上游或用户级默认模型。仅提交应用本地选择，并校验应用选择版本与目录指纹；发生冲突时不会自动覆盖或重试。</p>
      {!state?.bindingSupport.ready && <p className="field-hint section-gap">原生 ZCode 会话尚未通过真实读写验收；保存后仍需由你显式发起检查。</p>}
      {(!confirmationCurrent || !canSave) && <ErrorNotice message="目录、选择或执行状态已变化，请取消并刷新元数据，再重新核对确认。" />}
      <label className="checkbox-label consent section-gap"><input type="checkbox" required checked={consent} disabled={saving} onChange={event => setEditor({ ...editor, consent: event.target.checked })} /><span>我确认使既有检查失效并取消所有排队或运行中的真实任务；此次仅保存应用选择，不调用模型、不修改上游默认配置。</span></label>
    </div><footer className="modal-footer"><button type="button" className="button button-secondary" disabled={saving} onClick={close}>取消</button><button type="submit" className="button button-primary" disabled={saving || !consent || !canSave || !confirmationCurrent}>确认保存（不调用模型）</button></footer></form></Modal>}
  </section>;
}
