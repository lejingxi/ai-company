import type { ConfiguredModel, ModelBinding, ModelCatalog } from '../shared/types';

const reasoningLabels: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
  disabled: '关闭',
  enabled: '开启',
  none: '无',
};

const reasoningSourceLabels: Record<string, string> = {
  personal: '个人配置',
  builtin: '内置',
  unknown: '来源未知',
  unsupported: '不支持',
};

export function modelForBinding(binding: ModelBinding | null | undefined, catalog: ModelCatalog | null | undefined): ConfiguredModel | null {
  if (!binding || !catalog) return null;
  return catalog.models.find(model => model.id === binding.catalogId)
    ?? catalog.models.find(model => model.providerId === binding.providerId && model.modelId === binding.modelId)
    ?? null;
}

export function modelLabel(model: ConfiguredModel | null | undefined, binding?: ModelBinding | null): string {
  if (model) return `${model.providerLabel || model.providerId} · ${model.label || model.modelId}`;
  if (binding) return `${binding.providerId} · ${binding.modelId}`;
  return '未选择模型';
}

export function modelIdLabel(model: ConfiguredModel | null | undefined, binding?: ModelBinding | null): string {
  if (model) return `${model.providerId}/${model.modelId}`;
  if (binding) return `${binding.providerId}/${binding.modelId}`;
  return '未选择';
}

export function reasoningValueLabel(value: string | null | undefined): string {
  if (value == null || value === '') return '未声明';
  const label = reasoningLabels[value.toLowerCase()];
  return label ? `${value}（${label}）` : `${value}（目录未提供中文映射，保留原值）`;
}

export function reasoningOptionLabel(value: string): string {
  return reasoningValueLabel(value);
}

export function reasoningSourceLabel(source: ConfiguredModel['reasoningSource']): string {
  return source ? reasoningSourceLabels[source] ?? `来源原值：${source}` : '来源未知';
}

export interface ReasoningResolution {
  value: string | null;
  display: string;
  known: boolean;
  reason: string;
}

export function resolveReasoning(binding: ModelBinding | null | undefined, catalog: ModelCatalog | null | undefined, serverEffective?: string | null): ReasoningResolution {
  if (!binding) return { value: null, display: '未选择模型', known: false, reason: '尚未保存可用的模型选择。' };
  const model = modelForBinding(binding, catalog);
  if (!model) return { value: null, display: '推理强度未知', known: false, reason: '目录中找不到已保存模型，不能安全推断推理强度。' };

  if (binding.reasoningLevel !== null && binding.reasoningLevel !== '') {
    const declared = model.reasoningLevels.includes(binding.reasoningLevel);
    return {
      value: declared ? binding.reasoningLevel : null,
      display: declared ? reasoningValueLabel(binding.reasoningLevel) : `${reasoningValueLabel(binding.reasoningLevel)} · 目录已不再声明`,
      known: declared,
      reason: declared ? '' : '已保存的推理强度不在当前目录声明中，不能发起测试。',
    };
  }

  const defaultValue = model.reasoningDefault ?? serverEffective ?? null;
  if (defaultValue == null || defaultValue === '') {
    return {
      value: null,
      display: '跟随模型默认（未声明）',
      known: false,
      reason: '模型未声明可解析的默认推理强度，不能安全发起测试。',
    };
  }
  const source = model.reasoningDefault != null ? model.reasoningSource : undefined;
  const unsupported = model.reasoningSupport === 'unsupported' || source === 'unsupported';
  const sourceText = source ? `（${reasoningSourceLabel(source)}）` : '（目录未声明来源）';
  return {
    value: unsupported ? null : defaultValue,
    display: `跟随默认：${reasoningValueLabel(defaultValue)}${sourceText}`,
    known: !unsupported && Boolean(model.reasoningDefault != null || serverEffective),
    reason: unsupported ? '该模型目录声明不支持推理强度，不能发起测试。' : (!model.reasoningDefault && !serverEffective ? '默认推理强度来源未知，不能安全发起测试。' : ''),
  };
}

export function effectiveModelSummary(binding: ModelBinding | null | undefined, catalog: ModelCatalog | null | undefined, serverEffective?: string | null): { model: string; id: string; reasoning: ReasoningResolution } {
  const model = modelForBinding(binding, catalog);
  return {
    model: modelLabel(model, binding),
    id: modelIdLabel(model, binding),
    reasoning: resolveReasoning(binding, catalog, serverEffective),
  };
}
