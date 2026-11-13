export interface ResolvedModelSpec {
  levels: string[]; defaultLevel: string | null;
  source: 'personal' | 'builtin' | 'unknown' | 'unsupported';
  support: 'supported' | 'unsupported' | 'unknown';
  apiType: string | null; reasoningMap: string | null; maxOutputMap: string | null; reason: string;
}
type Data = Record<string, unknown>;
const data = (value: unknown): value is Data => !!value && typeof value === 'object' && !Array.isArray(value);
function unknown(apiType: string | null, reason: string): ResolvedModelSpec {
  return { levels: [], defaultLevel: null, source: 'unknown', support: 'unknown', apiType, reasoningMap: null, maxOutputMap: null, reason };
}
function matches(pattern: unknown, value: string): boolean {
  if (typeof pattern !== 'string' || pattern.length > 512 || value.length > 2048) return false;
  try { return new RegExp(`^(?:${pattern})$`, 'i').test(value); } catch { return false; }
}
/** Only data overlays. Never evaluates option-map expressions or imports provider code. */
export function resolveModelSpec(builtin: unknown, personal: unknown, providerId: string, modelId: string): ResolvedModelSpec {
  if (!data(personal) || !data(personal.config) || !data(personal.config.providerConfigRules)) return unknown(null, '个人模型规格无法解析');
  const rules = personal.config.providerConfigRules.providerRules;
  if (!Array.isArray(rules)) return unknown(null, '提供商规则缺失');
  const providers = rules.filter(rule => data(rule) && rule.providerId === providerId);
  if (providers.length !== 1 || !data(providers[0]) || !data(providers[0].config)) return unknown(null, '提供商规则不唯一');
  const provider = providers[0], cfg = provider.config as Data;
  const api = data(cfg.api) ? cfg.api : {};
  const apiType = typeof api.type === 'string' ? api.type : null;
  const baseUrl = typeof api.baseUrl === 'string' ? api.baseUrl : '';
  let values: unknown = undefined, map: unknown = undefined, outputMap: unknown = undefined;
  let source: ResolvedModelSpec['source'] = 'unknown';
  let invalid = false;
  const apply = (config: unknown, owner: 'builtin' | 'personal') => {
    if (!data(config)) { invalid = true; return; }
    if (!Object.hasOwn(config, 'optionSpecs')) return;
    if (!data(config.optionSpecs)) { invalid = true; return; }
    const specs = config.optionSpecs;
    if (Object.hasOwn(specs, 'reasoningLevel')) {
      if (specs.reasoningLevel === null) { values = []; map = null; source = owner; }
      else if (data(specs.reasoningLevel)) {
        if (Object.hasOwn(specs.reasoningLevel, 'values')) { values = specs.reasoningLevel.values; source = owner; }
        if (Object.hasOwn(specs.reasoningLevel, 'map')) map = specs.reasoningLevel.map;
      } else invalid = true;
    }
    if (Object.hasOwn(specs, 'maxOutputTokens')) {
      if (data(specs.maxOutputTokens) && Object.hasOwn(specs.maxOutputTokens, 'map')) outputMap = specs.maxOutputTokens.map;
      else if (specs.maxOutputTokens !== null && !data(specs.maxOutputTokens)) invalid = true;
    }
  };
  if (data(builtin) && builtin.schemaVersion === 1 && data(builtin.config) && data(builtin.config.modelConfigRules)) {
    const groups = builtin.config.modelConfigRules;
    for (const group of ['modelRules', 'modelApiRules', 'providerSiteRules', 'templateModelRules', 'builtinProviderModelRules']) {
      const entries = groups[group];
      if (entries === undefined) continue;
      if (!Array.isArray(entries) || entries.length > 4096) return unknown(apiType, '内置规则结构无效');
      for (const rule of entries) {
        if (!data(rule)) { invalid = true; continue; }
        let match = false;
        if (group === 'modelRules') match = matches(rule.modelMatch, modelId);
        else if (group === 'modelApiRules') match = matches(rule.modelMatch, modelId) && matches(rule.apiTypeMatch, apiType ?? '');
        else if (group === 'providerSiteRules') match = matches(rule.modelMatch, modelId) && matches(rule.apiTypeMatch, apiType ?? '') && matches(rule.baseUrlMatch, baseUrl);
        else if (group === 'templateModelRules') match = rule.templateId === provider.templateId && rule.templateId !== undefined && rule.modelId === modelId;
        else match = rule.providerId === providerId && rule.modelId === modelId;
        if (match) apply(rule.config, 'builtin');
      }
    }
  }
  const models = data(personal.config.modelConfigRules) ? personal.config.modelConfigRules : {};
  const exact = Array.isArray(models.providerModelRules) ? models.providerModelRules.filter(rule => data(rule) && rule.providerId === providerId && rule.modelId === modelId) : [];
  if (exact.length > 1) return unknown(apiType, '个人模型覆盖规则重复');
  for (const rule of exact) apply(rule.config, 'personal');
  const manual = models.manualProviderModelRules;
  if (Array.isArray(manual) && manual.some(rule => !data(rule) || rule.providerId === providerId && rule.modelId === modelId)) return unknown(apiType, '手工模型清理／覆盖规则尚未核验');
  if (invalid) return unknown(apiType, '思考强度覆盖规则无效，拒绝猜测');
  if (!Array.isArray(values) || values.length > 24 || values.some(value => typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,24}$/.test(value)) || new Set(values).size !== values.length) return unknown(apiType, '尚未确定此模型的思考强度规格');
  const levels = values as string[];
  if (!levels.length) return { levels: [], defaultLevel: null, source: 'unsupported', support: 'unsupported', apiType, reasoningMap: null, maxOutputMap: typeof outputMap === 'string' && outputMap.length < 16_384 ? outputMap : null, reason: '配置明确不支持可调思考强度' };
  if (map !== undefined && map !== null && (typeof map !== 'string' || map.length > 16_384)) return unknown(apiType, '思考强度请求映射无效');
  return { levels, defaultLevel: levels.at(-1)!, source, support: 'supported', apiType,
    reasoningMap: typeof map === 'string' ? map : null, maxOutputMap: typeof outputMap === 'string' && outputMap.length < 16_384 ? outputMap : null,
    reason: (source as ResolvedModelSpec['source']) === 'personal' ? '来自个人模型覆盖；默认值为最后一个已声明档位' : '来自安装版 ZCode 内置规格；默认值为最后一个已声明档位' };
}
