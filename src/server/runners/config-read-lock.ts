import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstatSync, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ConfigReadLockStage = 'validate' | 'launch' | 'acquire' | 'held' | 'release';
export type ConfigReadLockCode = 'unsupported-platform' | 'invalid-input' | 'unsafe-path' | 'file-unavailable'
  | 'holder-unavailable' | 'spawn-failed' | 'open-failed' | 'aborted' | 'timeout' | 'protocol-error'
  | 'output-limit' | 'holder-exited' | 'path-changed' | 'not-held' | 'cleanup-timeout';

/** Deliberately excludes paths, config bytes, abort reasons, child output and native error messages. */
export class ConfigReadLockError extends Error {
  cleanupFailed = false;
  constructor(readonly stage: ConfigReadLockStage, readonly code: ConfigReadLockCode, readonly fileIndex?: number) {
    super(`Config read lock ${stage}: ${code}${fileIndex === undefined ? '' : ` (file ${fileIndex})`}`);
    this.name = 'ConfigReadLockError';
  }
}
export interface ConfigReadLockReady {
  readonly protocol: 1;
  readonly status: 'ready';
  readonly fileCount: number;
}
export interface ConfigReadLease {
  readonly ready: Readonly<ConfigReadLockReady>;
  /** Idempotent. Invalidates the lease immediately; resolves only after the holder has closed. */
  release(): Promise<void>;
  /** Throws a safe, stage-tagged error unless the holder and the exact validated paths are still live. */
  assertHeld(): void;
  isAlive(): boolean;
  /** Resolves (never rejects) on unexpected loss, including cancellation. Stays pending on intentional release. */
  readonly lost: Promise<void>;
}

export const CONFIG_READ_LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
const RELEASE_GRACE_MS = 500;
const CLEANUP_TIMEOUT_MS = 3_000;
const MAX_FILES = 32;
const MAX_PATH_CHARS = 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 4096;
// This deployment supports the conventional Windows installation only. Never search PATH or trust a
// caller-supplied SystemRoot/ComSpec/PowerShell path; other installations must fail closed.
const SYSTEM_ROOT = 'C:\\Windows';
const SYSTEM_DIRECTORY = `${SYSTEM_ROOT}\\System32`;
const POWERSHELL_HOME = `${SYSTEM_DIRECTORY}\\WindowsPowerShell\\v1.0`;
const POWERSHELL = `${POWERSHELL_HOME}\\powershell.exe`;
const HOLDER = fileURLToPath(new URL('../../../scripts/hold-config-read-lock.ps1', import.meta.url));
const RESERVED_COMPONENT = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

type Identity = { name: string; dev: bigint; ino: bigint; directory: boolean };
function normalizeFile(value: unknown, index: number): string {
  const bad = () => new ConfigReadLockError('validate', 'unsafe-path', index);
  if (typeof value !== 'string' || value.length > MAX_PATH_CHARS || !/^[a-z]:[\\/]/i.test(value)
    || /[\x00-\x1f<>"|?*]/.test(value) || value.slice(2).includes(':')) throw bad();
  const normalized = value.replaceAll('/', '\\');
  const components = normalized.slice(3).split('\\');
  if (!components.length || components.some((part) => !part || part === '.' || part === '..'
    || /[. ]$/.test(part) || RESERVED_COMPONENT.test(part))) throw bad();
  return normalized;
}
function inspectPath(name: string, index?: number): Identity[] {
  const result: Identity[] = [];
  const root = path.win32.parse(name).root;
  const components = name.slice(root.length).split('\\');
  let current = root;
  for (let position = -1; position < components.length; position++) {
    if (position >= 0) current = path.win32.join(current, components[position]);
    let stat: BigIntStats;
    try { stat = lstatSync(current, { bigint: true }); }
    catch { throw new ConfigReadLockError('validate', 'file-unavailable', index); }
    const directory = position < components.length - 1;
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
      throw new ConfigReadLockError('validate', 'unsafe-path', index);
    }
    result.push({ name: current, dev: stat.dev, ino: stat.ino, directory });
  }
  return result;
}
function sameIdentity(expected: readonly Identity[], actual: readonly Identity[]): boolean {
  return expected.length === actual.length && expected.every((entry, index) => entry.dev === actual[index].dev
    && entry.ino === actual[index].ino && entry.directory === actual[index].directory);
}

/**
 * Acquire BEFORE reading or hashing any config bytes. Only existing, local drive-qualified regular
 * paths are accepted; no creation, config reads/copies, ACL changes or model invocation occurs here.
 * The PowerShell holder opens .NET FileStreams with Read / FileShare.Read and holds them until EOF.
 * Call assertHeld before AND after reads and race longer work against lost; never treat a holder
 * exit as a successful read. This is a cooperative lifetime guard, not a sandbox against a hostile
 * same-user process killing the holder or an administrator. Ancestors are checked but not locked;
 * assertHeld also rejects changed path identities. Use trusted, stable configuration directories.
 */
export async function acquireConfigReadLock(files: readonly string[], signal?: AbortSignal): Promise<ConfigReadLease> {
  if (signal?.aborted) throw new ConfigReadLockError('acquire', 'aborted');
  if (process.platform !== 'win32') throw new ConfigReadLockError('validate', 'unsupported-platform');
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) {
    throw new ConfigReadLockError('validate', 'invalid-input');
  }
  const names = files.map(normalizeFile);
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    throw new ConfigReadLockError('validate', 'invalid-input');
  }
  const identities = names.map(inspectPath);
  const request = JSON.stringify({ protocol: 1, files: names }) + '\n';
  if (Buffer.byteLength(request, 'utf8') > MAX_REQUEST_BYTES) throw new ConfigReadLockError('validate', 'invalid-input');
  try { inspectPath(POWERSHELL); inspectPath(HOLDER); }
  catch { throw new ConfigReadLockError('launch', 'holder-unavailable'); }
  if (signal?.aborted) throw new ConfigReadLockError('acquire', 'aborted');

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HOLDER], {
      cwd: SYSTEM_DIRECTORY, shell: false, windowsHide: true, detached: false,
      // Do not inherit credentials, profile/module paths, .NET profiler hooks, NODE_OPTIONS, etc.
      env: { SystemRoot: SYSTEM_ROOT, WINDIR: SYSTEM_ROOT, PSModulePath: `${POWERSHELL_HOME}\\Modules` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch { throw new ConfigReadLockError('launch', 'spawn-failed'); }

  let state: 'acquiring' | 'held' | 'releasing' | 'lost' | 'closed' = 'acquiring';
  let failure: ConfigReadLockError | undefined;
  let closed = false;
  let readyReceived = false;
  let outputBytes = 0;
  let stdout = '';
  let stopPromise: Promise<void> | undefined;
  let acquisitionTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveLost!: () => void;
  let resolveClosed!: () => void;
  let resolveReady!: () => void;
  let rejectReady!: (error: ConfigReadLockError) => void;
  const lost = new Promise<void>((resolve) => { resolveLost = resolve; });
  const closure = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const readiness = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // A synchronous stdin/spawn failure can precede the await below. Keep the rejection observed.
  void readiness.catch(() => undefined);

  const detach = (): void => {
    if (acquisitionTimer) clearTimeout(acquisitionTimer);
    signal?.removeEventListener('abort', abort);
  };
  const kill = (): void => { try { child.kill('SIGKILL'); } catch { /* close/error/deadline remains authoritative */ } };
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    detach();
    stopPromise = new Promise<void>((resolve, reject) => {
      if (closed) { resolve(); return; }
      killTimer = setTimeout(kill, RELEASE_GRACE_MS);
      cleanupTimer = setTimeout(() => {
        kill();
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
        reject(new ConfigReadLockError('release', 'cleanup-timeout'));
      }, CLEANUP_TIMEOUT_MS);
      void closure.then(() => {
        if (killTimer) clearTimeout(killTimer);
        if (cleanupTimer) clearTimeout(cleanupTimer);
        resolve();
      });
      try { child.stdin.end('release\n'); } catch { kill(); }
    });
    // Background failure handling must not produce an unhandled rejection; release still returns it.
    void stopPromise.catch(() => undefined);
    return stopPromise;
  };
  const invalidate = (error: ConfigReadLockError): void => {
    if (state === 'releasing' || state === 'closed' || state === 'lost') return;
    const wasHeld = state === 'held';
    failure ??= error;
    state = 'lost';
    rejectReady(failure);
    if (wasHeld) resolveLost();
    void stop();
  };
  function abort(): void { invalidate(new ConfigReadLockError(state === 'acquiring' ? 'acquire' : 'held', 'aborted')); }
  const live = (): boolean => {
    if (state !== 'held') return false;
    if (signal?.aborted) { abort(); return false; }
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
      invalidate(new ConfigReadLockError('held', 'holder-exited')); return false;
    }
    try { process.kill(child.pid, 0); }
    catch { invalidate(new ConfigReadLockError('held', 'holder-exited')); return false; }
    for (let index = 0; index < names.length; index++) {
      try {
        if (!sameIdentity(identities[index], inspectPath(names[index], index))) throw new Error();
      } catch { invalidate(new ConfigReadLockError('held', 'path-changed', index)); return false; }
    }
    return true;
  };
  const lease: ConfigReadLease = Object.freeze({
    ready: Object.freeze({ protocol: 1 as const, status: 'ready' as const, fileCount: names.length }),
    lost,
    isAlive: live,
    assertHeld() {
      if (!live()) throw failure ?? new ConfigReadLockError('held', 'not-held');
    },
    release() {
      if (state === 'held' || state === 'acquiring') state = 'releasing';
      return stop();
    },
  });
  const protocolFailure = (): void => invalidate(new ConfigReadLockError(state === 'acquiring' ? 'acquire' : 'held', 'protocol-error'));
  child.stdout.on('data', (chunk: Buffer) => {
    if (state === 'lost' || state === 'releasing' || state === 'closed') return;
    // Readiness is a single-frame boundary: any later stdout, even without a newline, is a protocol failure.
    if (readyReceived) { protocolFailure(); return; }
    outputBytes += chunk.length;
    if (outputBytes > MAX_OUTPUT_BYTES) {
      invalidate(new ConfigReadLockError(state === 'acquiring' ? 'acquire' : 'held', 'output-limit')); return;
    }
    stdout += chunk.toString('utf8');
    const newline = stdout.indexOf('\n');
    if (newline < 0) return;
    // The holder emits exactly one bounded frame; no stdout is valid after readiness.
    if (readyReceived || stdout.slice(newline + 1).length) { protocolFailure(); return; }
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>; }
    catch { protocolFailure(); return; }
    stdout = '';
    if (!frame || typeof frame !== 'object' || Array.isArray(frame) || frame.protocol !== 1) { protocolFailure(); return; }
    if (frame.status === 'error' && Object.keys(frame).sort().join(',') === 'code,fileIndex,protocol,stage,status'
      && (frame.stage === 'validate' || frame.stage === 'acquire' || frame.stage === 'held')
      && ['invalid-input', 'unsafe-path', 'file-unavailable', 'open-failed', 'protocol-error'].includes(String(frame.code))
      && (frame.fileIndex === null || (Number.isInteger(frame.fileIndex) && (frame.fileIndex as number) >= 0
        && (frame.fileIndex as number) < names.length))) {
      invalidate(new ConfigReadLockError(frame.stage, frame.code as ConfigReadLockCode, frame.fileIndex === null ? undefined : frame.fileIndex as number));
      return;
    }
    if (frame.status !== 'ready' || frame.fileCount !== names.length
      || Object.keys(frame).sort().join(',') !== 'fileCount,protocol,status') { protocolFailure(); return; }
    readyReceived = true;
    state = 'held';
    if (acquisitionTimer) clearTimeout(acquisitionTimer);
    if (live()) resolveReady();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    // Never store or expose child stderr, even for startup/parse failures containing paths.
    outputBytes += chunk.length;
    invalidate(new ConfigReadLockError(state === 'acquiring' ? 'acquire' : 'held',
      outputBytes > MAX_OUTPUT_BYTES ? 'output-limit' : 'protocol-error'));
  });
  child.stdin.on('error', () => invalidate(new ConfigReadLockError(state === 'acquiring' ? 'acquire' : 'held', 'holder-exited')));
  child.stdout.on('error', protocolFailure);
  child.stderr.on('error', protocolFailure);
  child.on('error', () => invalidate(new ConfigReadLockError(readyReceived ? 'held' : 'launch', readyReceived ? 'holder-exited' : 'spawn-failed')));
  // exit, not just close: inherited/broken pipes must never make a dead holder appear healthy.
  child.on('exit', () => invalidate(new ConfigReadLockError(readyReceived ? 'held' : 'acquire', 'holder-exited')));
  child.on('close', () => {
    invalidate(new ConfigReadLockError(readyReceived ? 'held' : 'acquire', 'holder-exited'));
    closed = true;
    if (state === 'releasing') state = 'closed';
    detach();
    child.stdin.destroy();
    resolveClosed();
  });
  signal?.addEventListener('abort', abort, { once: true });
  acquisitionTimer = setTimeout(() => invalidate(new ConfigReadLockError('acquire', 'timeout')), CONFIG_READ_LOCK_ACQUIRE_TIMEOUT_MS);
  if (signal?.aborted) abort();
  else {
    try { child.stdin.write(request, 'utf8'); }
    catch { invalidate(new ConfigReadLockError('acquire', 'holder-exited')); }
  }
  try {
    await readiness;
    lease.assertHeld();
    return lease;
  } catch (error) {
    const safe = error instanceof ConfigReadLockError ? error : new ConfigReadLockError('acquire', 'protocol-error');
    try { await stop(); } catch { safe.cleanupFailed = true; }
    throw safe;
  }
}
