import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Capability, TestResult } from '../../shared/types.js';
import { runProcess } from './process.js';
import { assertManagedTaskWorkspace } from './workspace.js';

export interface DockerOptions { executable: string; image: string; timeoutMs: number }
const MAX_LOG = 256 * 1024;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const CONTAINER = /^ai-company-test-[a-f0-9-]{36}$/;
function imageReference(image: string): void {
  if (!image || image.length > 255 || image.startsWith('-') || !/^[A-Za-z0-9][A-Za-z0-9._/@:+-]*$/.test(image)) {
    throw new Error('Invalid Docker image reference');
  }
}
function fixedTests(workspace: string): string[] {
  const directory = path.join(workspace, 'tests');
  const tests = readdirSync(directory).filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.test\.mjs$/.test(name)).sort();
  if (!tests.length || tests.length > 50) throw new Error('Docker requires 1–50 tests/*.test.mjs files');
  for (const name of tests) {
    const file = path.join(directory, name);
    const stat = lstatSync(file);
    const real = realpathSync.native(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (process.platform === 'win32' ? real.toLowerCase() !== file.toLowerCase() : real !== file)) {
      throw new Error('Unsafe Docker test file');
    }
  }
  return tests.map((name) => `tests/${name}`);
}

export function buildDockerArgs(workspace: string, image: string, containerName: string): string[] {
  imageReference(image);
  if (!CONTAINER.test(containerName)) throw new Error('Invalid generated Docker container name');
  const absolute = assertManagedTaskWorkspace(workspace);
  if (absolute.includes(',') || absolute.includes('"')) throw new Error('Invalid Docker mount source');
  const tests = fixedTests(absolute);
  return [
    'run', '--name', containerName, '--pull', 'never',
    '--network', 'none', '--read-only', '--user', '1000:1000',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '64', '--memory', '256m', '--memory-swap', '256m', '--cpus', '1',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777',
    '--mount', `type=bind,source=${absolute},target=/workspace,readonly`,
    '--workdir', '/workspace', '--env', 'NODE_OPTIONS=', '--entrypoint', 'node',
    image, '--test', ...tests,
  ];
}
function validateOptions(options: DockerOptions): void {
  imageReference(options.image);
  if (!options.executable || /[\x00-\x1f\x7f]/.test(options.executable)
    || !Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647) {
    throw new Error('Invalid Docker executable or timeout');
  }
}
async function inspectImage(options: DockerOptions, signal?: AbortSignal): Promise<{ id: string; digest: string }> {
  const result = await runProcess(options.executable, ['image', 'inspect', '--format', '{{json .}}', options.image], {
    cwd: process.cwd(), timeoutMs: Math.min(options.timeoutMs, 10000), signal, maxOutputBytes: MAX_LOG,
  });
  if (result.cancelled) throw new Error('Docker image inspection cancelled');
  if (result.timedOut) throw new Error('Docker image inspection timed out');
  if (result.exitCode !== 0) throw new Error('Docker image is unavailable locally; automatic pulling is disabled');
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) >= MAX_LOG) throw new Error('Docker image metadata is oversized');
  let image: unknown;
  try { image = JSON.parse(result.stdout); } catch { throw new Error('Docker image inspection returned invalid JSON'); }
  if (!image || typeof image !== 'object' || Array.isArray(image)) throw new Error('Invalid Docker image metadata');
  const metadata = image as { Id?: unknown; RepoDigests?: unknown; Config?: { Volumes?: unknown; Env?: unknown } };
  if (typeof metadata.Id !== 'string' || !IMAGE_ID.test(metadata.Id)) throw new Error('Docker did not return an immutable image ID');
  // Dockerfile VOLUME instructions would create implicit writable mounts; refuse them.
  if (metadata.Config?.Volumes && Object.keys(metadata.Config.Volumes).length) throw new Error('Docker images with implicit volumes are not allowed');
  const repoDigests = Array.isArray(metadata.RepoDigests) ? metadata.RepoDigests : [];
  const digest = repoDigests.find((value): value is string => typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._/:-]*@sha256:[a-f0-9]{64}$/.test(value)) ?? metadata.Id;
  return { id: metadata.Id, digest };
}

/** Explicit caller-triggered probe only; importing this module does not contact Docker. */
export async function checkDocker(options: DockerOptions): Promise<Capability> {
  try {
    validateOptions(options);
    const result = await runProcess(options.executable, ['info', '--format', '{{json .ServerVersion}}'], {
      cwd: process.cwd(), timeoutMs: Math.min(options.timeoutMs, 10000), maxOutputBytes: 16 * 1024,
    });
    if (result.exitCode !== 0 || result.timedOut || result.cancelled || !result.stdout.trim()) {
      return { ready: false, reason: 'Docker daemon is unavailable or the bounded probe failed' };
    }
    const image = await inspectImage(options);
    return { ready: true, reason: `Docker reachable; local image pinned to ${image.id}` };
  } catch (error) { return { ready: false, reason: `Docker blocked: ${(error as Error).message}` }; }
}

export async function runDockerTests(workspace: string, options: DockerOptions, signal: AbortSignal): Promise<TestResult> {
  const started = Date.now();
  const containerName = `ai-company-test-${randomUUID()}`;
  let attempted = false;
  let digest: string | null = null;
  let command = ['node', '--test'];
  let result: TestResult = { status: 'blocked', exitCode: null, log: '', image: options.image, imageDigest: null, command, durationMs: 0 };
  try {
    validateOptions(options);
    if (signal.aborted) throw new Error('Docker tests cancelled before launch');
    const absolute = assertManagedTaskWorkspace(workspace);
    const tests = fixedTests(absolute);
    command = ['node', '--test', ...tests];
    const image = await inspectImage(options, signal);
    digest = image.digest;
    if (signal.aborted) throw new Error('Docker tests cancelled before launch');
    // Always use the inspected immutable ID, never the potentially mutable configured tag.
    const args = buildDockerArgs(absolute, image.id, containerName);
    attempted = true;
    const execution = await runProcess(options.executable, args, {
      cwd: process.cwd(), timeoutMs: options.timeoutMs, signal, maxOutputBytes: MAX_LOG,
    });
    const blocked = execution.cancelled || execution.timedOut || execution.exitCode === null
      || [125, 126, 127].includes(execution.exitCode);
    const note = execution.cancelled ? 'Docker tests cancelled; no passing result.'
      : execution.timedOut ? 'Docker tests timed out; no passing result.' : '';
    result = {
      status: blocked ? 'blocked' : execution.exitCode === 0 ? 'passed' : 'failed',
      exitCode: execution.exitCode, log: [note, execution.stdout, execution.stderr].filter(Boolean).join('\n'),
      image: options.image, imageDigest: digest, command, durationMs: 0,
    };
  } catch (error) {
    result = { status: 'blocked', exitCode: null, log: `Docker blocked: ${(error as Error).message}`,
      image: options.image, imageDigest: digest, command, durationMs: 0 };
  } finally {
    if (attempted) {
      // Cleanup has a fresh deadline and no aborted signal. No broad rm, prune, name filter, or user-supplied ID.
      try {
        const cleanup = await runProcess(options.executable, ['rm', '-f', containerName], {
          cwd: process.cwd(), timeoutMs: 5000, maxOutputBytes: 8192,
        });
        if (cleanup.exitCode !== 0 || cleanup.timedOut || cleanup.cancelled) {
          result.status = 'blocked';
          result.log += `\nCleanup could not confirm removal of ${containerName}; manual inspection is required.`;
        }
      } catch {
        result.status = 'blocked';
        result.log += `\nCleanup failed for ${containerName}; manual inspection is required.`;
      }
    }
  }
  result.durationMs = Date.now() - started;
  if (Buffer.byteLength(result.log) > MAX_LOG) result.log = Buffer.from(result.log).subarray(0, MAX_LOG - 64).toString('utf8') + '\n[log truncated]';
  return result;
}
