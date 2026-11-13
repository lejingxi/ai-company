import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acquireConfigReadLock, ConfigReadLockError, type ConfigReadLease } from '../src/server/runners/config-read-lock.js';

type SpawnedChild = ReturnType<typeof childProcess.spawn>;
const windows = process.platform === 'win32';
const timeoutMs = 20_000;

function fixture(): { directory: string; files: string[] } {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-company-config-read-lock-'));
  const first = path.join(directory, 'config-one.fixture.json');
  const second = path.join(directory, 'config-two.fixture.json');
  writeFileSync(first, '{"fixture":"one"}\n', { encoding: 'utf8', flag: 'wx' });
  writeFileSync(second, '{"fixture":"two"}\n', { encoding: 'utf8', flag: 'wx' });
  return { directory, files: [first, second] };
}
function cleanup(directory: string): void {
  try { rmSync(directory, { recursive: true, force: true }); } catch { /* best-effort fixture cleanup */ }
}
function expectLockFailure(action: () => void): string {
  try { action(); } catch (error) {
    assert.ok(error && typeof error === 'object');
    const code = (error as NodeJS.ErrnoException).code;
    assert.ok(code === 'EBUSY' || code === 'EPERM' || code === 'EACCES', `unexpected Windows lock code ${String(code)}`);
    return code;
  }
  assert.fail('mutation unexpectedly succeeded while the read lock was held');
}
async function releaseLease(lease: ConfigReadLease): Promise<void> {
  await lease.release();
  assert.equal(lease.isAlive(), false);
}
function waitForLost(lease: ConfigReadLease, milliseconds = timeoutMs): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lost promise timed out')), milliseconds);
    lease.lost.then(() => { clearTimeout(timer); resolve(); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

// All fixtures are generated under the OS temp directory. No installed ZCode path is resolved or read.
test('FileShare.Read permits ordinary readers but refuses truncation, rename, and atomic replacement', { skip: !windows }, async (t) => {
  const { directory, files } = fixture();
  t.after(() => cleanup(directory));
  const lease = await acquireConfigReadLock(files);
  try {
    lease.assertHeld();
    assert.deepEqual(files.map((file) => readFileSync(file, 'utf8')), ['{"fixture":"one"}\n', '{"fixture":"two"}\n']);
    for (const file of files) {
      expectLockFailure(() => writeFileSync(file, 'attempted truncation\n', 'utf8'));
      assert.equal(readFileSync(file, 'utf8').includes('attempted truncation'), false);
    }
    const renamed = `${files[0]}.renamed.fixture`;
    expectLockFailure(() => renameSync(files[0], renamed));
    assert.equal(existsSync(files[0]), true);
    assert.equal(existsSync(renamed), false);
    const replacement = path.join(directory, 'replacement.fixture.json');
    writeFileSync(replacement, '{"fixture":"replacement"}\n', { encoding: 'utf8', flag: 'wx' });
    expectLockFailure(() => renameSync(replacement, files[1]));
    assert.equal(readFileSync(files[1], 'utf8'), '{"fixture":"two"}\n');
    assert.equal(statSync(files[0]).isFile(), true);
    lease.assertHeld();
  } finally {
    await releaseLease(lease);
  }
  writeFileSync(files[0], 'released write\n', 'utf8');
  assert.equal(readFileSync(files[0], 'utf8'), 'released write\n');
});

test('release disposes all streams and unblocks every fixture', { skip: !windows }, async (t) => {
  const { directory, files } = fixture();
  t.after(() => cleanup(directory));
  const lease = await acquireConfigReadLock(files);
  await releaseLease(lease);
  for (const file of files) {
    writeFileSync(file, 'after release\n', 'utf8');
    assert.equal(readFileSync(file, 'utf8'), 'after release\n');
  }
  // Intentional release is not reported as a loss and therefore never creates a rejecting/unhandled promise.
  const settled = await Promise.race([lease.lost.then(() => true), Promise.resolve(false)]);
  assert.equal(settled, false);
});

test('unexpected holder termination resolves lost, fails closed, and unblocks fixtures', { skip: !windows }, async (t) => {
  const { directory, files } = fixture();
  t.after(() => cleanup(directory));
  const originalSpawn = childProcess.spawn;
  let holder: SpawnedChild | undefined;
  childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
    const child = originalSpawn(...args);
    holder = child;
    return child;
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    if (holder && holder.exitCode === null) holder.kill('SIGKILL');
  });
  const lease = await acquireConfigReadLock(files);
  assert.ok(holder?.pid);
  try {
    holder.kill('SIGKILL');
    await waitForLost(lease);
    assert.equal(lease.isAlive(), false);
    assert.throws(() => lease.assertHeld(), (error: unknown) => {
      assert.ok(error instanceof ConfigReadLockError);
      assert.equal(error.stage, 'held');
      assert.equal(error.code, 'holder-exited');
      return true;
    });
    writeFileSync(files[0], 'after unexpected holder exit\n', 'utf8');
    assert.equal(readFileSync(files[0], 'utf8'), 'after unexpected holder exit\n');
    await lease.release();
  } finally {
    // release is idempotent even after the holder has already exited.
    await lease.release();
  }
});

test('cancellation after readiness resolves lost, cleans the holder, and unblocks fixtures', { skip: !windows }, async (t) => {
  const { directory, files } = fixture();
  t.after(() => cleanup(directory));
  const controller = new AbortController();
  const lease = await acquireConfigReadLock(files, controller.signal);
  controller.abort();
  await waitForLost(lease);
  assert.equal(lease.isAlive(), false);
  assert.throws(() => lease.assertHeld(), /Config read lock held: aborted/);
  await lease.release();
  writeFileSync(files[1], 'after cancellation\n', 'utf8');
  assert.equal(readFileSync(files[1], 'utf8'), 'after cancellation\n');
});

test('pre-abort and invalid fixture acquisition fail safely without creating or changing files', { skip: !windows }, async (t) => {
  const { directory, files } = fixture();
  t.after(() => cleanup(directory));
  const before = files.map((file) => readFileSync(file, 'utf8'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(acquireConfigReadLock(files, controller.signal), (error: unknown) => {
    assert.ok(error instanceof ConfigReadLockError);
    assert.equal(error.stage, 'acquire');
    assert.equal(error.code, 'aborted');
    assert.doesNotMatch(error.message, /config-one|config-two|fixture/);
    return true;
  });
  const missing = path.join(directory, 'missing.fixture.json');
  await assert.rejects(acquireConfigReadLock([missing]), (error: unknown) => {
    assert.ok(error instanceof ConfigReadLockError);
    assert.equal(error.stage, 'validate');
    assert.equal(error.code, 'file-unavailable');
    assert.doesNotMatch(error.message, /missing|fixture/);
    return true;
  });
  assert.equal(existsSync(missing), false);
  assert.deepEqual(files.map((file) => readFileSync(file, 'utf8')), before);
});

test('acquisition failure after fixture removal cleans the failed holder and never creates the file', { skip: !windows }, async (t) => {
  const { directory, files } = fixture();
  t.after(() => cleanup(directory));
  const originalSpawn = childProcess.spawn;
  let removed = false;
  childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
    if (!removed) {
      removed = true;
      rmSync(files[0]);
    }
    return originalSpawn(...args);
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  t.after(() => { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); });
  const started = Date.now();
  await assert.rejects(acquireConfigReadLock([files[0]]), (error: unknown) => {
    assert.ok(error instanceof ConfigReadLockError);
    assert.equal(error.stage, 'validate');
    assert.equal(error.code, 'file-unavailable');
    assert.doesNotMatch(error.message, /config-one|fixture/);
    return true;
  });
  assert.ok(Date.now() - started < 5_000, 'failed acquisition must not hang');
  assert.equal(existsSync(files[0]), false);
  writeFileSync(files[0], 'after failed acquisition\n', { encoding: 'utf8', flag: 'wx' });
  assert.equal(readFileSync(files[0], 'utf8'), 'after failed acquisition\n');
});

test('path validation fails closed for reparse points, directories, duplicate paths, and non-Windows paths', { skip: !windows }, async (t) => {
  const { directory, files } = fixture();
  t.after(() => cleanup(directory));
  const directoryPath = path.join(directory, 'not-a-file.fixture');
  // Directory input must not be opened as a stream.
  const fs = await import('node:fs');
  fs.mkdirSync(directoryPath);
  for (const candidate of [[directoryPath], [files[0], files[0]], [path.join(directory, 'missing.fixture')], ['relative.fixture']]) {
    await assert.rejects(acquireConfigReadLock(candidate), (error: unknown) => {
      assert.ok(error instanceof ConfigReadLockError);
      assert.equal(error.stage, candidate[0] === path.join(directory, 'missing.fixture') ? 'validate' : 'validate');
      assert.ok(['invalid-input', 'unsafe-path', 'file-unavailable'].includes(error.code));
      assert.doesNotMatch(error.message, /not-a-file|relative|missing/);
      return true;
    });
  }
});

test('lease readiness metadata is bounded and errors expose only stage/code', { skip: !windows }, async (t) => {
  const { directory, files } = fixture();
  t.after(() => cleanup(directory));
  const lease = await acquireConfigReadLock(files);
  try {
    assert.deepEqual(lease.ready, { protocol: 1, status: 'ready', fileCount: 2 });
    assert.equal(lease.isAlive(), true);
    lease.assertHeld();
  } finally { await releaseLease(lease); }
});
