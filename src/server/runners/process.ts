import { spawn } from 'node:child_process';

export interface ProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Combined stdout + stderr limit. The child is still drained after the limit. */
  maxOutputBytes?: number;
}
export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  modelEvidence?: {
    providerId: string;
    modelId: string;
    reasoningLevel: string | null;
    acknowledged: boolean;
  };
}

export async function runProcess(command: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  const limit = options.maxOutputBytes ?? 256 * 1024;
  if (!command || command.includes('\0') || !Array.isArray(args)
    || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
    || !Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647
    || !Number.isInteger(limit) || limit < 0 || limit > 16 * 1024 * 1024) {
    throw new Error('Invalid process arguments, timeout or output limit');
  }
  if (options.signal?.aborted) {
    return { exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: true };
  }
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let cancelled = false;
    let stopping = false;
    let settled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let treeKiller: ReturnType<typeof spawn> | undefined;
    let treePending = false;
    let childClosed = false;
    let childExit: number | null = null;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const collect = (chunks: Buffer[], chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, limit - size);
      if (remaining) {
        const kept = bytes.subarray(0, remaining);
        chunks.push(kept);
        size += kept.length;
      }
    };
    child.stdout?.on('data', (data: Buffer) => collect(stdout, data));
    child.stderr?.on('data', (data: Buffer) => collect(stderr, data));
    // A partial UTF-8 character at the cap must not inflate the returned byte budget.
    const text = (chunks: Buffer[]): string => {
      const bytes = Buffer.concat(chunks);
      const value = bytes.toString('utf8');
      if (Buffer.byteLength(value) <= bytes.length) return value;
      // Bound even invalid UTF-8 without quadratic trimming of hostile binary output.
      const encoded = Buffer.from(value);
      let end = bytes.length;
      while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
      return encoded.subarray(0, end).toString('utf8');
    };
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      if (deadline) clearTimeout(deadline);
      options.signal?.removeEventListener('abort', abort);
      if (treeKiller && treeKiller.exitCode === null) treeKiller.kill();
    };
    const finish = (exitCode: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve({ exitCode, stdout: text(stdout), stderr: text(stderr), timedOut, cancelled });
    };
    const signalGroup = (signal: NodeJS.Signals): void => {
      if (!child.pid || child.pid <= 0) return;
      try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already exited */ } }
    };
    const stop = (): void => {
      if (stopping || settled) return;
      stopping = true;
      if (child.pid && child.pid > 0) {
        if (process.platform === 'win32') {
          // Only this spawned PID and its descendants. Never /IM, wildcards, or a shell.
          const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
          try {
            treeKiller = spawn(`${systemRoot}\\System32\\taskkill.exe`, ['/PID', String(child.pid), '/T', '/F'], {
              shell: false, windowsHide: true, stdio: 'ignore',
            });
            treePending = true;
            treeKiller.on('error', () => {
              treePending = false;
              try { child.kill('SIGKILL'); } catch { /* already exited */ }
              if (childClosed) finish(childExit);
            });
            treeKiller.on('close', (code) => {
              treePending = false;
              if (code !== 0 && !settled) { try { child.kill('SIGKILL'); } catch { /* already exited */ } }
              if (childClosed) finish(childExit);
            });
          } catch { try { child.kill('SIGKILL'); } catch { /* already exited */ } }
        } else {
          signalGroup('SIGTERM');
          escalation = setTimeout(() => signalGroup('SIGKILL'), 250);
        }
      }
      // Even a child whose pipes are held by a descendant must not hang the caller forever.
      deadline = setTimeout(() => {
        if (process.platform !== 'win32') signalGroup('SIGKILL');
        else { try { child.kill('SIGKILL'); } catch { /* already exited */ } }
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish(null);
      }, 3000);
    };
    function abort(): void { cancelled = true; stop(); }
    child.on('error', (error) => finish(null, error));
    child.on('close', (code) => {
      childClosed = true;
      childExit = code;
      // Do not kill taskkill as soon as the parent exits: it must finish terminating descendants.
      if (treePending) return;
      if (stopping && process.platform !== 'win32') signalGroup('SIGKILL');
      finish(code);
    });
    timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
