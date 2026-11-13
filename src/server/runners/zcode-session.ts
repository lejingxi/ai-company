import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProcessResult } from './process.js';
import {
  buildZcodeEnvironment,
  type ZcodeInvocationPolicy,
  type ZcodeOptions,
  type ZcodeTransport,
} from './zcode.js';
import type { ModelBinding, RunnerInput, Capability } from '../../shared/types.js';
import { readModelConfigSnapshot } from '../model-catalog.js';
import { resolveModelSpec } from '../model-specs.js';
import { acquireConfigReadLock, type ConfigReadLease } from './config-read-lock.js';
import { RpcFault, ZcodeRpcClient } from './zcode-rpc.js';

const MAX_PROMPT_BYTES = 128 * 1024;
const MAX_TOOLS = 100;
const SESSION_PROTOCOL = 'ZCode Protocol';
const SAFE_READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Search', 'ListFiles']);
const SAFE_EDIT_TOOLS = new Set(['Edit', 'Write']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,255}$/;

export interface ZcodeSessionTransportOptions {
  electronPath: string;
  cliPath: string;
  personalConfigPath: string;
  builtinConfigPath: string;
  cliConfigPath?: string;
  timeoutMs: number;
}

type UnknownRecord = Record<string, unknown>;
type Terminal = { kind: 'completed'; response: string; turnId?: string; inputId?: string };
type CallbackRequest = { sessionId?: unknown; requestId?: unknown; toolName?: unknown };

function record(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function safeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}
function safeReasoning(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/.test(value);
}
function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 600);
}
function validPath(file: string): boolean {
  return typeof file === 'string' && path.isAbsolute(file) && !/[\x00-\x1f\x7f]/.test(file);
}
function modelName(binding: ModelBinding): string { return `${binding.providerId}/${binding.modelId}`; }
function selection(binding: ModelBinding, reasoningLevel: string | null): UnknownRecord {
  return { providerId: binding.providerId, modelId: binding.modelId,
    ...(reasoningLevel !== null ? { options: { reasoningLevel } } : {}) };
}
function valueString(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }
function eventPayloadName(value: unknown): string | null {
  if (!record(value)) return null;
  for (const key of ['toolName', 'tool_name', 'name']) {
    const candidate = valueString(value[key]);
    if (candidate && safeIdentifier(candidate)) return candidate;
  }
  if (record(value.tool)) return eventPayloadName(value.tool);
  return null;
}
function providerIsApiKey(personal: unknown, providerId: string): boolean {
  if (!record(personal) || !record(personal.config) || !record(personal.config.providerConfigRules)
    || !Array.isArray(personal.config.providerConfigRules.providerRules)) return false;
  const matches = personal.config.providerConfigRules.providerRules.filter((entry: unknown) => record(entry) && entry.providerId === providerId);
  if (matches.length !== 1 || !record(matches[0].config) || !record(matches[0].config.access)) return false;
  return matches[0].config.access.type === 'api-key';
}
function safeSessionError(message: string): Error { return new Error(`ZCode session blocked: ${message}`); }

export class ZcodeSessionTransport implements ZcodeTransport {
  readonly requiresModelEvidence = true;
  private readonly settings: ZcodeSessionTransportOptions;

  constructor(settings: ZcodeSessionTransportOptions) { this.settings = { ...settings }; }

  supports(binding?: ModelBinding): Capability {
    if (!binding || !safeIdentifier(binding.providerId) || !safeIdentifier(binding.modelId)
      || !safeIdentifier(binding.catalogId) || binding.catalogId !== `${binding.providerId}/${binding.modelId}`
      || !Number.isSafeInteger(binding.selectionRevision) || binding.selectionRevision < 1
      || !/^[a-f0-9]{64}$/.test(binding.catalogRevision) || !/^[a-f0-9]{64}$/.test(binding.selectionFingerprint)
      || (binding.reasoningLevel !== null && !safeReasoning(binding.reasoningLevel))) {
      return { ready: false, reason: 'ZCode 会话绑定无效或缺少选择指纹' };
    }
    if (process.platform !== 'win32') return { ready: false, reason: '原生 ZCode 会话适配器当前仅支持 Windows' };
    if (![this.settings.electronPath, this.settings.cliPath, this.settings.personalConfigPath, this.settings.builtinConfigPath].every(validPath)) {
      return { ready: false, reason: 'ZCode 会话入口或配置路径无效' };
    }
    for (const file of [this.settings.electronPath, this.settings.cliPath, this.settings.personalConfigPath, this.settings.builtinConfigPath]) {
      try { if (!fs.statSync(file).isFile()) return { ready: false, reason: 'ZCode 会话入口或模型配置缺失' }; }
      catch { return { ready: false, reason: 'ZCode 会话入口或模型配置不可用' }; }
    }
    return { ready: true, reason: '原生 app-server 会话适配器可用；仍需当前配置保护和会话探针证据' };
  }

  async invoke(input: RunnerInput, options: ZcodeOptions, signal: AbortSignal, policy: ZcodeInvocationPolicy): Promise<ProcessResult> {
    const binding = options.modelBinding;
    const supported = this.supports(binding);
    if (!supported.ready || !binding) throw safeSessionError(supported.reason);
    if (signal.aborted) return { exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: true };
    if (Buffer.byteLength(policy.prompt, 'utf8') > MAX_PROMPT_BYTES) throw safeSessionError('提示词超出限制');

    const cliConfigPath = this.settings.cliConfigPath ?? path.join(os.homedir(), '.zcode', 'cli', 'config.json');
    const lockFiles = [this.settings.personalConfigPath, this.settings.builtinConfigPath, cliConfigPath].filter(file => fs.existsSync(file));
    let lock: ConfigReadLease | undefined;
    let rpc: ZcodeRpcClient | undefined;
    let sessionId: string | undefined;
    let created = false;
    let sendAccepted = false;
    let terminalResolve!: (value: Terminal) => void;
    let terminalReject!: (error: Error) => void;
    const terminal = new Promise<Terminal>((resolve, reject) => { terminalResolve = resolve; terminalReject = reject; });
    // The RPC event stream may fail before the main await reaches the race; keep the
    // rejection observed so a background notification cannot crash the management server.
    void terminal.catch(() => undefined);
    let finished = false;
    let observedTools: string[] = [];
    let activeTurnId: string | undefined;
    let cleanupFailure: Error | undefined;
    let turnTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (value: Terminal): void => { if (!finished) { finished = true; terminalResolve(value); } };
    const fail = (error: unknown): void => { if (!finished) { finished = true; terminalReject(error instanceof Error ? error : new Error(String(error))); } };
    const callback = async (method: string, params: unknown): Promise<unknown> => {
      const request = record(params) ? params as CallbackRequest : {};
      if (request.sessionId !== undefined && request.sessionId !== sessionId) throw new RpcFault(-32001, 'Foreign session denied');
      if (method === 'session/requestRuntimePreferences') {
        return { nativeSearchEnhancementsEnabled: false, toolSearchMode: 'off', subagentRuntimeConfigEnabled: false,
          appControlEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false,
          modelContextBudgetStrategy: 'preflight-v1' };
      }
      if (method === 'interaction/requestPermission') {
        const tool = valueString(request.toolName);
        const allowed = tool !== null && (SAFE_READ_TOOLS.has(tool) || policy.mode === 'edit' && SAFE_EDIT_TOOLS.has(tool))
          && !policy.disallowedTools.includes(tool);
        return { decision: allowed ? 'allow' : 'deny', reason: allowed ? '岗位允许的文件工具' : '智研司会话策略拒绝该工具或权限' };
      }
      if (method === 'interaction/requestUserInput') return { action: 'decline', reason: '员工会话不代替用户回答交互问题' };
      if (method === 'interaction/requestProviderRuntimeHeaders') return { headersApplied: false, errorMessage: '账户认证桥未接入；个人 API-key 不伪造认证回调' };
      if (method === 'interaction/requestOfficialMcpAuthHeaders' && typeof request.requestId === 'string') {
        return { requestId: request.requestId, result: { ok: false, error: { code: 'OFFICIAL_MCP_AUTH_UNAVAILABLE', message: '官方 MCP 认证桥未接入' } } };
      }
      if (method === 'interaction/requestCredentialCipher' && typeof request.requestId === 'string') {
        return { requestId: request.requestId, result: { ok: false, error: { code: 'CREDENTIAL_SECURE_STORAGE_UNAVAILABLE', message: '凭据安全存储桥未接入' } } };
      }
      throw new RpcFault(-32601, 'Host capability is not available');
    };

    try {
      lock = await acquireConfigReadLock(lockFiles, signal);
      lock.assertHeld();
      const catalogSnapshot = readModelConfigSnapshot({ configPath: this.settings.personalConfigPath, builtinConfigPath: this.settings.builtinConfigPath });
      if (catalogSnapshot.catalog.catalogRevision !== binding.catalogRevision) throw safeSessionError('模型目录已变化，请重新确认');
      const model = catalogSnapshot.catalog.models.find(item => item.id === binding.catalogId && item.providerId === binding.providerId && item.modelId === binding.modelId);
      if (!model?.enabled || !model.availabilityConfigured || !providerIsApiKey(catalogSnapshot.personal, binding.providerId)) throw safeSessionError('仅支持已核验的个人 API-key 模型');
      const spec = resolveModelSpec(catalogSnapshot.builtin, catalogSnapshot.personal, binding.providerId, binding.modelId);
      const reasoningLevel = options.effectiveReasoningLevel ?? binding.reasoningLevel ?? spec.defaultLevel;
      if (spec.support === 'unknown' || (reasoningLevel !== null && (!safeReasoning(reasoningLevel) || !spec.levels.includes(reasoningLevel)))) throw safeSessionError('思考强度规格未知或已失效');
      const chosen = selection(binding, reasoningLevel);
      const session = `sess_${randomUUID()}`;
      sessionId = session;
      const environment = { ...buildZcodeEnvironment(), ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: this.settings.builtinConfigPath, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: this.settings.personalConfigPath };
      rpc = new ZcodeRpcClient({
        command: this.settings.electronPath, args: [this.settings.cliPath, 'app-server', '--stdio'], cwd: policy.cwd, env: environment,
        timeoutMs: options.timeoutMs, maxOutputBytes: policy.maxOutputBytes, signal,
        onRequest: callback,
        onEvent: (method, params) => {
          // app-server emits lifecycle/projection notifications during startup. They are not
          // turn evidence; ignore them rather than treating a benign notification as a fatal
          // host error. Only session/event is consumed below.
          if (method !== 'session/event') return;
          if (!record(params)) {
            const error = new Error('Invalid ZCode session event');
            fail(error); rpc?.fail(error); return;
          }
          if (params.sessionId !== sessionId) {
            const error = new Error('Foreign ZCode event');
            fail(error); rpc?.fail(error); return;
          }
          const type = valueString(params.type);
          const payload = params.payload;
          if (params.turnId !== undefined && typeof params.turnId !== 'string') throw new Error('Invalid ZCode turn');
          if (params.turnId && !activeTurnId) activeTurnId = params.turnId;
          if (type && /^(?:tool[._-](?:use|call|started|completed|result)|tool_use)$/.test(type)) {
            const name = eventPayloadName(payload);
            if (name && observedTools.length < MAX_TOOLS && !observedTools.includes(name)) observedTools.push(name);
          }
          if (type === 'turn.completed') {
            if (!record(payload) || payload.resultType !== 'success' || typeof payload.response !== 'string' || !payload.response.trim()) {
              fail(new Error('ZCode turn did not complete successfully')); return;
            }
            finish({ kind: 'completed', response: payload.response, ...(activeTurnId ? { turnId: activeTurnId } : {}), ...(typeof payload.inputId === 'string' ? { inputId: payload.inputId } : {}) });
          } else if (type === 'turn.failed') fail(new Error('ZCode turn failed'));
        },
      });
      void rpc.failure.then(error => { if (!finished) fail(error); });
      void lock.lost.then(() => { rpc?.fail(new Error('ZCode configuration read protection was lost')); fail(new Error('ZCode configuration read protection was lost')); });
      await rpc.request('runtime/capabilities', {});
      await rpc.request('session/create', {
        sessionId: session, workspace: { workspaceKey: `zhiyansi-${session}`, workspacePath: policy.cwd }, model: chosen,
        ...(reasoningLevel !== null ? { thoughtLevel: reasoningLevel } : {}), mode: policy.mode === 'edit' ? 'edit' : 'plan',
        titleGenerationEnabled: false, persistence: 'deferred', offPeakToolEnabled: false, dynamicWorkflowEnabled: false,
        toolDenylist: policy.disallowedTools,
      });
      created = true;
      await rpc.request('session/setModel', { sessionId: session, model: chosen });
      await rpc.request('session/setMode', { sessionId: session, mode: policy.mode === 'edit' ? 'edit' : 'plan' });
      const sessionSnapshot = await rpc.request<UnknownRecord>('session/read', { sessionId: session, messageLimit: 1 });
      const settings = record(sessionSnapshot.settings) ? sessionSnapshot.settings : null;
      const modelSettings = settings && record(settings.model) ? settings.model : null;
      const currentModel = modelSettings && record(modelSettings.current) ? modelSettings.current : null;
      const thoughtSettings = settings && record(settings.thoughtLevel) ? settings.thoughtLevel : null;
      const currentReasoning = thoughtSettings?.current;
      const currentOptions = currentModel && record(currentModel.options) ? currentModel.options : null;
      if (!record(sessionSnapshot.protocol) || sessionSnapshot.protocol.name !== SESSION_PROTOCOL || sessionSnapshot.protocol.version !== 1
        || !record(sessionSnapshot.session) || sessionSnapshot.session.sessionId !== session
        || !currentModel || currentModel.providerId !== binding.providerId || currentModel.modelId !== binding.modelId
        || reasoningLevel !== null && (currentOptions?.reasoningLevel !== reasoningLevel || currentReasoning !== reasoningLevel)) {
        throw safeSessionError('会话未确认所选模型或思考强度');
      }
      const subscription = await rpc.request<UnknownRecord>('session/subscribe', { sessionId: session, deliveryKind: 'desktop-continuous', includeSnapshot: false });
      if (subscription.sessionId !== session || !Number.isSafeInteger(subscription.eventSeq) || !Array.isArray(subscription.events)) throw safeSessionError('会话订阅协议不兼容');
      await rpc.request<UnknownRecord>('session/send', { sessionId: session, content: policy.prompt, modelSelection: chosen, toolDenylist: policy.disallowedTools });
      sendAccepted = true;
      const timeout = new Promise<Terminal>((_, reject) => { turnTimer = setTimeout(() => reject(new Error('ZCode turn timed out')), options.timeoutMs); });
      const outcome = await Promise.race([terminal, timeout]);
      if (outcome.kind !== 'completed') throw new Error('ZCode turn did not complete successfully');
      lock.assertHeld();
      const lines = [
        JSON.stringify({ type: 'system.session', sessionId: session, model: modelName(binding), modelId: binding.modelId, reasoningLevel }),
        ...observedTools.map(toolName => JSON.stringify({ type: 'tool.use', sessionId: session, toolName, name: toolName })),
        JSON.stringify({ type: 'turn.started', sessionId: session, turnId: activeTurnId ?? 'owned-turn', model: modelName(binding), modelId: binding.modelId, reasoningLevel }),
        JSON.stringify({ type: 'result', sessionId: session, response: outcome.response }),
      ];
      return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '', timedOut: false, cancelled: false,
        modelEvidence: { providerId: binding.providerId, modelId: binding.modelId, reasoningLevel, acknowledged: true } };
    } catch (error) {
      if (signal.aborted) return { exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: true };
      throw safeSessionError(safeMessage(error));
    } finally {
      if (turnTimer) clearTimeout(turnTimer);
      if (rpc && sessionId) {
        try {
          if (created) {
            if (signal.aborted && sendAccepted) { try { await rpc.request('session/stop', { sessionId }, 3000); } catch { /* bounded cleanup */ } }
            try {
              // setModel persists a runtime-model-selection entry, so the native runtime may
              // promote deferred persistence to immediate. This session is freshly owned by
              // this adapter; close it without a stale persistence precondition, but still
              // require the native `{closed:true}` acknowledgement.
              const closed = await rpc.request<{ closed?: boolean }>('session/close', { sessionId }, 5000);
              if (closed.closed !== true) cleanupFailure = new Error('session close was not confirmed');
            } catch { cleanupFailure = new Error('session close was not confirmed'); }
          }
        } finally { await rpc.dispose(); }
      }
      try { lock?.assertHeld(); } catch { cleanupFailure ??= new Error('ZCode configuration read protection was lost'); }
      if (lock) await lock.release();
      if (cleanupFailure && !signal.aborted) throw safeSessionError(cleanupFailure.message);
    }
  }
}
