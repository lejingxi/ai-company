import { spawn, type ChildProcessByStdio, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { Readable, Writable } from 'node:stream';
import { TextDecoder } from 'node:util';

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_PENDING = 64;
const MAX_PEER_IDS = 4096;
const MAX_TIMER_MS = 2_147_483_647;
const FORCE_STOP_MS = 3000;
const has = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const validTimeout = (value: number): boolean => Number.isInteger(value) && value > 0 && value <= MAX_TIMER_MS;
const validId = (value: unknown): value is string | number => typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
const validMethod = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
const only = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
const diagnostic = (message: string): Error => new Error(`ZCode RPC: ${message}`);

type RpcId = string | number;
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  deadline: number;
};
type PeerPending = { timer: ReturnType<typeof setTimeout>; deadline: number };

export interface ZcodeRpcOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Total lifetime budget from construction; also the default per-request budget. */
  timeoutMs: number;
  /** Combined stdout and stderr bytes, never greater than 2 MiB. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
  onRequest: (method: string, params: unknown) => Promise<unknown> | unknown;
  onEvent: (method: string, params: unknown) => void;
}

/** Only use fixed, public messages here: this opt-in error is sent to the RPC peer. */
export class RpcFault extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    if (!Number.isFinite(code) || typeof message !== 'string' || !message
      || Buffer.byteLength(message) > 256 || /[\u0000-\u001f\u007f]/.test(message)) {
      throw diagnostic('invalid RPC fault');
    }
    super(message);
    this.name = 'RpcFault';
    this.code = code;
  }
}

/** Native app-server NDJSON only. No JSON-RPC framing, handshake, or session policy. */
export class ZcodeRpcClient {
  /** Resolves (never rejects) on failure. Normal disposal is not a failure. */
  readonly failure: Promise<Error>;
  private resolveFailure!: (error: Error) => void;
  private readonly options: ZcodeRpcOptions;
  private readonly deadline: number;
  private readonly outputLimit: number;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  private readonly pending = new Map<RpcId, Pending>();
  private readonly peerPending = new Map<RpcId, PeerPending>();
  private readonly peerIds = new Set<RpcId>();
  private child?: ChildProcessByStdio<Writable, Readable, Readable>;
  private timer?: ReturnType<typeof setTimeout>;
  private terminalError?: Error;
  private nextId = 0;
  private outputBytes = 0;
  private lineBytes = 0;
  private lineParts: string[] = [];
  private queuedBytes = 0;
  private queuedWrites = 0;
  private childClosed = false;
  private childExited = false;
  private stopPromise?: Promise<void>;
  private finishStop?: () => void;
  private stopping = false;

  constructor(options: ZcodeRpcOptions) {
    const outputLimit = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    if (typeof options.command !== 'string' || !options.command || options.command.includes('\0')
      || !Array.isArray(options.args) || options.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
      || typeof options.cwd !== 'string' || !options.cwd || options.cwd.includes('\0')
      || !validTimeout(options.timeoutMs) || !Number.isInteger(outputLimit) || outputLimit < 0 || outputLimit > MAX_OUTPUT_BYTES
      || typeof options.onRequest !== 'function' || typeof options.onEvent !== 'function') {
      throw diagnostic('invalid transport options');
    }
    this.options = { ...options, args: [...options.args] };
    this.outputLimit = outputLimit;
    this.deadline = performance.now() + options.timeoutMs;
    this.failure = new Promise((resolve) => { this.resolveFailure = resolve; });
    if (options.signal?.aborted) {
      this.fail(diagnostic('cancelled'));
      return;
    }
    this.timer = setTimeout(() => this.fail(diagnostic('total deadline exceeded')), options.timeoutMs);
    // Register before spawning, then recheck after wiring every pipe to cover the launch race.
    options.signal?.addEventListener('abort', this.abort, { once: true });
    try {
      this.child = spawn(options.command, this.options.args, {
        cwd: options.cwd, env: options.env ?? process.env,
        shell: false, windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      this.fail(diagnostic('child could not start'));
      return;
    }
    const child = this.child;
    child.on('error', () => this.fail(diagnostic('child process failed')));
    child.stdin.on('error', () => this.fail(diagnostic('input pipe failed')));
    child.stdin.on('close', () => { if (!this.stopping) this.fail(diagnostic('input pipe closed')); });
    child.stdout.on('error', () => this.fail(diagnostic('output pipe failed')));
    child.stderr.on('error', () => this.fail(diagnostic('error pipe failed')));
    child.stdout.on('data', (chunk: Buffer) => this.readOutput(chunk));
    // Never retain or interpolate stderr, even when it contains valid-looking RPC data.
    child.stderr.on('data', (chunk: Buffer) => { if (!this.terminalError) this.countOutput(chunk); });
    child.stdout.on('end', () => {
      if (this.terminalError) return;
      try { this.decoder.decode(); } catch { this.fail(diagnostic('invalid UTF-8 output')); return; }
      this.fail(diagnostic(this.lineBytes ? 'unterminated output line' : 'output pipe closed'));
    });
    child.on('exit', () => {
      this.childExited = true;
      if (!this.stopping) this.fail(diagnostic('child exited'));
    });
    child.on('close', () => {
      this.childClosed = true;
      this.childExited = true;
      if (!this.stopping) this.fail(diagnostic('child closed'));
      this.finishStop?.();
    });
    if (this.terminalError) void this.stop();
    else if (options.signal?.aborted) this.abort();
  }

  assertAlive(): void {
    if (!this.terminalError && this.options.signal?.aborted) this.abort();
    if (!this.terminalError && performance.now() >= this.deadline) this.fail(diagnostic('total deadline exceeded'));
    if (!this.terminalError && this.child
      && (this.childExited || this.child.exitCode != null || this.child.signalCode != null)) {
      this.fail(diagnostic('child exited'));
    }
    if (this.terminalError) throw this.terminalError;
  }

  async request<T = unknown>(method: string, params: unknown, timeoutMs = this.options.timeoutMs): Promise<T> {
    this.assertAlive();
    if (!validMethod(method) || !validTimeout(timeoutMs)) throw diagnostic('invalid request arguments');
    if (this.pending.size >= MAX_PENDING || this.nextId >= Number.MAX_SAFE_INTEGER) {
      this.fail(diagnostic('pending request limit exceeded'));
      this.assertAlive();
    }
    // String IDs remain distinct from numeric peer IDs. No ID is ever reused.
    const id = `client-${++this.nextId}`;
    const started = performance.now();
    const line = this.encode({ id, method, ...(params === undefined ? {} : { params }) });
    this.assertAlive();
    const deadline = Math.min(this.deadline, started + timeoutMs);
    if (performance.now() >= deadline) {
      this.fail(diagnostic('request timed out'));
      this.assertAlive();
    }
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(diagnostic('request timed out')), Math.max(1, deadline - performance.now()));
      this.pending.set(id, { resolve, reject, timer, deadline });
      this.write(line);
    });
    const result = await response;
    // A valid reply cannot win over an abort/protocol failure in the same read batch.
    this.assertAlive();
    if (performance.now() >= deadline) {
      this.fail(diagnostic('request timed out'));
      this.assertAlive();
    }
    return result as T;
  }

  /** The upper layer must pass a safe diagnostic, never a raw provider error or payload. */
  fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.resolveFailure(error);
    this.settlePending(error);
    void this.stop();
  }

  dispose(): Promise<void> {
    if (!this.terminalError) {
      this.terminalError = diagnostic('disposed');
      this.settlePending(this.terminalError);
    }
    return this.stop();
  }

  private readonly abort = (): void => { this.fail(diagnostic('cancelled')); };

  private alive(): boolean {
    try { this.assertAlive(); return true; } catch { return false; }
  }

  private settlePending(error: Error): void {
    if (this.timer) clearTimeout(this.timer);
    this.options.signal?.removeEventListener('abort', this.abort);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    for (const pending of this.peerPending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    this.peerPending.clear();
    this.peerIds.clear();
    this.lineParts = [];
    this.lineBytes = 0;
  }

  private countOutput(chunk: Buffer): boolean {
    if (!Buffer.isBuffer(chunk)) { this.fail(diagnostic('invalid output stream')); return false; }
    if (chunk.length > this.outputLimit - this.outputBytes) {
      this.fail(diagnostic('combined output limit exceeded'));
      return false;
    }
    this.outputBytes += chunk.length;
    return true;
  }

  private readOutput(chunk: Buffer): void {
    if (!this.alive() || !this.countOutput(chunk)) return;
    let start = 0;
    while (start < chunk.length && this.alive()) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      this.lineBytes += end - start;
      if (this.lineBytes > MAX_LINE_BYTES) { this.fail(diagnostic('output line limit exceeded')); return; }
      try {
        const text = this.decoder.decode(chunk.subarray(start, end), { stream: true });
        if (text) this.lineParts.push(text);
        if (newline >= 0) {
          this.lineParts.push(this.decoder.decode());
          let line = this.lineParts.join('');
          if (line.endsWith('\r')) line = line.slice(0, -1);
          this.lineParts = [];
          this.lineBytes = 0;
          this.receive(line);
        }
      } catch { this.fail(diagnostic('malformed RPC output')); return; }
      if (newline < 0) return;
      start = newline + 1;
    }
  }

  private receive(line: string): void {
    let message: unknown;
    try { message = JSON.parse(line); } catch { this.fail(diagnostic('malformed RPC output')); return; }
    if (!record(message)) { this.fail(diagnostic('invalid RPC envelope')); return; }
    if (has(message, 'method')) {
      if (!only(message, ['id', 'method', 'params', 'trace']) || !validMethod(message.method)
        || (has(message, 'id') && !validId(message.id))) {
        this.fail(diagnostic('invalid RPC envelope'));
        return;
      }
      if (has(message, 'id')) this.peerRequest(message.id as RpcId, message.method, message.params);
      else {
        try {
          // Also observe an accidentally async onEvent without allowing a rejected promise to leak.
          const result = this.options.onEvent(message.method, message.params);
          if (result !== undefined) void Promise.resolve(result).catch(() => this.fail(diagnostic('event handler failed')));
        } catch { this.fail(diagnostic('event handler failed')); }
      }
      return;
    }
    if (!only(message, ['id', 'result', 'error']) || !has(message, 'id') || !validId(message.id)
      || has(message, 'result') === has(message, 'error')) {
      this.fail(diagnostic('invalid RPC envelope'));
      return;
    }
    if (has(message, 'error') && (!record(message.error) || !only(message.error, ['code', 'message', 'data'])
      || typeof message.error.code !== 'number' || !Number.isFinite(message.error.code) || typeof message.error.message !== 'string')) {
      this.fail(diagnostic('invalid RPC error'));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) { this.fail(diagnostic('unknown or duplicate response')); return; }
    if (performance.now() >= pending.deadline) { this.fail(diagnostic('request timed out')); return; }
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (has(message, 'error')) {
      // Preserve only the machine-readable code, not untrusted message/data/stack text.
      pending.reject(new RpcFault((message.error as Record<string, unknown>).code as number, 'ZCode RPC request rejected'));
    } else pending.resolve(message.result);
  }

  private peerRequest(id: RpcId, method: string, params: unknown): void {
    if (this.peerIds.has(id)) { this.fail(diagnostic('duplicate peer request')); return; }
    if (this.peerPending.size >= MAX_PENDING || this.peerIds.size >= MAX_PEER_IDS) {
      this.fail(diagnostic('peer request limit exceeded'));
      return;
    }
    this.peerIds.add(id);
    const deadline = Math.min(this.deadline, performance.now() + this.options.timeoutMs);
    const timer = setTimeout(() => this.fail(diagnostic('peer request timed out')), Math.max(1, deadline - performance.now()));
    this.peerPending.set(id, { timer, deadline });
    void this.answerPeer(id, method, params);
  }

  private async answerPeer(id: RpcId, method: string, params: unknown): Promise<void> {
    let reply: { id: RpcId; result: unknown } | { id: RpcId; error: { code: number; message: string } };
    try {
      const result = await this.options.onRequest(method, params);
      reply = { id, result: result === undefined ? null : result };
    } catch (error) {
      let fault = { code: -32603, message: 'Request handler failed' };
      if (error instanceof RpcFault) {
        try { const safe = new RpcFault(error.code, error.message); fault = { code: safe.code, message: safe.message }; } catch { /* generic error */ }
      }
      reply = { id, error: fault };
    }
    if (!this.alive()) return;
    const pending = this.peerPending.get(id);
    if (!pending) return;
    if (performance.now() >= pending.deadline) { this.fail(diagnostic('peer request timed out')); return; }
    let line: string;
    try { line = this.encode(reply); } catch { this.fail(diagnostic('invalid request handler result')); return; }
    clearTimeout(pending.timer);
    this.peerPending.delete(id);
    this.write(line);
  }

  private encode(message: object): string {
    let line: string;
    try {
      line = JSON.stringify(message);
      const encoded: unknown = JSON.parse(line);
      // Undefined/functions/symbols must not silently remove a required result field.
      if (!record(encoded) || Object.keys(message).some((key) => !has(encoded, key))) throw new Error();
    } catch { throw diagnostic('request is not JSON serializable'); }
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw diagnostic('input line limit exceeded');
    return line + '\n';
  }

  private write(line: string): void {
    if (!this.alive()) return;
    const input = this.child?.stdin;
    const bytes = Buffer.byteLength(line);
    if (!input || input.destroyed || input.writableEnded) { this.fail(diagnostic('input pipe closed')); return; }
    // Include writes awaiting flush, not just request count: a peer can stop reading stdin.
    if (this.queuedWrites >= MAX_PENDING || bytes > MAX_OUTPUT_BYTES - this.queuedBytes) {
      this.fail(diagnostic('input queue limit exceeded'));
      return;
    }
    this.queuedWrites++;
    this.queuedBytes += bytes;
    let completed = false;
    const complete = (error?: Error | null): void => {
      if (completed) return;
      completed = true;
      this.queuedWrites--;
      this.queuedBytes -= bytes;
      if (error) this.fail(diagnostic('input pipe failed'));
    };
    try { input.write(line, 'utf8', complete); } catch { complete(diagnostic('input pipe failed')); }
  }

  private stop(): Promise<void> {
    const child = this.child;
    if (!child) return Promise.resolve(); // Cancellation during spawn is rechecked once it returns.
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    let resolveStop!: () => void;
    this.stopPromise = new Promise((resolve) => { resolveStop = resolve; });
    let finished = false;
    let killer: ChildProcess | undefined;
    let killerPending = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const killChild = (): void => {
      if (this.childExited) return;
      try { child.kill('SIGKILL'); } catch { /* owned process already exited */ }
    };
    const killGroup = (signal: NodeJS.Signals): void => {
      if (!child.pid || child.pid <= 0) return;
      try { process.kill(-child.pid, signal); } catch { if (!this.childExited) { try { child.kill(signal); } catch { /* exited */ } } }
    };
    const finish = (forced = false): void => {
      if (finished || (!forced && (!this.childClosed || killerPending))) return;
      finished = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (escalation) clearTimeout(escalation);
      // The POSIX group may outlive its leader even after all of the leader's pipes close.
      if (process.platform !== 'win32') killGroup('SIGKILL');
      if (killerPending && killer) {
        try { killer.kill('SIGKILL'); } catch { /* helper already exited */ }
        killer.unref();
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      this.finishStop = undefined;
      resolveStop();
    };
    this.finishStop = () => finish();
    forceTimer = setTimeout(() => {
      if (process.platform !== 'win32') killGroup('SIGKILL'); else killChild();
      finish(true);
    }, FORCE_STOP_MS);
    child.stdin.destroy();
    child.stdout.resume();
    child.stderr.resume();
    if (child.pid && child.pid > 0) {
      if (process.platform === 'win32') {
        // Never /IM, shell commands, or a PID discovered outside this owned spawn.
        const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
        try {
          killerPending = true;
          killer = spawn(`${systemRoot}\\System32\\taskkill.exe`, ['/PID', String(child.pid), '/T', '/F'], {
            shell: false, windowsHide: true, stdio: 'ignore',
          });
          killer.on('error', () => {
            if (finished) return;
            killerPending = false;
            killChild();
            finish();
          });
          killer.on('close', (code) => {
            if (finished) return;
            killerPending = false;
            if (code !== 0) killChild();
            finish();
          });
        } catch { killerPending = false; killChild(); }
      } else {
        killGroup('SIGTERM');
        escalation = setTimeout(() => killGroup('SIGKILL'), 250);
      }
    }
    finish();
    return this.stopPromise;
  }
}
