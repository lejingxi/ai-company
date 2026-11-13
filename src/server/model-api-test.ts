import { Store, id, now } from './db.js';
import { AppError, requireHuman, type Actor } from './policy.js';
import { ModelCatalogService } from './model-catalog.js';
import { ModelApiError, requestModelOnce, buildModelRequest, type ModelApiRequest } from './model-api-http.js';
import type { ModelApiTest, ModelApiTestState, ModelBinding } from '../shared/types.js';

type Scope = 'app' | 'employee';
interface Active { recordId: string; controller: AbortController; promise: Promise<void>; }
function scopeCheck(scope: unknown, employeeId: unknown): asserts scope is Scope {
  if ((scope !== 'app' && scope !== 'employee') || (scope === 'app' ? employeeId !== null : typeof employeeId !== 'string' || !/^employee_[A-Za-z0-9_-]{1,100}$/.test(employeeId))) throw new AppError('模型测试作用域或员工 ID 无效');
}
const SAFE_CODES = new Set(['invalid_endpoint', 'endpoint_not_allowed', 'reasoning_unknown', 'reasoning_mapping_unsupported', 'invalid_model', 'auth_config_invalid', 'protocol_unsupported', 'output_mapping_unsupported', 'cancelled', 'timeout', 'dns_failed', 'response_too_large', 'network_error']);

export class ModelApiTests {
  private active: Active | null = null;
  private stopped = false;
  private lastStartedAt = 0;
  private request: ModelApiRequest;
  private timeoutMs: number;
  constructor(private store: Store, private models: ModelCatalogService, options: { request?: ModelApiRequest; timeoutMs?: number } = {}) {
    this.request = options.request ?? requestModelOnce;
    this.timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? 45_000, 45_000));
    for (const record of store.all('modelApiTests').filter(record => record.status === 'running')) store.put('modelApiTests', { ...record, status: 'cancelled', code: 'service_restarted', message: '服务重启中断了测试；未自动重试', endedAt: now() });
  }
  private human(actor: Actor) {
    requireHuman(actor);
    if (!this.store.sql.prepare('SELECT id FROM users WHERE id=?').get(actor.id)) throw new AppError('登录用户不存在', 403);
  }
  private current(scope: Scope, employeeId: string | null, expected?: ModelBinding): ModelBinding {
    if (scope === 'app') return this.models.resolveSelectedModel(expected);
    const employee = this.store.get('employees', employeeId!);
    if (!employee?.enabled) throw new AppError('员工不存在或已停用', 409);
    return this.models.effectiveBinding(employeeId!, expected);
  }
  state(scope: Scope, employeeId: string | null): ModelApiTestState {
    scopeCheck(scope, employeeId);
    const latest = this.store.all('modelApiTests').filter(record => record.scope === scope && record.employeeId === employeeId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
    if (!latest) return { active: false, latest: null };
    let current = latest;
    if (latest.status === 'passed' || latest.status === 'running') {
      try { this.current(scope, employeeId, latest.binding); }
      catch { current = { ...latest, status: 'stale', code: 'selection_changed', message: '模型或配置已变化；此结果不适用于当前选择' }; }
    }
    return { active: this.active?.recordId === latest.id && current.status === 'running', latest: current };
  }
  async start(actor: Actor, input: unknown, sessionValid: () => boolean): Promise<ModelApiTest> {
    this.human(actor);
    if (typeof sessionValid !== 'function' || !sessionValid()) throw new AppError('登录已失效', 401);
    if (this.stopped) throw new AppError('服务正在关闭', 503);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('测试请求必须为对象');
    const value = input as Record<string, unknown>;
    const fields = ['scope', 'employeeId', 'expectedSelectionFingerprint', 'effectiveReasoning', 'requestId', 'confirmCharge'];
    if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key)) || value.confirmCharge !== true || typeof value.expectedSelectionFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.expectedSelectionFingerprint) || typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(value.requestId) || (value.effectiveReasoning !== null && (typeof value.effectiveReasoning !== 'string' || !/^[a-zA-Z0-9_-]{1,24}$/.test(value.effectiveReasoning)))) throw new AppError('测试参数或额度确认无效');
    scopeCheck(value.scope, value.employeeId);
    const scope = value.scope, employeeId = value.employeeId as string | null;
    const previous = this.store.all('modelApiTests').find(record => record.userId === actor.id && record.requestId === value.requestId);
    if (previous) {
      if (previous.scope !== scope || previous.employeeId !== employeeId || previous.binding.selectionFingerprint !== value.expectedSelectionFingerprint || previous.effectiveReasoning !== value.effectiveReasoning) throw new AppError('重复请求标识与原测试内容不一致', 409);
      return previous;
    }
    if (this.active) throw new AppError('已有模型连接测试正在运行，请等待或取消', 409);
    if (Date.now() - this.lastStartedAt < 5000) throw new AppError('测试请求过于频繁，请至少等待5秒', 429);
    const binding = this.current(scope, employeeId);
    if (binding.selectionFingerprint !== value.expectedSelectionFingerprint) throw new AppError('模型选择已变化，请重新核对', 409);
    const connection = this.models.resolveApiConfig(binding);
    if (connection.effectiveReasoning !== value.effectiveReasoning) throw new AppError('有效思考强度已变化，请重新核对', 409);
    // Validate endpoint and exact mapping before accepting a chargeable request. No network occurs here.
    try { buildModelRequest(connection, binding.modelId); }
    catch (error) { throw new AppError(error instanceof ModelApiError ? error.message : '该模型协议或思考强度映射暂不支持测试', 409); }
    const record: ModelApiTest = { id: id('modeltest'), requestId: value.requestId, scope, employeeId, binding, effectiveReasoning: connection.effectiveReasoning, status: 'running', code: 'running', message: '单次固定短提示测试进行中；不会自动重试', durationMs: null, startedAt: now(), endedAt: null, userId: actor.id, reasoningHonored: 'not-confirmed' };
    this.store.transaction(() => { this.store.insert('modelApiTests', record); this.store.audit(actor.id, '显式模型API测试', record.id, `作用域 ${scope}；模型 ${binding.catalogId}；思考强度 ${record.effectiveReasoning ?? '不适用'}；只测试API，不授权ZCode执行`); });
    this.lastStartedAt = Date.now();
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => this.perform(record, connection, controller, sessionValid));
    this.active = { recordId: record.id, controller, promise };
    void promise.finally(() => { if (this.active?.recordId === record.id) this.active = null; });
    return record;
  }
  private async perform(record: ModelApiTest, connection: ReturnType<ModelCatalogService['resolveApiConfig']>, controller: AbortController, sessionValid: () => boolean) {
    const start = Date.now();
    let invalidCode: string | null = null;
    const verify = () => {
      if (!sessionValid()) { invalidCode = 'session_expired'; controller.abort(); return false; }
      try { this.current(record.scope, record.employeeId, record.binding); }
      catch { invalidCode = 'selection_changed'; controller.abort(); return false; }
      if (this.store.get('modelApiTests', record.id)?.status !== 'running') { controller.abort(); return false; }
      return !controller.signal.aborted;
    };
    const timer = setInterval(verify, 250); timer.unref();
    const deadline = setTimeout(() => { invalidCode = 'timeout'; controller.abort(); }, this.timeoutMs); deadline.unref();
    try {
      if (!verify()) throw new ModelApiError('cancelled', '测试已取消');
      const result = await this.request({ connection, modelId: record.binding.modelId, signal: controller.signal, timeoutMs: this.timeoutMs });
      if (!verify()) throw new ModelApiError('cancelled', '测试结果已失效');
      const safeCode = ['generation_received', 'redirect_rejected', 'authentication_failed', 'quota_or_rate_limit', 'reasoning_rejected', 'upstream_error', 'invalid_response', 'output_budget_exhausted', 'no_visible_output'].includes(result.code) ? result.code : 'invalid_response';
      const safeMessages: Record<string, string> = { generation_received: '模型 API 已返回有效生成内容；ZCode 员工、工具与Docker状态不因此改变。', redirect_rejected: '服务返回重定向，未继续请求。', authentication_failed: '认证或模型访问权限被拒绝。', quota_or_rate_limit: '服务额度不足或限流；未重试。', reasoning_rejected: '所选思考强度或请求参数被拒绝；未降档或换协议。', upstream_error: '模型服务返回错误；原始响应未保存。', invalid_response: '响应不是有效生成结果。', output_budget_exhausted: '输出预算耗尽，未取得完整可见回复；没有重试。', no_visible_output: '未返回可见生成内容，不能判定成功。' };
      this.finish(record, { status: safeCode === 'generation_received' && result.status === 'passed' ? 'passed' : 'failed', code: safeCode, message: safeMessages[safeCode], reasoningHonored: result.reasoningHonored === 'reported' ? 'reported' : 'not-confirmed' }, start);
    } catch (error) {
      const code = invalidCode ?? (error instanceof ModelApiError && SAFE_CODES.has(error.code) ? error.code : 'request_failed');
      const stale = code === 'selection_changed';
      this.finish(record, { status: stale ? 'stale' : controller.signal.aborted && code !== 'timeout' ? 'cancelled' : 'failed', code, message: stale ? '模型或配置变化，测试结果已作废' : code === 'session_expired' ? '登录已失效，测试已终止' : code === 'timeout' ? '模型测试超时，没有重试' : code === 'cancelled' ? '测试已取消，不计为成功' : '模型连接测试未通过；已隐藏原始错误和认证信息，没有重试', reasoningHonored: 'not-confirmed' }, start);
    } finally { clearInterval(timer); clearTimeout(deadline); }
  }
  private finish(record: ModelApiTest, result: Pick<ModelApiTest, 'status' | 'code' | 'message' | 'reasoningHonored'>, started: number) {
    const current = this.store.get('modelApiTests', record.id);
    if (current?.status !== 'running') return;
    this.store.transaction(() => { this.store.put('modelApiTests', { ...current, ...result, endedAt: now(), durationMs: Date.now() - started }); this.store.audit('system', '模型API测试结束', record.id, result.code); });
  }
  cancel(actor: Actor, testId: string): ModelApiTest {
    this.human(actor);
    const record = this.store.get('modelApiTests', testId);
    if (!record || record.userId !== actor.id) throw new AppError('测试不存在或无权访问', 404);
    if (record.status !== 'running') return record;
    const next: ModelApiTest = { ...record, status: 'cancelled', code: 'cancelled', message: '用户取消了测试；不自动重试', endedAt: now() };
    this.store.put('modelApiTests', next);
    if (this.active?.recordId === testId) this.active.controller.abort();
    this.store.audit(actor.id, '取消模型API测试', testId, '取消只影响本次测试');
    return next;
  }
  invalidate(scope: Scope, employeeId?: string) {
    for (const record of this.store.all('modelApiTests')) {
      const inherited = !('source' in record.binding) || record.binding.source === 'app-default';
      const affected = scope === 'employee' ? record.employeeId === employeeId : record.scope === 'app' || inherited;
      if (!affected || !['running', 'passed'].includes(record.status)) continue;
      this.store.put('modelApiTests', { ...record, status: 'stale', code: 'selection_changed', message: '对应模型配置已更新，旧测试结果失效', endedAt: record.endedAt ?? now() });
      if (this.active?.recordId === record.id) this.active.controller.abort();
    }
  }
  async shutdown() {
    this.stopped = true;
    if (this.active) { this.active.controller.abort(); await this.active.promise; }
  }
}
