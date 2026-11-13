import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppModelSelection, Capability, ConfiguredModel, ModelBinding, ModelCatalog, ModelCatalogState, ModelRef, EffectiveModelBinding, EmployeeModelPreference, EmployeeModelState } from '../shared/types.js';
import { Store, now } from './db.js';
import { AppError, busyStatuses, type Actor } from './policy.js';
import { resolveModelSpec } from './model-specs.js';

type Options = { configPath?: string; builtinConfigPath?: string; bindingSupport?: (binding?: ModelBinding) => Capability };
type Data = Record<string, unknown>;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_RULES = 4096;
const UNSUPPORTED = '当前模型绑定尚未通过原生 ZCode 会话验收；不会回退到默认模型。';
const PARTIAL = '仅读取个人配置中显式列出的模型，未合并内置模板，目录可能不完整。已配置仅表示存在非空 apiKey 字段，不代表认证、额度、网络或执行能力已验证。';
const SKIPPED = '已忽略无法安全识别的规则、字段或名称。';
const DEFAULT_UNKNOWN = '配置中的默认模型无法在此目录中确认；不会猜测或回退。';
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const revision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const unsupported = (): Capability => ({ ready: false, reason: UNSUPPORTED });

function data(value: unknown): value is Data {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
const credentialText = /(?:\b(?:sk|rk|pk|ghp|github_pat|xox[baprs])[-_][a-z0-9_-]+|\b(?:bearer|authorization|password|credential|api[_ -]?key|access[_ -]?token|client[_ -]?secret)\b|:\/\/|www\.|(?:[a-z0-9-]+\.)+(?:com|net|org|invalid|local)\b)/i;
function literal(value: unknown, kind: 'provider' | 'model' | 'reasoning'): value is string {
  if (typeof value !== 'string' || credentialText.test(value)) return false;
  if (kind === 'reasoning') return /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/.test(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.length > (kind === 'provider' ? 80 : 160)) return false;
  return !value.split('/').some(segment => !segment || segment === '.' || segment === '..') && (kind === 'model' || !value.includes('/'));
}
function name(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 96 && Buffer.byteLength(value) <= 256 && value.trim() === value
    && /^[\p{L}\p{N}][\p{L}\p{N} ._()/\-]*$/u.test(value) && !credentialText.test(value);
}

// Also reject credentials copied into otherwise innocuous-looking names/IDs. This bounded
// walk never returns config values; only the safe projection below escapes the parser.
function sensitiveValues(value: unknown): Set<string> | null {
  const found = new Set<string>(), seen = new Set<object>();
  const sensitiveKey = /^(?:api[_-]?key|keys?|.*token|password|secret|client[_-]?secret|credentials?|headers?|authorization|cookies?|base[_-]?url)$/i;
  let remaining = 60000;
  const visit = (item: unknown, sensitive: boolean, depth: number): boolean => {
    if (--remaining < 0 || depth > 64) return false;
    if (typeof item === 'string') { if (sensitive && item.trim()) found.add(item.trim()); return true; }
    if (!item || typeof item !== 'object') return item === null || ['undefined', 'boolean', 'number'].includes(typeof item);
    if (seen.has(item)) return false;
    seen.add(item);
    if (Array.isArray(item)) {
      if (item.length > MAX_RULES || Object.getPrototypeOf(item) !== Array.prototype) return false;
      for (let i = 0; i < item.length; i++) {
        const field = Object.getOwnPropertyDescriptor(item, String(i));
        if (!field || !('value' in field) || !visit(field.value, sensitive, depth + 1)) return false;
      }
    } else {
      if (!data(item)) return false;
      for (const key of Object.keys(item)) if (!visit(item[key], sensitive || sensitiveKey.test(key), depth + 1)) return false;
    }
    seen.delete(item);
    return true;
  };
  return visit(value, false, 0) ? found : null;
}
function unavailable(refreshedAt: string, reason: string): ModelCatalog {
  return { models: [], source: 'zcode-personal-config', coverage: 'unavailable', reason, catalogRevision: null, configuredDefault: null, refreshedAt };
}

export function parseModelCatalog(value: unknown, refreshedAt = now(), builtin?: unknown): ModelCatalog {
  // Never reflect an arbitrary caller-supplied timestamp into the response.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(refreshedAt) || !Number.isFinite(Date.parse(refreshedAt))) refreshedAt = now();
  const invalid = () => unavailable(refreshedAt, '个人模型配置的结构或版本不受支持，未读取任何可用目录。');
  const secrets = sensitiveValues(value);
  if (!secrets || !data(value) || value.schemaVersion !== 1 || !data(value.config)) return invalid();
  const config = value.config;
  if (!data(config.providerConfigRules) || !Array.isArray(config.providerConfigRules.providerRules)
    || !data(config.modelConfigRules) || !Array.isArray(config.modelConfigRules.providerModelRules)) return invalid();
  const safe = (text: string) => !secrets.has(text) && ![...secrets].some(secret => secret.length >= 6 && text.includes(secret));
  const safeLiteral = (entry: unknown, kind: 'provider' | 'model' | 'reasoning'): entry is string => literal(entry, kind) && safe(entry);
  let skipped = false;
  const label = (entry: unknown, fallback: string) => {
    if (entry === undefined) return fallback;
    if (name(entry) && safe(entry)) return entry;
    skipped = true; return fallback;
  };
  const orderedIds = (entry: unknown, kind: 'provider' | 'model'): string[] => {
    if (!Array.isArray(entry)) { skipped = true; return []; }
    const result: string[] = [];
    for (const id of entry) {
      if (safeLiteral(id, kind) && !result.includes(id)) result.push(id); else skipped = true;
    }
    return result;
  };
  const order = <T>(entries: T[], ids: string[], getId: (entry: T) => string): T[] => {
    const rank = new Map(ids.map((id, i) => [id, i]));
    return entries.sort((a, b) => (rank.get(getId(a)) ?? ids.length) - (rank.get(getId(b)) ?? ids.length));
  };
  type Rule = { enabled: boolean; label: unknown; reasoningLevels: string[] };
  const rules = new Map<string, Rule | null>();
  for (const entry of config.modelConfigRules.providerModelRules) {
    if (!data(entry) || !safeLiteral(entry.providerId, 'provider') || !safeLiteral(entry.modelId, 'model')) { skipped = true; continue; }
    const id = `${entry.providerId}/${entry.modelId}`;
    if (rules.has(id) || !data(entry.config) || (entry.config.enabled !== undefined && typeof entry.config.enabled !== 'boolean')) {
      skipped = true; rules.set(id, null); continue;
    }
    const rule = entry.config, reasoningLevels: string[] = [];
    if (rule.optionSpecs !== undefined) {
      if (!data(rule.optionSpecs)) skipped = true;
      else if (rule.optionSpecs.reasoningLevel !== undefined) {
        const spec = rule.optionSpecs.reasoningLevel;
        if (!data(spec) || !Array.isArray(spec.values) || spec.values.length > 24) skipped = true;
        else for (const level of spec.values) {
          if (safeLiteral(level, 'reasoning') && !reasoningLevels.includes(level)) reasoningLevels.push(level); else skipped = true;
        }
      }
    }
    rules.set(id, { enabled: rule.enabled !== false, label: data(rule.properties) ? rule.properties.name : undefined, reasoningLevels });
  }
  // Manual/template/wildcard rules have no verified merge semantics. Never invent rows from them.
  if (!Array.isArray(config.modelConfigRules.manualProviderModelRules) || config.modelConfigRules.manualProviderModelRules.length) skipped = true;
  const providers = new Map<string, Data | null>();
  for (const entry of config.providerConfigRules.providerRules) {
    if (!data(entry) || !safeLiteral(entry.providerId, 'provider')) { skipped = true; continue; }
    if (providers.has(entry.providerId)) { providers.set(entry.providerId, null); skipped = true; }
    else providers.set(entry.providerId, entry);
  }
  const models: ConfiguredModel[] = [];
  const providerIds = orderedIds(config.providerOrder, 'provider');
  for (const [providerId, entry] of order([...providers], providerIds, item => item[0])) {
    if (!entry || !data(entry.config) || entry.config.group !== 'standard-personal' || !Array.isArray(entry.config.personalModelIds)) { skipped = true; continue; }
    const provider = entry.config, providerLabel = label(entry.providerName, providerId);
    const ids = orderedIds(provider.personalModelIds, 'model');
    const availabilityConfigured = data(provider.access) && typeof provider.access.apiKey === 'string' && !!provider.access.apiKey.trim();
    for (const modelId of order(ids, orderedIds(provider.modelOrder, 'model'), id => id)) {
      const id = `${providerId}/${modelId}`, rule = rules.get(id);
      if (rule === null) continue;
      const spec = resolveModelSpec(builtin, value, providerId, modelId);
      const safeSpec = spec.levels.every(level => safeLiteral(level, 'reasoning')) && (spec.defaultLevel === null || safeLiteral(spec.defaultLevel, 'reasoning'));
      if (!safeSpec) skipped = true;
      models.push({ id, providerId, modelId, providerLabel, label: label(rule?.label, modelId), enabled: rule?.enabled ?? true,
        availabilityConfigured, reasoningLevels: safeSpec ? spec.levels : [], reasoningDefault: safeSpec ? spec.defaultLevel : null, reasoningSource: safeSpec ? spec.source : 'unknown', reasoningSupport: safeSpec ? spec.support : 'unknown', source: 'personal-config', executionSupport: 'session-adapter', reason: '由原生 ZCode app-server 会话适配器执行；尚未完成当前配置的真实读写验收。' });
      if (models.length > MAX_RULES) return invalid();
    }
  }
  // A rule alone is not proof a personal model exists, nor a source for a built-in list.
  const knownIds = new Set(models.map(model => model.id));
  if ([...rules.keys()].some(id => !knownIds.has(id))) skipped = true;
  let configuredDefault: ModelRef | null = null;
  const selected = config.defaultModelSelection;
  if (data(selected) && safeLiteral(selected.providerId, 'provider') && safeLiteral(selected.modelId, 'model')) {
    const model = models.find(model => model.providerId === selected.providerId && model.modelId === selected.modelId);
    const validOptions = selected.options === undefined || (data(selected.options) && (selected.options.reasoningLevel === undefined
      || (safeLiteral(selected.options.reasoningLevel, 'reasoning') && model?.reasoningLevels.includes(selected.options.reasoningLevel))));
    if (model?.enabled && model.availabilityConfigured && validOptions) configuredDefault = { providerId: model.providerId, modelId: model.modelId };
  }
  const reason = [PARTIAL, skipped ? SKIPPED : '', selected !== undefined && !configuredDefault ? DEFAULT_UNKNOWN : ''].filter(Boolean).join(' ');
  // The pure parser hashes only its projection. The file reader replaces this with a hash
  // of the exact bytes, so even a credential-only edit invalidates saved selections.
  return { models, source: 'zcode-personal-config', coverage: 'partial', reason,
    catalogRevision: fingerprint({ models, configuredDefault, reason }), configuredDefault, refreshedAt };
}

function localPath(file: string): boolean {
  if (!file || file.length > 4096 || !path.isAbsolute(file) || /^[\\/]{2}/.test(file) || /[\u0000-\u001f\u007f]/.test(file)) return false;
  const remainder = file.slice(path.parse(file).root.length), segments = remainder.split(/[\\/]/);
  return !segments.some(segment => segment === '.' || segment === '..' || (process.platform === 'win32'
    && (/[<>:"|?*]|[. ]$/.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))));
}
function sameFile(a: fs.Stats, b: fs.Stats) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function readKnownJson(file: string): { value: unknown; hash: string } {
  let fd: number | undefined;
  try {
    if (typeof file !== 'string' || !localPath(file)) throw new Error('unsafe');
    for (let current = path.dirname(file); ; current = path.dirname(current)) {
      const parent = fs.lstatSync(current);
      if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error('unsafe');
      if (path.dirname(current) === current) break;
    }
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES) throw new Error('unsafe');
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error('changed');
    const buffer = Buffer.alloc(opened.size + 1);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead !== opened.size || !sameFile(opened, fs.fstatSync(fd)) || !sameFile(opened, fs.lstatSync(file))) throw new Error('changed');
    const bytes = buffer.subarray(0, bytesRead);
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), hash: createHash('sha256').update(bytes).digest('hex') };
  } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* no raw diagnostics */ } } }
}
/** Server-private snapshot. Raw data must never be returned by an HTTP route or persisted. */
export function readModelConfigSnapshot(options: Options = {}): { personal: unknown; builtin: unknown; catalog: ModelCatalog } {
  const refreshedAt = now();
  try {
    const file = options.configPath ?? process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ?? path.join(process.env.ZCODE_DATA_BASE_DIR || os.homedir(), '.zcode', 'v2', 'provider_config.json');
    const personal = readKnownJson(file);
    let builtin: { value: unknown; hash: string } | null = null;
    if (options.builtinConfigPath) {
      try { builtin = readKnownJson(options.builtinConfigPath); }
      catch { /* Missing specs remain explicitly unknown, never guessed. */ }
    }
    const catalog = parseModelCatalog(personal.value, refreshedAt, builtin?.value);
    if (catalog.coverage !== 'unavailable') catalog.catalogRevision = options.builtinConfigPath ? fingerprint(['model-specs-v1', personal.hash, builtin?.hash ?? 'unavailable']) : personal.hash;
    return { personal: personal.value, builtin: builtin?.value, catalog };
  } catch {
    return { personal: null, builtin: null, catalog: unavailable(refreshedAt, '无法安全读取个人模型配置，文件可能缺失、无权访问或不是有效 JSON。') };
  }
}
export function readModelCatalog(options: Options = {}): ModelCatalog { return readModelConfigSnapshot(options).catalog; }

function binding(value: unknown): ModelBinding | null {
  if (!data(value) || !literal(value.providerId, 'provider') || !literal(value.modelId, 'model')
    || value.catalogId !== `${value.providerId}/${value.modelId}` || !revision(value.selectionRevision) || value.selectionRevision < 1
    || !digest(value.catalogRevision) || !digest(value.selectionFingerprint)
    || (value.reasoningLevel !== null && !literal(value.reasoningLevel, 'reasoning'))) return null;
  return { providerId: value.providerId, modelId: value.modelId, catalogId: value.catalogId as string, reasoningLevel: value.reasoningLevel,
    selectionRevision: value.selectionRevision, catalogRevision: value.catalogRevision, selectionFingerprint: value.selectionFingerprint };
}
function selectionFingerprint(value: Omit<ModelBinding, 'selectionFingerprint'>): string {
  return fingerprint([value.providerId, value.modelId, value.catalogId, value.reasoningLevel, value.catalogRevision, value.selectionRevision]);
}
function savedSelection(value: unknown): AppModelSelection | null {
  const selected = binding(value);
  if (!selected || !data(value) || value.id !== 'app-default' || typeof value.updatedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.updatedAt) || !Number.isFinite(Date.parse(value.updatedAt))
    || !literal(value.updatedBy, 'model')) return null;
  return { ...selected, id: 'app-default', providerLabel: name(value.providerLabel) ? value.providerLabel : selected.providerId,
    label: name(value.label) ? value.label : selected.modelId, updatedAt: value.updatedAt, updatedBy: value.updatedBy };
}
function overlay(catalog: ModelCatalog, record: unknown, bindingSupport?: (binding?: ModelBinding) => Capability): ModelCatalogState {
  const selection = savedSelection(record);
  const selectionRevision = data(record) && revision(record.selectionRevision) ? record.selectionRevision : 0;
  const model = selection && catalog.models.find(model => model.id === selection.catalogId && model.providerId === selection.providerId && model.modelId === selection.modelId);
  const current = selection && model?.enabled && model.availabilityConfigured && catalog.catalogRevision === selection.catalogRevision
    && selection.selectionFingerprint === selectionFingerprint(selection)
    && (selection.reasoningLevel === null || model.reasoningLevels.includes(selection.reasoningLevel));
  const currentBinding = current ? binding(selection) ?? undefined : undefined;
  return { catalog, selection, selectionRevision, selectionStatus: record == null ? 'unset' : current ? 'configured' : 'stale', bindingSupport: bindingSupport ? bindingSupport(currentBinding) : unsupported() };
}
function inputSelection(input: unknown): { modelId: string; reasoningLevel: string | null; expectedRevision: number; expectedCatalogRevision: string } {
  const fields = ['modelId', 'reasoningLevel', 'expectedRevision', 'expectedCatalogRevision'];
  if (!data(input) || Object.keys(input).length !== fields.length || fields.some(field => !Object.hasOwn(input, field))) throw new AppError('模型选择请求包含缺失或不允许的字段');
  const modelId = input.modelId;
  if (typeof modelId !== 'string' || !modelId.includes('/') || !literal(modelId.slice(0, modelId.indexOf('/')), 'provider') || !literal(modelId.slice(modelId.indexOf('/') + 1), 'model')
    || (input.reasoningLevel !== null && !literal(input.reasoningLevel, 'reasoning')) || !revision(input.expectedRevision) || !digest(input.expectedCatalogRevision)) throw new AppError('模型选择参数无效');
  return { modelId, reasoningLevel: input.reasoningLevel, expectedRevision: input.expectedRevision, expectedCatalogRevision: input.expectedCatalogRevision };
}

export class ModelCatalogService {
  constructor(readonly store: Store, private readonly options: Options = {}) {}

  read(): ModelCatalogState {
    return overlay(readModelCatalog(this.options), this.store.get('modelSelections', 'app-default'), this.options.bindingSupport);
  }

  select(actor: Actor, input: unknown, onChanged?: () => void): ModelCatalogState {
    if (!data(actor) || actor.type !== 'user' || !literal(actor.id, 'model') || !this.store.sql.prepare('SELECT id FROM users WHERE id=?').get(actor.id)) throw new AppError('只有已登录且存在的本人可以更改应用模型', 403);
    const selected = inputSelection(input);
    return this.store.transaction(() => {
      // Re-read under the write transaction: a prior UI snapshot is never authority.
      const record = this.store.get('modelSelections', 'app-default');
      const state = overlay(readModelCatalog(this.options), record, this.options.bindingSupport);
      if (record && (!revision(record.selectionRevision) || record.selectionRevision < 1)) throw new AppError('已保存的模型修订无效，无法安全更新', 409);
      if (state.selectionRevision !== selected.expectedRevision || state.catalog.catalogRevision !== selected.expectedCatalogRevision) throw new AppError('模型选择或本机配置已变化，请重新加载后选择', 409);
      const model = state.catalog.models.find(model => model.id === selected.modelId);
      if (!model || !model.enabled || !model.availabilityConfigured) throw new AppError('模型不存在、已停用或未配置凭据');
      if (selected.reasoningLevel !== null && !model.reasoningLevels.includes(selected.reasoningLevel)) throw new AppError('该模型未显式声明所选推理级别');
      if (state.selectionStatus === 'configured' && state.selection?.catalogId === model.id && state.selection.reasoningLevel === selected.reasoningLevel) return state;
      if (state.selectionRevision >= Number.MAX_SAFE_INTEGER) throw new AppError('模型修订号已达到安全上限', 409);
      const nextBinding = { providerId: model.providerId, modelId: model.modelId, catalogId: model.id, reasoningLevel: selected.reasoningLevel,
        selectionRevision: state.selectionRevision + 1, catalogRevision: selected.expectedCatalogRevision };
      const next: AppModelSelection = { ...nextBinding, selectionFingerprint: selectionFingerprint(nextBinding), id: 'app-default',
        providerLabel: model.providerLabel, label: model.label, updatedAt: now(), updatedBy: actor.id };
      this.store.put('modelSelections', next);
      this.store.audit(actor.id, '应用默认模型变更', next.id, model.id);
      // Callback owns no transaction: DB revocations/audits join this transaction and
      // roll back on failure. Cancel running workflows only AFTER select() commits.
      onChanged?.();
      // A synchronous callback may take time; do not commit against a changed file.
      const after = readModelCatalog(this.options);
      if (after.catalogRevision !== selected.expectedCatalogRevision) throw new AppError('本机模型配置已变化，选择未保存，请重新加载', 409);
      return overlay(after, next);
    });
  }

  resolveSelectedModel(expected?: ModelBinding): ModelBinding {
    const state = this.read();
    if (state.selectionStatus !== 'configured' || !state.selection) throw new AppError('应用模型尚未选择或已失效，请重新选择；不会使用默认模型替代', 409);
    const current = binding(state.selection)!;
    if (expected !== undefined) {
      const prior = binding(expected);
      if (!prior || prior.selectionFingerprint !== selectionFingerprint(prior) || selectionFingerprint(prior) !== current.selectionFingerprint) throw new AppError('模型绑定已变化，旧检查或任务不可复用', 409);
    }
    // Resolving identity does not authorize execution; callers must check support.
    return current;
  }

  private employeePreference(employeeId: string): EmployeeModelPreference | null {
    return this.store.get('employeeModelPreferences', employeeId);
  }
  readEmployee(employeeId: string): EmployeeModelState {
    const employee = this.store.get('employees', employeeId);
    if (!employee) throw new AppError('员工不存在', 404);
    const preference = this.employeePreference(employeeId);
    const app = this.read();
    const mode = preference?.mode ?? 'inherit-app';
    let selection: ModelBinding | null = mode === 'override' ? preference?.binding ?? null : app.selection;
    let effectiveBinding: EffectiveModelBinding | null = null;
    let effectiveStatus: EmployeeModelState['effectiveStatus'] = selection ? 'stale' : 'unset';
    let reason = selection ? '配置已失效，请重新选择；不会回退其他模型' : '尚未配置有效模型';
    const model = selection && app.catalog.models.find(item => item.id === selection!.catalogId);
    if (employee.enabled && selection && model?.enabled && model.availabilityConfigured && selection.catalogRevision === app.catalog.catalogRevision && selection.selectionFingerprint === selectionFingerprint(selection) && (selection.reasoningLevel === null || model.reasoningLevels.includes(selection.reasoningLevel))) {
      const source = mode === 'override' ? 'employee-override' : 'app-default';
      const selectedBinding = binding(selection)!;
      effectiveBinding = { ...selectedBinding, source, employeeId,
        selectionFingerprint: fingerprint(['employee-effective-v1', employeeId, source, preference?.revision ?? 0, selection.selectionFingerprint]) };
      effectiveStatus = 'configured'; reason = mode === 'override' ? '使用员工独立模型配置' : '继承应用默认模型';
    } else if (!employee.enabled) reason = '员工已停用';
    return { employeeId, mode, preferenceRevision: preference?.revision ?? 0, selection, effectiveBinding, effectiveStatus, reason, catalog: app.catalog, effectiveReasoning: effectiveBinding ? effectiveBinding.reasoningLevel ?? model?.reasoningDefault ?? null : null };
  }
  selectEmployee(actor: Actor, employeeId: string, input: unknown, onChanged?: () => void): EmployeeModelState {
    if (!data(actor) || actor.type !== 'user' || !this.store.sql.prepare('SELECT id FROM users WHERE id=?').get(actor.id)) throw new AppError('只有已登录本人可修改员工模型', 403);
    if (!data(input) || (input.mode !== 'inherit-app' && input.mode !== 'override') || !revision(input.expectedRevision)) throw new AppError('员工模型配置无效');
    const allowed = input.mode === 'inherit-app' ? ['mode', 'expectedRevision'] : ['mode', 'expectedRevision', 'modelId', 'reasoningLevel', 'expectedCatalogRevision'];
    if (Object.keys(input).length !== allowed.length || Object.keys(input).some(key => !allowed.includes(key))) throw new AppError('员工模型字段无效');
    return this.store.transaction(() => {
      const employee = this.store.get('employees', employeeId);
      if (!employee) throw new AppError('员工不存在', 404);
      if (this.store.all('tasks').some(task => busyStatuses.includes(task.status) && [task.leaderId, task.developerId, task.qaId].includes(employeeId)) || this.store.all('runs').some(run => run.employeeId === employeeId && run.status === 'running')) throw new AppError('员工有排队或运行中的任务，不能修改模型', 409);
      const previous = this.employeePreference(employeeId);
      if ((previous?.revision ?? 0) !== input.expectedRevision) throw new AppError('员工模型配置已变化，请刷新后重试', 409);
      let selected: ModelBinding | null = null;
      if (input.mode === 'override') {
        if (!employee.enabled) throw new AppError('停用员工不能配置独立模型');
        const request = inputSelection({ modelId: input.modelId, reasoningLevel: input.reasoningLevel, expectedRevision: input.expectedRevision, expectedCatalogRevision: input.expectedCatalogRevision });
        const catalog = readModelCatalog(this.options);
        if (catalog.catalogRevision !== request.expectedCatalogRevision) throw new AppError('模型目录已变化，请重新选择', 409);
        const model = catalog.models.find(item => item.id === request.modelId);
        if (!model?.enabled || !model.availabilityConfigured || request.reasoningLevel !== null && !model.reasoningLevels.includes(request.reasoningLevel)) throw new AppError('模型或思考强度不可用');
        if (previous?.mode === 'override' && previous.binding?.catalogId === model.id && previous.binding.reasoningLevel === request.reasoningLevel && previous.binding.catalogRevision === catalog.catalogRevision) return this.readEmployee(employeeId);
        const partial = { providerId: model.providerId, modelId: model.modelId, catalogId: model.id, reasoningLevel: request.reasoningLevel, selectionRevision: (previous?.revision ?? 0) + 1, catalogRevision: catalog.catalogRevision! };
        selected = { ...partial, selectionFingerprint: selectionFingerprint(partial) };
      } else if (previous?.mode === 'inherit-app') return this.readEmployee(employeeId);
      const preference: EmployeeModelPreference = { id: employeeId, employeeId, mode: input.mode as 'inherit-app' | 'override', revision: (previous?.revision ?? 0) + 1, binding: selected, updatedAt: now(), updatedBy: actor.id };
      this.store.put('employeeModelPreferences', preference);
      this.store.audit(actor.id, '员工模型配置变更', employeeId, input.mode === 'override' ? `独立模型 ${selected!.catalogId}` : '恢复继承应用默认');
      onChanged?.();
      if (selected && readModelCatalog(this.options).catalogRevision !== selected.catalogRevision) throw new AppError('保存期间模型配置变化，请重试', 409);
      return this.readEmployee(employeeId);
    });
  }
  effectiveBinding(employeeId: string, expected?: ModelBinding): EffectiveModelBinding {
    const state = this.readEmployee(employeeId);
    if (state.effectiveStatus !== 'configured' || !state.effectiveBinding) throw new AppError(state.reason, 409);
    if (expected && (expected.selectionFingerprint !== state.effectiveBinding.selectionFingerprint || expected.catalogRevision !== state.effectiveBinding.catalogRevision || expected.providerId !== state.effectiveBinding.providerId || expected.modelId !== state.effectiveBinding.modelId || expected.reasoningLevel !== state.effectiveBinding.reasoningLevel)) throw new AppError('员工模型绑定已变化，旧任务或检查不可复用', 409);
    return state.effectiveBinding;
  }
  effectiveReasoning(binding: ModelBinding): string | null {
    const snapshot = readModelConfigSnapshot(this.options);
    if (snapshot.catalog.catalogRevision !== binding.catalogRevision) throw new AppError('模型目录已变化，请重新确认思考强度', 409);
    const model = snapshot.catalog.models.find(item => item.id === binding.catalogId && item.providerId === binding.providerId && item.modelId === binding.modelId);
    if (!model?.enabled || !model.availabilityConfigured) throw new AppError('模型未配置或不可用', 409);
    const spec = resolveModelSpec(snapshot.builtin, snapshot.personal, binding.providerId, binding.modelId);
    const level = binding.reasoningLevel ?? spec.defaultLevel;
    if (spec.support === 'unknown' || (level !== null && !spec.levels.includes(level))) throw new AppError('思考强度规格未知或已失效', 409);
    return level;
  }
  resolveApiConfig(selected: ModelBinding): { baseUrl: string; apiKey: string; apiType: 'openai-chat-completions' | 'openai-responses' | 'anthropic-messages'; effectiveReasoning: string | null; reasoningMap: string | null; maxOutputMap: string | null; catalogRevision: string } {
    const snapshot = readModelConfigSnapshot(this.options);
    if (snapshot.catalog.catalogRevision !== selected.catalogRevision || !data(snapshot.personal) || !data(snapshot.personal.config)) throw new AppError('模型目录已变化或无法读取', 409);
    const model = snapshot.catalog.models.find(item => item.id === selected.catalogId && item.providerId === selected.providerId && item.modelId === selected.modelId);
    if (!model?.enabled || !model.availabilityConfigured) throw new AppError('模型未配置或不可用', 409);
    const providers = data(snapshot.personal.config.providerConfigRules) ? snapshot.personal.config.providerConfigRules.providerRules : null;
    const candidates = Array.isArray(providers) ? providers.filter(item => data(item) && item.providerId === selected.providerId) : [];
    if (candidates.length !== 1 || !data(candidates[0].config)) throw new AppError('模型提供商配置不唯一');
    const provider = candidates[0].config;
    if (!data(provider.access) || provider.access.type !== 'api-key' || typeof provider.access.apiKey !== 'string' || !provider.access.apiKey.trim() || !data(provider.api) || typeof provider.api.baseUrl !== 'string') throw new AppError('此账号认证形式暂不支持直接API测试；不会解密或替换认证');
    if (Object.keys(provider.api).some(key => !['type', 'baseUrl'].includes(key)) || Object.keys(provider.access).some(key => !['type', 'apiKey'].includes(key))) throw new AppError('服务存在未核验的认证或协议选项，拒绝猜测调用');
    const apiType = provider.api.type;
    if (apiType !== 'openai-chat-completions' && apiType !== 'openai-responses' && apiType !== 'anthropic-messages') throw new AppError('服务协议尚未支持连接测试');
    const spec = resolveModelSpec(snapshot.builtin, snapshot.personal, selected.providerId, selected.modelId);
    if (spec.support === 'unknown') throw new AppError('思考强度规格未知，不能猜测默认参数');
    const effectiveReasoning = selected.reasoningLevel ?? spec.defaultLevel;
    if (effectiveReasoning !== null && !spec.levels.includes(effectiveReasoning)) throw new AppError('所选思考强度已不支持', 409);
    return { baseUrl: provider.api.baseUrl, apiKey: provider.access.apiKey, apiType, effectiveReasoning, reasoningMap: spec.reasoningMap, maxOutputMap: spec.maxOutputMap, catalogRevision: snapshot.catalog.catalogRevision! };
  }
  bindingSupport(binding?: ModelBinding): Capability {
    if (this.options.bindingSupport) return this.options.bindingSupport(binding);
    // Fail closed even for a forged binding or a previously successful check.
    return unsupported();
  }
}
