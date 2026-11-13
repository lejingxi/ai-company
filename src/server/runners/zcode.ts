import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import path from 'node:path';
import type { AgentOutput, Capability, ModelBinding, RunnerInput } from '../../shared/types.js';
import type { ProcessResult } from './process.js';
import { assertManagedTaskWorkspace, managerForTaskWorkspace } from './workspace.js';
import { validateLearningProposals } from '../../shared/skill-content.js';

export interface ZcodeOptions {
  electronPath: string;
  cliPath: string;
  enabled: boolean;
  timeoutMs: number;
  /** Legacy settings are accepted for migration only; neither authorizes or changes this mode. */
  isolationVerified?: boolean;
  runtimeHome?: string;
  environmentMode?: 'existing-user';
  verificationFingerprint?: string;
  modelBinding?: ModelBinding;
  effectiveReasoningLevel?: string | null;
  personalConfigPath?: string;
  builtinConfigPath?: string;
  cliConfigPath?: string;
}
/** Protocol-neutral restrictions, shared by a future model-aware transport and test doubles. */
export interface ZcodeInvocationPolicy {
  prompt: string;
  mode: 'edit' | 'plan';
  cwd: string;
  env: NodeJS.ProcessEnv;
  disallowedTools: readonly string[];
  maxOutputBytes: number;
}
/** Constructor dependency only: never selected by configuration, API payloads or environment flags. */
export interface ZcodeTransport {
  /** Native session transports opt in to strict provider/reasoning evidence checks. */
  readonly requiresModelEvidence?: boolean;
  supports(binding?: ModelBinding): Capability;
  invoke(input: RunnerInput, options: ZcodeOptions, signal: AbortSignal, policy: ZcodeInvocationPolicy): Promise<ProcessResult>;
}
const UNSUPPORTED_MODEL_BINDING = '当前模型绑定尚未通过原生 ZCode 会话验收；不会回退到默认模型';
const MAX_STREAM = 2 * 1024 * 1024;
const MAX_RESPONSE = 1536 * 1024;
const MAX_FILE = 128 * 1024;
const MAX_TOTAL = 1024 * 1024;
const DISALLOWED_TOOLS = [
  'Bash', 'Workflow', 'CreateWorkflow', 'AmendWorkflow', 'ResumeWorkflowRun', 'SaveWorkflow',
  'EvalWorkflowSnippet', 'FillWorkflowHole', 'ResolveWorkflowQuestion', 'RespondToCoordinator',
  'CreateSession', 'SendToSession', 'ForkSession', 'InterruptSession',
  'CronCreate', 'CronUpdate', 'CronDelete', 'OffPeakCreate',
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
];
// Exact injection controls only. Authentication, proxies, PATH, plugin/skill locations and home remain inherited.
const STRIPPED_ENV = new Set(['NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE', 'ELECTRON_RUN_AS_NODE']);
/** In-place current-user environment: never rewrite home, credential, plugin, proxy or PATH settings. */
export function buildZcodeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (STRIPPED_ENV.has(name.toUpperCase())) delete env[name];
  env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function bounded(value: string, bytes: number, name: string): void {
  if (Buffer.byteLength(value, 'utf8') > bytes) throw new Error(`${name} exceeds size limit`);
}
function modelBindingError(binding: unknown): string | undefined {
  if (binding === undefined || binding === null) return 'ZCode blocked: model selection is unset; select a configured model first';
  const identifier = (value: unknown): value is string => typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,255}$/.test(value);
  const fingerprint = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (!object(binding) || !identifier(binding.catalogId) || !identifier(binding.providerId) || !identifier(binding.modelId)
    || (binding.reasoningLevel !== null && !identifier(binding.reasoningLevel))
    || !Number.isSafeInteger(binding.selectionRevision) || (binding.selectionRevision as number) < 1
    || !fingerprint(binding.catalogRevision) || !fingerprint(binding.selectionFingerprint)) {
    return 'ZCode blocked: invalid model binding or selection fingerprint';
  }
  return undefined;
}
/** No boolean/legacy evidence can make the installed CLI bind a user-selected model. */
export function modelBindingSupport(binding?: ModelBinding): Capability {
  return { ready: false, reason: modelBindingError(binding) ?? UNSUPPORTED_MODEL_BINDING };
}
const defaultTransport: ZcodeTransport = Object.freeze({
  requiresModelEvidence: false,
  supports: modelBindingSupport,
  async invoke(_input: RunnerInput, options: ZcodeOptions): Promise<ProcessResult> {
    // Deliberately no -p fallback, invented model flags, desktop-host calls or global mutations.
    throw new Error(modelBindingSupport(options.modelBinding).reason);
  },
});
function session(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)) {
    throw new Error('Invalid ZCode sessionId');
  }
  return value;
}

/** NDJSON only: progress/assistant text is never a successful final result. */
export function parseStreamJson(text: string): { sessionId?: string; response: string; usage?: unknown } {
  if (typeof text !== 'string') throw new Error('ZCode stream must be text');
  bounded(text, MAX_STREAM, 'ZCode stream');
  let result: Record<string, unknown> | undefined;
  let sessionId: string | undefined;
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (++count > 10000) throw new Error('Too many ZCode events');
    let event: unknown;
    try { event = JSON.parse(line); } catch { throw new Error('Malformed ZCode NDJSON event'); }
    if (!object(event) || typeof event.type !== 'string') throw new Error('Invalid ZCode event');
    if (result) throw new Error('ZCode final result must be the last event');
    if (/(?:^|[._-])(?:error|failed|cancelled|canceled)$/.test(event.type)
      || event.isError === true || event.is_error === true || event.error != null
      || event.success === false || event.status === 'error' || event.status === 'failed'
      || (typeof event.subtype === 'string' && /error|fail|cancel/i.test(event.subtype))) {
      throw new Error('ZCode reported an error event');
    }
    const eventSession = session(event.sessionId ?? event.session_id);
    if (eventSession) {
      if (sessionId && eventSession !== sessionId) throw new Error('Inconsistent ZCode sessionId');
      sessionId = eventSession;
    }
    if (event.type === 'result') result = event;
  }
  if (!result) throw new Error('ZCode stream has no final result event');
  // The current CLI emits camelCase response; legacy result is accepted only in a final result event.
  const value = result.response !== undefined ? result.response : result.result;
  if (typeof value !== 'string' && !object(value)) throw new Error('ZCode final result has no structured response');
  const response = typeof value === 'string' ? value : JSON.stringify(value);
  if (!response.trim()) throw new Error('ZCode final response is empty');
  bounded(response, MAX_RESPONSE, 'ZCode response');
  return { ...(sessionId ? { sessionId } : {}), response, ...(result.usage !== undefined ? { usage: result.usage } : {}) };
}

export function parseAgentOutput(response: string): AgentOutput {
  if (typeof response !== 'string') throw new Error('Agent response must be JSON text');
  bounded(response, MAX_RESPONSE, 'Agent response');
  let source = response.trim();
  if (source.startsWith('```')) {
    const fenced = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(source);
    if (!fenced) throw new Error('Invalid JSON code fence');
    source = fenced[1];
  }
  let output: unknown;
  try { output = JSON.parse(source); } catch { throw new Error('Agent response is not valid JSON'); }
  const allowed = new Set(['summary', 'files', 'verdict', 'acceptanceCriteria', 'learningProposals']);
  if (!object(output) || Object.keys(output).some((key) => !allowed.has(key))
    || typeof output.summary !== 'string' || !output.summary.trim()
    || !Array.isArray(output.files) || output.files.length > 50) throw new Error('Invalid AgentOutput schema');
  bounded(output.summary, 16 * 1024, 'Agent summary');
  if (output.verdict !== undefined && output.verdict !== 'passed' && output.verdict !== 'failed') {
    throw new Error('Invalid agent verdict');
  }
  if (output.acceptanceCriteria !== undefined && (!Array.isArray(output.acceptanceCriteria)
    || output.acceptanceCriteria.length > 50 || output.acceptanceCriteria.some((criterion) =>
      typeof criterion !== 'string' || !criterion.trim() || Buffer.byteLength(criterion) > 2048))) {
    throw new Error('Invalid acceptanceCriteria');
  }
  let total = 0;
  const seen = new Set<string>();
  const files = output.files.map((file: unknown) => {
    if (!object(file) || Object.keys(file).some((key) => key !== 'path' && key !== 'content')
      || typeof file.path !== 'string' || typeof file.content !== 'string'
      || !file.path || file.path.length > 240 || /[\\:\x00-\x1f\x7f<>"|?*]/.test(file.path)
      || path.posix.isAbsolute(file.path) || path.win32.isAbsolute(file.path)) throw new Error('Invalid agent file change');
    const segments = file.path.split('/');
    if (segments.length > 12 || segments.some((part) => !part || part.startsWith('.') || /[. ]$/.test(part)
      || part.toLowerCase() === 'node_modules' || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new Error('Unsafe agent file path');
    }
    if (seen.has(file.path.toLowerCase())) throw new Error('Duplicate agent file path');
    seen.add(file.path.toLowerCase());
    bounded(file.content, MAX_FILE, 'Agent file');
    total += Buffer.byteLength(file.content);
    if (total > MAX_TOTAL) throw new Error('Agent files exceed 1MB');
    return { path: file.path, content: file.content };
  });
  return {
    summary: output.summary, files,
    ...(output.verdict !== undefined ? { verdict: output.verdict as 'passed' | 'failed' } : {}),
    ...(output.acceptanceCriteria !== undefined ? { acceptanceCriteria: output.acceptanceCriteria as string[] } : {}),
    ...(output.learningProposals !== undefined ? { learningProposals: validateLearningProposals(output.learningProposals) } : {}),
  };
}

// This is a conservative path check, not an OS sandbox or proof that all Windows reparse tags are absent.
function safeLocalPath(value: string, directory?: boolean, missing = false): void {
  if (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || /^[/\\]{2}/.test(value)
    || value.split(/[/\\]/).includes('..')) throw new Error('ZCode requires an absolute local path');
  const resolved = path.resolve(value);
  const root = path.parse(resolved).root;
  let current = root;
  const parts = path.relative(root, resolved).split(path.sep).filter(Boolean);
  for (let i = 0; i <= parts.length; i++) {
    if (i) current = path.join(current, parts[i - 1]);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const real = path.resolve(realpathSync.native(current));
    const equal = process.platform === 'win32' ? real.toLowerCase() === current.toLowerCase() : real === current;
    if (stat.isSymbolicLink() || !equal || (!stat.isFile() && !stat.isDirectory())
      || (stat.isFile() && stat.nlink !== 1)) throw new Error('ZCode symlink/reparse paths are forbidden');
    if (i < parts.length && !stat.isDirectory()) throw new Error('Invalid ZCode parent directory');
    if (i === parts.length && directory !== undefined && (directory ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error('Wrong ZCode path type');
    }
  }
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function normalizedPath(value: string): string {
  const absolute = path.resolve(value);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}
function currentUserHome(): string {
  const home = process.platform === 'win32'
    ? process.env.USERPROFILE || process.env.HOME : process.env.HOME || process.env.USERPROFILE;
  if (!home) throw new Error('Current user home is unavailable');
  try { safeLocalPath(home, true); } catch { throw new Error('Current user home is unavailable or unsafe'); }
  return home;
}
const binaryHashes = new Map<string, { metadata: string; sha256: string }>();
function fileMetadata(stat: Stats): string {
  return JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs, stat.dev, stat.ino]);
}
function binaryFingerprint(file: string): { pathHash: string; metadata: string; sha256: string } {
  try {
    safeLocalPath(file, false);
    const before = lstatSync(file);
    const metadata = fileMetadata(before);
    const key = normalizedPath(file);
    const cached = binaryHashes.get(key);
    if (cached?.metadata === metadata) return { pathHash: hash(key), metadata, sha256: cached.sha256 };
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let sha256: string;
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || fileMetadata(opened) !== metadata) throw new Error('changed file');
      const digest = createHash('sha256');
      const chunk = Buffer.alloc(128 * 1024);
      let position = 0;
      while (position < before.size) {
        const length = readSync(fd, chunk, 0, Math.min(chunk.length, before.size - position), position);
        if (!length) throw new Error('changed file');
        digest.update(chunk.subarray(0, length));
        position += length;
      }
      if (fileMetadata(fstatSync(fd)) !== metadata) throw new Error('changed file');
      sha256 = digest.digest('hex');
    } finally { closeSync(fd); }
    safeLocalPath(file, false);
    if (fileMetadata(lstatSync(file)) !== metadata) throw new Error('changed file');
    if (binaryHashes.size >= 16) binaryHashes.clear();
    binaryHashes.set(key, { metadata, sha256 });
    return { pathHash: hash(key), metadata, sha256 };
  } catch { throw new Error('ZCode CLI/Electron file is missing, unsafe, unreadable, or changed during verification'); }
}
function configMetadata(home: string): { pathHash: string; metadata: string | null } {
  // Exact known filename only. Do not enumerate plugin/skill/provider stores or read any configuration bytes.
  const file = path.join(home, '.zcode', 'cli', 'config.json');
  try {
    safeLocalPath(file, false, true);
    let stat: Stats;
    try { stat = lstatSync(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { pathHash: hash(normalizedPath(file)), metadata: null };
      throw error;
    }
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('unsafe config');
    return { pathHash: hash(normalizedPath(file)), metadata: fileMetadata(stat) };
  } catch { throw new Error('ZCode configuration metadata is unavailable or unsafe'); }
}
/** Filesystem-only evidence binding, not authentication verification or an OS/file-access sandbox. */
export function fingerprintCurrentZcode(options: ZcodeOptions): string {
  const home = currentUserHome();
  const environment = ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
    'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'].map((name) =>
    [name, process.env[name] === undefined ? null : hash(process.env[name]!)]);
  return hash(JSON.stringify({
    version: 'existing-user-model-binding-v2', platform: process.platform, home: hash(normalizedPath(home)), environment,
    electron: binaryFingerprint(options.electronPath), cli: binaryFingerprint(options.cliPath), config: configMetadata(home),
    modelBinding: options.modelBinding ? {
      catalogId: options.modelBinding.catalogId, providerId: options.modelBinding.providerId, modelId: options.modelBinding.modelId,
      reasoningLevel: options.modelBinding.reasoningLevel, selectionRevision: options.modelBinding.selectionRevision,
      catalogRevision: options.modelBinding.catalogRevision, selectionFingerprint: options.modelBinding.selectionFingerprint,
    } : null,
  }));
}

/** Remove common credential forms without reading environment variables or returning raw CLI dumps. */
export function redactRunDiagnostic(text: string): string {
  const source = typeof text === 'string' ? text.slice(0, MAX_STREAM) : '';
  const redacted = source
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/(\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]*/gi, '$1[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=:.~-]+/gi, '[REDACTED AUTH]')
    .replace(/(\b(?:[A-Za-z0-9_]*[_-])?(?:authorization|proxy-authorization|x-api-key|api[-_]?key|api[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|token|password|passwd|pwd|client[-_]?secret|secret|cookie|set-cookie)\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;\r\n}]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED TOKEN]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return redacted.length > 2048 ? `${redacted.slice(0, 2020)} [truncated]` : redacted;
}
function telemetryEvents(text: string): Record<string, unknown>[] {
  if (typeof text !== 'string') throw new Error('ZCode stream must be text');
  bounded(text, MAX_STREAM, 'ZCode stream');
  const events: Record<string, unknown>[] = [];
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (++count > 10000) throw new Error('Too many ZCode events');
    try {
      const value: unknown = JSON.parse(line);
      if (object(value)) events.push(value);
    } catch { /* Telemetry is best effort, never a substitute for strict result parsing. */ }
  }
  return events;
}
function observationName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/.test(value)
    && !/^(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|eyJ)/.test(value);
}
/** Only observed identifiers; never retain tool input, arguments, result bodies, or free-form output. */
export function extractObservedTools(text: string): string[] {
  const names = new Set<string>();
  for (const event of telemetryEvents(text)) {
    const visit = (value: Record<string, unknown>, depth: number): void => {
      if (depth > 4) return;
      for (const name of [value.toolName, value.tool_name, object(value.tool) ? value.tool.name : undefined]) {
        if (observationName(name) && names.size < 100) names.add(name);
      }
      if (typeof value.type === 'string' && /^(?:tool[._-](?:use|call|started|completed|result)|tool_use)$/.test(value.type)
        && observationName(value.name) && names.size < 100) names.add(value.name);
      for (const key of ['data', 'payload', 'message', 'content']) {
        const nested = value[key];
        if (object(nested)) visit(nested, depth + 1);
        else if (Array.isArray(nested)) for (const item of nested) if (object(item)) visit(item, depth + 1);
      }
    };
    // A model's final response can contain lookalike fields; it is not telemetry.
    if (event.type !== 'result') visit(event, 0);
  }
  return [...names].sort();
}
function observedModels(text: string): string[] {
  const models: string[] = [];
  for (const event of telemetryEvents(text)) {
    if (typeof event.type !== 'string' || !/^(?:system(?:[._-].*)?|metadata(?:[._-].*)?|session\.updated|turn\.started)$/.test(event.type)) continue;
    for (const value of [event, event.data, event.payload]) {
      if (!object(value)) continue;
      for (const name of [value.model, value.modelId]) if (observationName(name)) models.push(name);
    }
  }
  return models;
}
export function extractObservedModel(text: string): string | null {
  return observedModels(text).at(-1) ?? null;
}
function providerFailure(text: string): string | undefined {
  if (/\b1113\b|insufficient[_ -](?:balance|quota)|余额不足/i.test(text)) {
    return 'ZCode provider balance/quota is insufficient (1113); no successful result was produced';
  }
  if (/\b(?:401|403)\b|unauthori[sz]ed|authentication[_ -](?:error|failed|required)|invalid[_ -](?:api[_ -]?key|token)|(?:api[_ -]?key|token)[_ -](?:expired|invalid)|not[_ -](?:logged|signed)[_ -]in/i.test(text)) {
    return 'ZCode authentication failed; verify the current user account and connection';
  }
  return undefined;
}

/** No CLI execution. Production readiness uses only the default-denied model transport. */
export async function checkZcode(options: ZcodeOptions): Promise<Capability> {
  return checkZcodeWithTransport(options, defaultTransport);
}
async function checkZcodeWithTransport(options: ZcodeOptions, transport: ZcodeTransport): Promise<Capability> {
  if (!options.enabled) return { ready: false, reason: 'ZCode execution is disabled' };
  if (options.environmentMode !== 'existing-user') return { ready: false, reason: 'ZCode blocked: existing-user environment mode is not approved' };
  const bindingError = modelBindingError(options.modelBinding);
  if (bindingError) return { ready: false, reason: bindingError };
  try {
    const support = transport.supports(options.modelBinding!);
    if (support.ready !== true) return { ready: false, reason: support.reason };
    if (typeof options.verificationFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(options.verificationFingerprint)) {
      return { ready: false, reason: 'ZCode blocked: current-user connection has not been verified' };
    }
    if (fingerprintCurrentZcode(options) !== options.verificationFingerprint) {
      return { ready: false, reason: 'ZCode blocked: connection verification is stale; verify the current environment and model selection again' };
    }
    return { ready: true, reason: 'Current-user connection evidence matches; host-controlled process, not an OS sandbox or outside-file-access guarantee' };
  } catch (error) { return { ready: false, reason: `ZCode blocked: ${redactRunDiagnostic((error as Error).message)}` }; }
}

function taskPrompt(input: RunnerInput): string {
  const scope = input.stage === 'development' ? 'Only change permitted src files or README.md; never tests, manifests, locks, or settings.'
    : input.stage === 'qa' ? 'Only change top-level tests/*.test.mjs; do not change source, README, manifests, locks, or settings.'
      : 'This stage is read-only: do not create, edit, or delete candidate files.';
  return [
    'Runner contract: existing-user, host-controlled execution. This is NOT an OS sandbox and does not guarantee prevention of outside file access.',
    'Work only on the assigned task in the supplied task workspace. Use existing account, plugins and skills in place; never copy credentials or change user/project settings, permissions, plugins, or skills.',
    'Do not access unrelated files or invoke commands/tools outside the task scope. Do not run shell commands or tests; testing is delegated to the host Docker runner.',
    'Do not create workflows, sessions, scheduled jobs, publish, deploy, or message other sessions. Read/search and applicable Skills/Agent remain available; these rules are not a universal MCP access restriction.',
    scope,
    'Do not delete files or create hidden .zcode/.agents settings. All direct candidate changes are checked after execution and rejected changes are preserved for diagnosis, not silently restored.',
    'Return only the required AgentOutput JSON. Files may propose the same allowed changes already made. Do not invent execution metadata or claim tests ran.',
    '', input.prompt,
  ].join('\n');
}
const activeWorkspaces = new Set<string>();
const activeSessions = new Set<string>();
export class ZcodeRunner {
  private readonly options: ZcodeOptions;
  constructor(options: ZcodeOptions, private readonly transport: ZcodeTransport = defaultTransport) {
    this.options = Object.freeze({
      ...options, ...(options.modelBinding ? { modelBinding: Object.freeze({ ...options.modelBinding }) } : {}),
    });
  }
  async run(input: RunnerInput): Promise<AgentOutput> {
    const capability = await checkZcodeWithTransport(this.options, this.transport);
    if (!capability.ready) throw new Error(capability.reason);
    if (input.signal.aborted) throw new Error('ZCode cancelled');
    if (!['planning', 'development', 'qa', 'ops'].includes(input.stage)) throw new Error('Invalid ZCode stage');
    bounded(input.prompt, 128 * 1024, 'ZCode prompt');
    const workspace = assertManagedTaskWorkspace(input.workspace);
    const manager = managerForTaskWorkspace(workspace);
    const before = manager.snapshot(workspace);
    const resume = session(input.sessionId);
    const key = normalizedPath(workspace);
    if (activeWorkspaces.has(key) || (resume && activeSessions.has(resume))) throw new Error('ZCode task/session already has an active run');
    activeWorkspaces.add(key);
    if (resume) activeSessions.add(resume);
    try {
      const policy: ZcodeInvocationPolicy = Object.freeze({
        prompt: taskPrompt(input), cwd: workspace, env: buildZcodeEnvironment(),
        mode: input.stage === 'development' || input.stage === 'qa' ? 'edit' : 'plan',
        disallowedTools: Object.freeze([...DISALLOWED_TOOLS]), maxOutputBytes: MAX_STREAM,
      });
      // Defense in depth only: inherited plugins/MCP and current-user host access are NOT sandboxed by this list.
      // The production transport cannot reach invocation; only an explicit model-aware dependency may execute.
      let result: ProcessResult | undefined;
      let failure: string | undefined;
      try {
        result = await this.transport.invoke(input, this.options, input.signal, policy);
        if (result.cancelled) failure = 'ZCode cancelled';
        else if (result.timedOut) failure = 'ZCode timed out';
        else if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) >= MAX_STREAM) failure = 'ZCode output reached the size limit';
        else if (result.exitCode !== 0) failure = providerFailure(`${result.stderr}\n${result.stdout}`)
          ?? `ZCode exited unsuccessfully (${result.exitCode ?? 'signal'})`;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        failure = message.startsWith('ZCode session blocked:') ? message : 'ZCode process could not be started or completed';
      }
      // Even failed/cancelled/malformed CLI runs must check direct writes. Never erase evidence or call them success.
      try { manager.assertStageChanges(workspace, before, input.stage); }
      catch (error) {
        throw new Error(`${failure ? `${failure}; ` : ''}ZCode candidate rejected: ${redactRunDiagnostic((error as Error).message)}; files preserved for review`);
      }
      if (failure || !result) throw new Error(`${failure ?? 'ZCode process failed'}; candidate files preserved for review`);
      let output: AgentOutput;
      let parsed: ReturnType<typeof parseStreamJson>;
      try {
        parsed = parseStreamJson(result.stdout); // stderr is never parsed as success.
        output = parseAgentOutput(parsed.response);
      } catch (error) {
        const reason = providerFailure(`${result.stderr}\n${result.stdout}`) ?? redactRunDiagnostic((error as Error).message);
        throw new Error(`${reason}; candidate files preserved for review`);
      }
      const observed = observedModels(result.stdout);
      const binding = this.options.modelBinding!;
      if (observed.some((model) => model !== binding.modelId && model !== `${binding.providerId}/${binding.modelId}`)) {
        throw new Error('ZCode observed model does not match the selected model binding; candidate files preserved for review');
      }
      if (this.transport.requiresModelEvidence) {
        const evidence = result.modelEvidence;
        const expectedReasoning = this.options.effectiveReasoningLevel ?? binding.reasoningLevel;
        if (!evidence?.acknowledged || evidence.providerId !== binding.providerId || evidence.modelId !== binding.modelId
          || evidence.reasoningLevel !== expectedReasoning) {
          throw new Error('ZCode session did not provide trusted model/reasoning evidence; candidate files preserved for review');
        }
      }
      if (input.stage === 'planning' || input.stage === 'ops') {
        if (output.files.length) throw new Error('This ZCode stage cannot propose files; candidate files preserved for review');
      } else {
        try { manager.validateChanges(workspace, output.files, input.stage); }
        catch (error) { throw new Error(`ZCode proposed changes rejected: ${redactRunDiagnostic((error as Error).message)}; candidate files preserved for review`); }
      }
      return {
        ...output, ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
        executionMetadata: {
          environmentMode: 'existing-user', verificationFingerprint: this.options.verificationFingerprint!,
          observedTools: extractObservedTools(result.stdout), model: observed.at(-1) ?? null,
        },
      };
    } finally {
      activeWorkspaces.delete(key);
      if (resume) activeSessions.delete(resume);
    }
  }
}
