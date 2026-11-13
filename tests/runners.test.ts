import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ModelBinding, Project, RunnerInput, Stage } from '../src/shared/types.js';
import { buildDockerArgs, checkDocker, runDockerTests } from '../src/server/runners/docker.js';
import { runFake } from '../src/server/runners/fake.js';
import { runProcess } from '../src/server/runners/process.js';
import { validateCandidateChanges, WorkspaceManager } from '../src/server/runners/workspace.js';
import {
  buildZcodeEnvironment, checkZcode, extractObservedModel, extractObservedTools, fingerprintCurrentZcode, modelBindingSupport, parseAgentOutput,
  parseStreamJson, redactRunDiagnostic, ZcodeRunner, type ZcodeOptions, type ZcodeTransport,
} from '../src/server/runners/zcode.js';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const immutableImage = `sha256:${'a'.repeat(64)}`;
const containerName = 'ai-company-test-12345678-1234-1234-1234-123456789abc';
const selectedModel: ModelBinding = Object.freeze({
  catalogId: 'configured-model-fixture', providerId: 'test-provider', modelId: 'model-v1', reasoningLevel: 'high',
  selectionRevision: 1, catalogRevision: 'a'.repeat(64), selectionFingerprint: 'b'.repeat(64),
});
const unsupportedBindingReason = '当前模型绑定尚未通过原生 ZCode 会话验收；不会回退到默认模型';
/** TEST ONLY: emulates a future model-aware protocol. No installed CLI supports this binding. */
function mockModelTransport(binding: ModelBinding = selectedModel): ZcodeTransport {
  const expected = { ...binding };
  const spawn = childProcess.spawn;
  return {
    supports(actual) {
      assert.deepEqual(actual, expected);
      return { ready: true, reason: 'TEST ONLY model-aware transport, not installed CLI support' };
    },
    async invoke(request, options, signal, policy) {
      assert.deepEqual(options.modelBinding, expected, 'invoke receives the complete selected binding unchanged');
      assert.equal(signal, request.signal);
      assert.equal(Object.isFrozen(options.modelBinding), true);
      assert.equal(Object.isFrozen(options), true);
      // Exercise the historical argument/env contract through the real process wrapper, but never a real spawn.
      // Capture/require the test's mock so this adapter cannot accidentally launch anything after mock cleanup.
      assert.notEqual(childProcess.spawn, unmockedSpawn, 'test transport requires mocked spawn');
      assert.equal(childProcess.spawn, spawn, 'test transport stays bound to its own mock');
      const args = [options.cliPath, '--prompt', policy.prompt, '--cwd', policy.cwd,
        '--output-format', 'stream-json', '--mode', policy.mode, '--disallowed-tools', policy.disallowedTools.join(',')];
      if (request.sessionId) args.push('--resume', request.sessionId);
      return runProcess(options.electronPath, args, {
        cwd: policy.cwd, env: policy.env, timeoutMs: options.timeoutMs, signal, maxOutputBytes: policy.maxOutputBytes,
      });
    },
  };
}
const unmockedSpawn = childProcess.spawn;
function testZcodeRunner(options: ZcodeOptions): ZcodeRunner {
  return new ZcodeRunner(options, mockModelTransport(options.modelBinding));
}
function removeTree(directory: string): void {
  if (!existsSync(directory)) return;
  const unlock = (name: string): void => {
    const stat = lstatSync(name);
    if (stat.isSymbolicLink()) return;
    chmodSync(name, stat.isDirectory() ? 0o700 : 0o600);
    if (stat.isDirectory()) for (const entry of readdirSync(name)) unlock(path.join(name, entry));
  };
  unlock(directory);
  rmSync(directory, { recursive: true, force: true });
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(projectDirectory, '.runners-test-'));
  t.after(() => removeTree(directory));
  const root = path.join(directory, 'workspaces');
  const manager = new WorkspaceManager(root);
  const project: Project = {
    id: 'project-one', name: 'Demo', description: 'Test', workspace: manager.createProject('project-one'),
    leadId: null, stack: 'node', testCommand: ['node', '--test'], dockerImage: 'node:24-alpine', createdAt: '2026-01-01',
  };
  const workspace = manager.createTask(project, 'task-one');
  return { directory, root, manager, project, workspace };
}
function input(workspace: string, project: Project, stage: Stage = 'development'): RunnerInput {
  return {
    workspace, project, stage, prompt: 'Return structured changes only.', signal: new AbortController().signal,
    employee: { id: 'employee', name: 'Test', role: 'developer', duties: '', reportsTo: null, projectIds: [project.id], enabled: true, createdAt: '' },
    task: { id: 'task-one', title: 'Add', goal: 'Implement add', projectId: project.id, leaderId: 'lead', developerId: 'dev', qaId: 'qa',
      status: 'developing', mode: 'simulation', version: 1, contentHash: null, plan: null, blockedReason: null, createdAt: '', updatedAt: '' },
  };
}
const output = { summary: 'Done', files: [{ path: 'src/add.mjs', content: 'export const add = (a, b) => a + b;\n' }] };
function ndjson(value: unknown = output): string { return JSON.stringify({ type: 'result', sessionId: 'session-123', response: value }) + '\n'; }

type SpawnCall = { command: string; args: string[]; options: childProcess.SpawnOptions };
type Reply = { stdout?: string; stderr?: string; code?: number; error?: Error };
function mockSpawn(t: TestContext, reply: (call: SpawnCall) => Reply): SpawnCall[] {
  const original = childProcess.spawn;
  const calls: SpawnCall[] = [];
  childProcess.spawn = ((command: string, args: string[], options: childProcess.SpawnOptions) => {
    const call = { command, args, options };
    calls.push(call);
    const child = Object.assign(new EventEmitter(), {
      pid: undefined, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null,
      kill: () => true, unref: () => undefined,
    });
    queueMicrotask(() => {
      try {
        const result = reply(call);
        if (result.error) { child.emit('error', result.error); return; }
        if (result.stdout) child.stdout.write(result.stdout);
        if (result.stderr) child.stderr.write(result.stderr);
        child.stdout.end();
        child.stderr.end();
        child.exitCode = result.code ?? 0;
        child.emit('close', child.exitCode);
      } catch (error) { child.emit('error', error); }
    });
    return child;
  }) as unknown as typeof childProcess.spawn;
  syncBuiltinESMExports();
  t.after(() => { childProcess.spawn = original; syncBuiltinESMExports(); });
  return calls;
}
function setEnvironment(t: TestContext, values: NodeJS.ProcessEnv): void {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
}
function zcodeOptions(t: TestContext, directory: string): ZcodeOptions {
  const electronPath = path.join(directory, 'fake-electron');
  const cliPath = path.join(directory, 'fake-cli.cjs');
  const home = path.join(directory, 'existing-user-home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localData = path.join(home, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localData, { recursive: true });
  mkdirSync(path.join(home, '.zcode', 'cli'), { recursive: true });
  mkdirSync(path.join(home, '.zcode', 'plugins'), { recursive: true });
  mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true });
  // These are test-only fixtures, never copied from or read from a real user's configuration.
  writeFileSync(path.join(home, '.zcode', 'cli', 'config.json'), 'fixture config is deliberately not valid JSON');
  writeFileSync(path.join(home, '.zcode', 'plugins', 'fixture.txt'), 'plugin fixture must not be copied or mutated');
  writeFileSync(path.join(home, '.agents', 'skills', 'fixture.txt'), 'skill fixture must not be copied or mutated');
  setEnvironment(t, {
    HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localData,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_STATE_HOME: path.join(home, '.local', 'state'),
    HOMEDRIVE: path.parse(home).root.slice(0, 2), HOMEPATH: home.slice(2),
  });
  writeFileSync(electronPath, 'not executable; spawn is mocked');
  writeFileSync(cliPath, 'not executable; spawn is mocked');
  const options: ZcodeOptions = {
    electronPath, cliPath, enabled: true, environmentMode: 'existing-user', timeoutMs: 1000, modelBinding: { ...selectedModel },
  };
  return { ...options, verificationFingerprint: fingerprintCurrentZcode(options) };
}

// Workspace lifecycle, content hashing, and isolation.
test('demo and independent task copy have stable snapshots and external immutable baselines', (t) => {
  const { manager, root, workspace, project } = fixture(t);
  const original = manager.snapshot(workspace);
  assert.equal(original.hash, manager.snapshot(project.workspace).hash);
  assert.deepEqual(original.files.map((file) => file.path), ['README.md', 'src/add.mjs', 'tests/add.test.mjs']);
  assert.ok(original.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256) && file.bytes > 0));
  assert.equal(manager.diff(workspace), '');
  assert.ok(existsSync(path.join(root, 'baselines', 'task-one', 'src', 'add.mjs')));
  assert.ok(!existsSync(path.join(workspace, '.git')));
  assert.match(manager.readContext(workspace), /export function add/);
  const projectSource = readFileSync(path.join(project.workspace, 'src', 'add.mjs'), 'utf8');
  manager.applyChanges(workspace, output.files, 'development');
  assert.notEqual(manager.snapshot(workspace).hash, original.hash);
  assert.equal(readFileSync(path.join(project.workspace, 'src', 'add.mjs'), 'utf8'), projectSource);
  assert.equal(manager.createTask(project, 'task-one'), workspace);
  assert.equal(manager.createProject(project.id), project.workspace);
  assert.equal(readFileSync(path.join(workspace, 'src', 'add.mjs'), 'utf8'), output.files[0].content);
  const difference = manager.diff(workspace);
  assert.match(difference, /--- a\/src\/add\.mjs/);
  assert.match(difference, /-export function add/);
  assert.match(difference, /\+export const add/);
  assert.match(readFileSync(path.join(root, 'baselines', 'task-one', 'src', 'add.mjs'), 'utf8'), /export function add/);
});

test('project/task ids and candidate paths reject traversal, drive, UNC, NUL, and forbidden directories', (t) => {
  const { manager, project, workspace, directory } = fixture(t);
  for (const invalid of ['../escape', '.', '..', '/absolute', 'C:\\escape', 'C:relative', '\\\\host\\share', 'a\0b', '.git', '.env', 'node_modules', 'CON']) {
    assert.throws(() => manager.createTask(project, invalid), Error, invalid);
    assert.throws(() => manager.createProject(invalid), Error, invalid);
  }
  const invalidFiles = ['../outside.mjs', '/absolute.mjs', 'C:/escape.mjs', 'C:escape.mjs', '\\\\server\\share', 'src\\escape.mjs',
    'src/a\0b.mjs', '.git/config', '.env', '.env.local', 'node_modules/a.mjs', 'src/.git/config', 'src/a/../escape.mjs',
    'src//escape.mjs', 'src/CON.mjs', 'src/a.mjs:stream', 'src/a./file.mjs', 'src/a /file.mjs'];
  const before = manager.snapshot(workspace).hash;
  for (const file of invalidFiles) assert.throws(() => manager.applyChanges(workspace, [{ path: file, content: 'x' }], 'development'), Error, file);
  assert.equal(manager.snapshot(workspace).hash, before);
  assert.throws(() => manager.snapshot(directory));
  assert.throws(() => manager.snapshot(path.join(directory, 'other', 'tasks', 'task-one')));
  assert.throws(() => manager.createTask({ ...project, workspace }, 'different'));
  assert.throws(() => manager.createTask({ ...project, id: 'another' }, 'different'));
});

test('development cannot change tests or manifests; QA can only change top-level test mjs files', (t) => {
  const { manager, workspace } = fixture(t);
  for (const name of ['tests/add.test.mjs', 'src/add.test.mjs', 'src/__tests__/add.mjs', 'package.json', 'src/package.json', 'package-lock.json', 'src/.npmrc']) {
    assert.throws(() => manager.applyChanges(workspace, [{ path: name, content: 'changed' }], 'development'), Error, name);
  }
  for (const name of ['src/add.mjs', 'README.md', 'tests/helper.mjs', 'tests/nested/add.test.mjs', 'tests/package.json', 'package.json']) {
    assert.throws(() => manager.applyChanges(workspace, [{ path: name, content: 'changed' }], 'qa'), Error, name);
  }
  for (const stage of ['planning', 'ops'] as const) assert.throws(() => manager.applyChanges(workspace, [], stage));
  manager.applyChanges(workspace, [{ path: 'tests/new.test.mjs', content: "import 'node:test';\n" }], 'qa');
  manager.applyChanges(workspace, [{ path: 'src/nested/value.mjs', content: 'export const value = 1;\n' }], 'development');
  assert.ok(existsSync(path.join(workspace, 'tests', 'new.test.mjs')));
});

test('batch validation is atomic for validation failures and rejects duplicates/case collisions', (t) => {
  const { manager, workspace } = fixture(t);
  const before = manager.snapshot(workspace).hash;
  assert.throws(() => manager.applyChanges(workspace, [...output.files, { path: 'tests/add.test.mjs', content: 'bypass' }], 'development'));
  assert.equal(manager.snapshot(workspace).hash, before);
  assert.throws(() => manager.applyChanges(workspace, [output.files[0], output.files[0]], 'development'));
  assert.throws(() => manager.applyChanges(workspace, [{ path: 'src/ADD.mjs', content: 'case' }], 'development'));
  assert.throws(() => manager.applyChanges(workspace, [{ path: 'src/add.mjs/inner.mjs', content: 'child' }], 'development'));
  assert.equal(manager.snapshot(workspace).hash, before);
});

test('file count and UTF-8 byte limits apply to changes and the entire candidate', (t) => {
  const { manager, workspace } = fixture(t);
  assert.throws(() => manager.applyChanges(workspace, Array.from({ length: 51 }, (_, i) => ({ path: `src/f${i}.mjs`, content: '' })), 'development'));
  assert.throws(() => manager.applyChanges(workspace, [{ path: 'src/big.mjs', content: '界'.repeat(44000) }], 'development'));
  assert.throws(() => manager.applyChanges(workspace, Array.from({ length: 9 }, (_, i) => ({ path: `src/f${i}.mjs`, content: 'a'.repeat(128 * 1024) })), 'development'));
  manager.applyChanges(workspace, Array.from({ length: 47 }, (_, i) => ({ path: `src/f${i}.mjs`, content: '' })), 'development');
  assert.equal(manager.snapshot(workspace).files.length, 50);
  assert.throws(() => manager.applyChanges(workspace, [{ path: 'src/overflow.mjs', content: '' }], 'development'));
  writeFileSync(path.join(workspace, 'src', 'f0.mjs'), 'a'.repeat(128 * 1024 + 1));
  assert.throws(() => manager.snapshot(workspace), /oversized|128KB/);
});

test('snapshot and diff include QA changes and README and text output is bounded', (t) => {
  const { manager, workspace } = fixture(t);
  const before = manager.snapshot(workspace).hash;
  manager.applyChanges(workspace, [{ path: 'tests/add.test.mjs', content: '// new independent test\n' }], 'qa');
  assert.notEqual(manager.snapshot(workspace).hash, before);
  manager.applyChanges(workspace, [{ path: 'README.md', content: '界'.repeat(40000) }], 'development');
  assert.ok(Buffer.byteLength(manager.diff(workspace)) <= 64 * 1024);
  assert.ok(Buffer.byteLength(manager.readContext(workspace)) <= 64 * 1024);
  assert.match(manager.diff(workspace), /truncated/);
});

test('directory links/junctions cannot be scanned, copied, written or mounted', (t) => {
  const { manager, workspace, project, directory } = fixture(t);
  const outside = path.join(directory, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'secret.mjs'), 'must not be read or changed');
  const link = path.join(workspace, 'src', 'linked');
  try { symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('OS does not permit creating test symlinks'); return; }
    throw error;
  }
  assert.throws(() => manager.snapshot(workspace), /symlink|reparse/);
  assert.throws(() => manager.readContext(workspace), /symlink|reparse/);
  assert.throws(() => manager.applyChanges(workspace, [{ path: 'src/linked/secret.mjs', content: 'bad' }], 'development'), /symlink|reparse/);
  assert.throws(() => buildDockerArgs(workspace, immutableImage, containerName), /symlink|reparse/);
  assert.equal(readFileSync(path.join(outside, 'secret.mjs'), 'utf8'), 'must not be read or changed');
  symlinkSync(outside, path.join(project.workspace, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => manager.createTask(project, 'new-task'), /symlink|reparse/);
  assert.throws(() => new WorkspaceManager(path.join(link, 'subroot')), /symlink|reparse/);
});

test('hard links and forbidden files introduced outside applyChanges fail closed', (t) => {
  const { manager, workspace, directory } = fixture(t);
  const target = path.join(directory, 'outside.txt');
  writeFileSync(target, 'secret');
  linkSync(target, path.join(workspace, 'src', 'linked.mjs'));
  assert.throws(() => manager.snapshot(workspace), /hard-linked/);
  rmSync(path.join(workspace, 'src', 'linked.mjs'));
  writeFileSync(path.join(workspace, '.env'), 'SECRET=must-not-read');
  assert.throws(() => manager.readContext(workspace), /forbidden/);
});

test('baseline tampering is detected instead of redefining the diff', (t) => {
  const { manager, workspace, root } = fixture(t);
  const original = path.join(root, 'baselines', 'task-one', 'src', 'add.mjs');
  chmodSync(original, 0o600);
  writeFileSync(original, 'tampered baseline');
  assert.throws(() => manager.diff(workspace), /integrity/);
});

test('stage validation accepts only direct stage-owned edits and never rewrites candidates', (t) => {
  const { manager, workspace } = fixture(t);
  const original = manager.snapshot(workspace);
  assert.deepEqual(manager.assertStageChanges(workspace, original, 'planning'), original);
  assert.deepEqual(manager.assertStageChanges(workspace, original, 'ops'), original);
  writeFileSync(path.join(workspace, 'src', 'add.mjs'), output.files[0].content);
  writeFileSync(path.join(workspace, 'README.md'), 'Updated task documentation\n');
  const developed = manager.assertStageChanges(workspace, original, 'development');
  assert.notEqual(developed.hash, original.hash);
  assert.deepEqual(developed, manager.snapshot(workspace));
  const tests = path.join(workspace, 'tests', 'add.test.mjs');
  writeFileSync(tests, '// independently authored QA test\n');
  const checked = manager.assertStageChanges(workspace, developed, 'qa');
  assert.notEqual(checked.hash, developed.hash);
  assert.equal(readFileSync(tests, 'utf8'), '// independently authored QA test\n');
  // The exact same edits may also be proposed for the workflow's apply step.
  manager.applyChanges(workspace, [{ path: 'tests/add.test.mjs', content: '// independently authored QA test\n' }], 'qa');
  assert.equal(manager.snapshot(workspace).hash, checked.hash);
});

test('manifest diff enforces applyChanges stage rules for direct edits and preserves rejected files', async (t) => {
  const cases: { stage: Stage; file: string }[] = [
    { stage: 'development', file: 'tests/add.test.mjs' }, { stage: 'development', file: 'src/value.test.mjs' },
    { stage: 'development', file: 'src/__tests__/value.mjs' }, { stage: 'development', file: 'src/package.json' },
    { stage: 'development', file: 'package-lock.json' }, { stage: 'development', file: 'src/file.sh' },
    { stage: 'qa', file: 'src/add.mjs' }, { stage: 'qa', file: 'README.md' }, { stage: 'qa', file: 'tests/helper.mjs' },
    { stage: 'planning', file: 'src/add.mjs' }, { stage: 'ops', file: 'tests/add.test.mjs' },
  ];
  for (const { stage, file } of cases) await t.test(`${stage}: ${file}`, (subtest) => {
    const { manager, workspace } = fixture(subtest);
    const before = manager.snapshot(workspace);
    const target = path.join(workspace, ...file.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, 'preserve this rejected edit');
    assert.throws(() => manager.assertStageChanges(workspace, before, stage), /Workspace:/);
    assert.equal(readFileSync(target, 'utf8'), 'preserve this rejected edit');
  });
});

test('post-stage snapshots reject deletions and hidden CLI settings without cleaning them up', async (t) => {
  await t.test('deletion', (subtest) => {
    const { manager, workspace } = fixture(subtest);
    const before = manager.snapshot(workspace);
    const target = path.join(workspace, 'src', 'add.mjs');
    rmSync(target);
    assert.throws(() => manager.assertStageChanges(workspace, before, 'development'), /deletions/);
    assert.equal(existsSync(target), false);
  });
  for (const name of ['.zcode', '.agents']) await t.test(name, (subtest) => {
    const { manager, workspace } = fixture(subtest);
    const before = manager.snapshot(workspace);
    const target = path.join(workspace, name);
    mkdirSync(target);
    writeFileSync(path.join(target, 'config.json'), '{}');
    assert.throws(() => manager.assertStageChanges(workspace, before, 'development'), /forbidden/);
    assert.equal(readFileSync(path.join(target, 'config.json'), 'utf8'), '{}');
  });
});

test('candidate validation rejects forged snapshots, stale baselines and invalid stages', (t) => {
  const { manager, workspace, root } = fixture(t);
  const before = manager.snapshot(workspace);
  assert.throws(() => validateCandidateChanges({ ...before, hash: '0'.repeat(64) }, before, 'development'), /snapshot/);
  assert.throws(() => validateCandidateChanges(before, { ...before, files: [...before.files, before.files[0]] }, 'development'), /snapshot/);
  assert.throws(() => manager.assertStageChanges(workspace, before, 'publish' as Stage), /stage/);
  const baseline = path.join(root, 'baselines', 'task-one', 'src', 'add.mjs');
  chmodSync(baseline, 0o600);
  writeFileSync(baseline, 'tampered');
  assert.throws(() => manager.assertStageChanges(workspace, before, 'development'), /integrity/);
});

// Parsing is tested without any real CLI/model.
test('NDJSON requires exactly one final result, supporting camelCase object/string responses and usage', () => {
  const text = [
    JSON.stringify({ type: 'system', sessionId: 'session-123' }),
    JSON.stringify({ type: 'assistant', message: 'not a result' }),
    JSON.stringify({ type: 'result', sessionId: 'session-123', response: output, usage: { tokens: 7 } }),
  ].join('\r\n');
  const result = parseStreamJson(text);
  assert.equal(result.sessionId, 'session-123');
  assert.deepEqual(JSON.parse(result.response), output);
  assert.deepEqual(result.usage, { tokens: 7 });
  assert.deepEqual(parseAgentOutput(parseStreamJson(ndjson(JSON.stringify(output))).response), output);
  assert.deepEqual(parseAgentOutput('```json\n' + JSON.stringify(output) + '\n```'), output);
});

test('NDJSON rejects missing/duplicate finals, errors, malformed lines, bad sessions, and oversize', () => {
  for (const invalid of ['', 'ordinary stdout', '{', '{}', '[]', '{"type":"assistant","text":"success"}',
    ndjson() + ndjson(), ndjson() + '{"type":"progress"}', '{"type":"error","message":"failed"}\n' + ndjson(),
    '{"type":"result","isError":true,"response":"OK"}', '{"type":"result","subtype":"error_max_turns","response":"OK"}',
    '{"type":"result","response":42}', '{"type":"result","response":""}',
    '{"type":"system","sessionId":"other"}\n' + ndjson(),
    '{"type":"result","sessionId":"../../escape","response":"OK"}', 'x'.repeat(2 * 1024 * 1024 + 1)]) {
    assert.throws(() => parseStreamJson(invalid));
  }
});

test('structured AgentOutput validates exact schema, paths, sizes and every criterion', () => {
  for (const value of [null, [], {}, { summary: '', files: [] }, { summary: 'ok', files: 'none' },
    { summary: 'ok', files: [], executable: 'bad' }, { summary: 'ok', files: [], verdict: true },
    { summary: 'ok', files: [], acceptanceCriteria: [1] }, { summary: 'ok', files: [], acceptanceCriteria: [''] },
    { summary: 'ok', files: [{ path: '../escape', content: 'bad' }] },
    { summary: 'ok', files: [{ path: 'C:/escape', content: 'bad' }] },
    { summary: 'ok', files: [{ path: '.env', content: 'bad' }] },
    { summary: 'ok', files: [{ path: 'src/a.mjs', content: 1 }] },
    { summary: 'ok', files: [{ path: 'src/a.mjs', content: 'ok', executable: true }] },
    { summary: 'ok', files: [output.files[0], output.files[0]] },
    { summary: 'ok', files: [{ path: 'src/a.mjs', content: 'x'.repeat(128 * 1024 + 1) }] }]) {
    assert.throws(() => parseAgentOutput(JSON.stringify(value)));
  }
  assert.throws(() => parseAgentOutput('Here is the answer: ' + JSON.stringify(output)));
  assert.throws(() => parseAgentOutput('```json\n' + JSON.stringify(output)));
});

test('structured output retains validated learning proposals and rejects untrusted metadata', () => {
  const proposal = {
    title: 'Check edge cases', purpose: 'Improve independently authored tests', conditions: 'When reviewing arithmetic changes',
    steps: ['Check negative and zero operands'], cautions: ['Do not change source in QA'], verification: 'Run tests through the host runner', tags: ['qa'],
  };
  const value = { ...output, learningProposals: [proposal] };
  assert.deepEqual(parseAgentOutput(JSON.stringify(value)), value);
  assert.throws(() => parseAgentOutput(JSON.stringify({ ...value, executionMetadata: { model: 'claimed' } })), /schema/);
  assert.throws(() => parseAgentOutput(JSON.stringify({ ...value, learningProposals: [{ ...proposal, purpose: 'apiKey=synthetic-secret' }] })));
});

test('default ZCode checks and runner never spawn for unset/unsupported/stale model binding or legacy evidence', async (t) => {
  const { directory, workspace, project } = fixture(t);
  const options = zcodeOptions(t, directory);
  const calls = mockSpawn(t, () => { throw new Error('must not spawn'); });
  const unset = { ...options, modelBinding: undefined };
  assert.match(modelBindingSupport().reason, /unset/);
  assert.equal(modelBindingSupport().ready, false);
  assert.deepEqual(modelBindingSupport(selectedModel), { ready: false, reason: unsupportedBindingReason });
  assert.deepEqual(await checkZcode(options), modelBindingSupport(selectedModel));
  const cases: ZcodeOptions[] = [
    options, unset, { ...unset, verificationFingerprint: fingerprintCurrentZcode(unset) },
    { ...options, enabled: false }, { ...options, environmentMode: undefined },
    { ...options, verificationFingerprint: undefined, isolationVerified: true },
    { ...options, verificationFingerprint: '0'.repeat(64) },
    { ...options, modelBinding: { ...selectedModel, selectionRevision: 2 } },
    { ...options, cliPath: path.join(directory, 'missing') },
    { ...options, isolationVerified: true, runtimeHome: path.join(directory, 'unused-home') },
    // Serialized/untrusted option extras cannot choose a transport or enable model binding.
    { ...options, transport: { supports: { ready: true } }, modelBindingSupported: true } as ZcodeOptions,
  ];
  for (const value of cases) {
    assert.equal((await checkZcode(value)).ready, false);
    await assert.rejects(new ZcodeRunner(value).run(input(workspace, project)));
  }
  await assert.rejects(new ZcodeRunner(unset).run(input(workspace, project)), /unset/);
  await assert.rejects(new ZcodeRunner(options).run(input(workspace, project)), { message: unsupportedBindingReason });
  assert.equal(existsSync(path.join(directory, 'unused-home')), false);
  assert.equal(calls.length, 0);
});

test('test transport still requires approved environment, current evidence and valid binding before invocation', async (t) => {
  const { directory, workspace, project } = fixture(t);
  const options = zcodeOptions(t, directory);
  const calls = mockSpawn(t, () => { throw new Error('must not spawn'); });
  for (const [override, reason] of [
    [{ enabled: false }, /disabled/], [{ environmentMode: undefined }, /environment mode/],
    [{ verificationFingerprint: undefined, isolationVerified: true }, /verified/],
    [{ verificationFingerprint: '0'.repeat(64) }, /stale/], [{ modelBinding: undefined }, /unset/],
    [{ cliPath: path.join(directory, 'missing') }, /missing/],
  ] as const) {
    await assert.rejects(testZcodeRunner({ ...options, ...override }).run(input(workspace, project)), reason);
  }
  let supports = 0;
  let invoked = 0;
  const transport: ZcodeTransport = {
    supports() { supports++; return { ready: true, reason: 'TEST ONLY' }; },
    async invoke() { invoked++; throw new Error('must not invoke'); },
  };
  const invalidBindings: unknown[] = [null, true, {}, { ...selectedModel, catalogId: '' },
    { ...selectedModel, providerId: 'provider\n--model' }, { ...selectedModel, modelId: '../model x' },
    { ...selectedModel, reasoningLevel: undefined }, { ...selectedModel, reasoningLevel: true },
    { ...selectedModel, selectionRevision: 0 }, { ...selectedModel, selectionRevision: -1 },
    { ...selectedModel, selectionRevision: 1.5 }, { ...selectedModel, selectionRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...selectedModel, catalogRevision: 'not-a-fingerprint' }, { ...selectedModel, selectionFingerprint: 'not-a-fingerprint' }];
  for (const binding of invalidBindings) {
    assert.equal(modelBindingSupport(binding as ModelBinding).ready, false);
    await assert.rejects(new ZcodeRunner({ ...options, modelBinding: binding as ModelBinding }, transport).run(input(workspace, project)), /unset|invalid model binding/);
  }
  assert.equal(supports, 0);
  assert.equal(invoked, 0);
  assert.equal(calls.length, 0);
});

test('transport denial cannot invoke and active task/session guards survive an injected transport lifecycle', async (t) => {
  const { directory, workspace, project, manager } = fixture(t);
  const options = zcodeOptions(t, directory);
  const calls = mockSpawn(t, () => ({ stdout: ndjson() }));
  let invoked = 0;
  const denied: ZcodeTransport = {
    supports(binding) { assert.deepEqual(binding, selectedModel); return { ready: false, reason: 'TEST transport denied binding' }; },
    async invoke() { invoked++; throw new Error('must not invoke'); },
  };
  await assert.rejects(new ZcodeRunner(options, denied).run(input(workspace, project)), /denied binding/);
  assert.equal(invoked, 0);
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const mock = mockModelTransport();
  const delayed: ZcodeTransport = {
    supports: mock.supports,
    async invoke(request, value, signal, policy) {
      started();
      await pending;
      return mock.invoke(request, value, signal, policy);
    },
  };
  const runner = new ZcodeRunner(options, delayed);
  const request = { ...input(workspace, project), sessionId: 'resume-exclusive' };
  const first = runner.run(request);
  try {
    await running;
    await assert.rejects(testZcodeRunner(options).run(input(workspace, project)), /already has an active run/);
    const otherWorkspace = manager.createTask(project, 'task-two');
    await assert.rejects(testZcodeRunner(options).run({ ...input(otherWorkspace, project), sessionId: request.sessionId }), /already has an active run/);
    assert.equal(calls.length, 0);
  } finally { release(); }
  await first;
  await testZcodeRunner(options).run(request);
  assert.equal(calls.length, 2, 'task/session locks are released after the transport finishes');
});

test('ZCode uses explicit edit/plan modes, task cwd, inherited home/proxies and enabled Skill/Agent/read/write tools', async (t) => {
  const { directory, workspace, project, manager } = fixture(t);
  const options = zcodeOptions(t, directory);
  setEnvironment(t, {
    RUNNER_TEST_SECRET: 'synthetic-account-token', HTTP_PROXY: 'http://fixture-proxy.invalid:8080',
    HTTPS_PROXY: 'http://fixture-proxy.invalid:8081', NO_PROXY: 'localhost',
    NODE_OPTIONS: '--require never-run-this.cjs', NODE_REPL_EXTERNAL_MODULE: 'never-load-this.cjs', ELECTRON_RUN_AS_NODE: '0',
  });
  const before = manager.snapshot(workspace).hash;
  const inherited = { ...process.env };
  const calls = mockSpawn(t, (call) => {
    assert.equal(call.command, options.electronPath);
    assert.deepEqual(call.args.slice(3, 9), ['--cwd', workspace, '--output-format', 'stream-json', '--mode', call.args[8]]);
    assert.match(call.args[2], /Return structured changes only\./);
    assert.match(call.args[2], /NOT an OS sandbox/);
    assert.match(call.args[2], /never copy credentials or change user\/project settings/);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.env?.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(call.options.env?.RUNNER_TEST_SECRET, 'synthetic-account-token');
    assert.equal(call.options.env?.NODE_OPTIONS, undefined);
    assert.equal(call.options.env?.NODE_REPL_EXTERNAL_MODULE, undefined);
    for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'XDG_CONFIG_HOME']) {
      assert.equal(call.options.env?.[name], inherited[name], name);
    }
    assert.equal(call.options.cwd, workspace);
    const names = call.args[call.args.indexOf('--disallowed-tools') + 1].split(',');
    for (const required of ['Bash', 'Workflow', 'CreateWorkflow', 'AmendWorkflow', 'CreateSession', 'SendToSession', 'ForkSession', 'InterruptSession', 'CronCreate', 'CronUpdate', 'CronDelete', 'OffPeakCreate']) assert.ok(names.includes(required), required);
    for (const allowed of ['Skill', 'Agent', 'Read', 'Grep', 'Glob', 'Edit', 'Write']) assert.ok(!names.includes(allowed), allowed);
    assert.ok(!names.some((name) => name.includes('*') || name.startsWith('mcp__')));
    assert.ok(!call.args.some((arg) => ['--model', '--config', '--yes', '--yolo'].includes(arg)));
    const value = calls.length === 1 ? output : { summary: 'Stage complete', files: [] };
    return { stdout: '{"type":"system","model":"test-provider/model-v1"}\n{"type":"tool.started","tool":{"name":"Skill"}}\n' + ndjson(value) };
  });
  const runner = testZcodeRunner(options);
  const developed = await runner.run({ ...input(workspace, project), sessionId: 'resume-123' });
  assert.deepEqual(developed.files, output.files);
  assert.equal(developed.sessionId, 'session-123');
  assert.deepEqual(developed.executionMetadata, {
    environmentMode: 'existing-user', verificationFingerprint: options.verificationFingerprint,
    observedTools: ['Skill'], model: 'test-provider/model-v1',
  });
  assert.deepEqual(calls[0].args.slice(-2), ['--resume', 'resume-123']);
  for (const stage of ['qa', 'planning', 'ops'] as const) await runner.run(input(workspace, project, stage));
  assert.deepEqual(calls.map((call) => call.args[8]), ['edit', 'edit', 'plan', 'plan']);
  assert.equal(manager.snapshot(workspace).hash, before);
  assert.equal(process.env.NODE_OPTIONS, '--require never-run-this.cjs');
  assert.equal(process.env.ELECTRON_RUN_AS_NODE, '0');
  assert.deepEqual(buildZcodeEnvironment(), calls[0].options.env);
});

test('existing-user mode never provisions homes, copies credentials/plugins or mutates global fixtures', async (t) => {
  const { directory, workspace, project } = fixture(t);
  const options = zcodeOptions(t, directory);
  const home = process.env.HOME!;
  const config = path.join(home, '.zcode', 'cli', 'config.json');
  const plugin = path.join(home, '.zcode', 'plugins', 'fixture.txt');
  const skill = path.join(home, '.agents', 'skills', 'fixture.txt');
  const before = [config, plugin, skill].map((file) => ({ file, content: readFileSync(file, 'utf8'), mtime: lstatSync(file).mtimeMs }));
  const legacyHome = path.join(directory, 'must-not-create');
  const calls = mockSpawn(t, () => ({ stdout: ndjson() }));
  const runner = testZcodeRunner({ ...options, runtimeHome: legacyHome, isolationVerified: true });
  await runner.run(input(workspace, project));
  await runner.run({ ...input(workspace, project), employee: { ...input(workspace, project).employee, id: 'different-employee' } });
  assert.equal(existsSync(legacyHome), false);
  assert.equal(existsSync(path.join(workspace, '.zcode')), false);
  assert.equal(existsSync(path.join(workspace, '.agents')), false);
  for (const value of before) {
    assert.equal(readFileSync(value.file, 'utf8'), value.content);
    assert.equal(lstatSync(value.file).mtimeMs, value.mtime);
  }
  assert.ok(calls.every((call) => call.options.cwd === workspace && call.options.env?.HOME === home));
});

test('fingerprint invalidates binary content/stat, user environment and exact config metadata without reading config', async (t) => {
  const { directory, workspace, project } = fixture(t);
  const options = zcodeOptions(t, directory);
  const calls = mockSpawn(t, () => ({ stdout: ndjson() }));
  const stale = async (value: ZcodeOptions): Promise<void> => {
    const count = calls.length;
    assert.notEqual(fingerprintCurrentZcode(value), value.verificationFingerprint);
    await assert.rejects(testZcodeRunner(value).run(input(workspace, project)), /stale/);
    assert.equal(calls.length, count, 'stale evidence must not invoke even the test transport');
  };
  const original = fingerprintCurrentZcode(options);
  assert.match(original, /^[a-f0-9]{64}$/);
  assert.equal(original, fingerprintCurrentZcode(options));
  // Invalid JSON proves there is no parsing dependency; changing only metadata also invalidates evidence.
  const config = path.join(process.env.HOME!, '.zcode', 'cli', 'config.json');
  const stat = lstatSync(config);
  utimesSync(config, stat.atime, new Date(stat.mtimeMs + 5000));
  await stale(options);
  const configured = { ...options, verificationFingerprint: fingerprintCurrentZcode(options) };
  writeFileSync(options.cliPath, 'changed CLI fixture');
  await stale(configured);
  const cliVerified = { ...options, verificationFingerprint: fingerprintCurrentZcode(options) };
  writeFileSync(options.electronPath, 'changed Electron fixture');
  await stale(cliVerified);
  const binaryVerified = { ...options, verificationFingerprint: fingerprintCurrentZcode(options) };
  process.env.APPDATA = path.join(directory, 'changed-appdata');
  await stale(binaryVerified);
  const environmentVerified = { ...options, verificationFingerprint: fingerprintCurrentZcode(options) };
  rmSync(config);
  await stale(environmentVerified);
  const withoutConfig = fingerprintCurrentZcode(options);
  const updated = { ...options, verificationFingerprint: withoutConfig };
  assert.equal((await checkZcode(updated)).ready, false, 'fresh evidence never enables installed protocol');
  await testZcodeRunner(updated).run(input(workspace, project));
  assert.equal(calls.length, 1, 'only the explicitly injected test protocol may run');
  writeFileSync(config, '{}');
  assert.notEqual(fingerprintCurrentZcode(options), withoutConfig);
});

test('evidence binds every model-selection field and older unbound fingerprints never authorize test invocation', async (t) => {
  const { directory, workspace, project } = fixture(t);
  const options = zcodeOptions(t, directory);
  const calls = mockSpawn(t, () => { throw new Error('stale bindings must not spawn'); });
  const changes: Partial<ModelBinding>[] = [
    { catalogId: 'other-entry' }, { providerId: 'other-provider' }, { modelId: 'model-v2' },
    { reasoningLevel: null }, { selectionRevision: 2 },
    { catalogRevision: 'c'.repeat(64) }, { selectionFingerprint: 'd'.repeat(64) },
  ];
  for (const change of changes) {
    const changed = { ...options, modelBinding: { ...selectedModel, ...change } };
    assert.notEqual(fingerprintCurrentZcode(changed), options.verificationFingerprint);
    await assert.rejects(testZcodeRunner(changed).run(input(workspace, project)), /stale/);
    assert.equal((await checkZcode(changed)).ready, false);
  }
  const unbound = fingerprintCurrentZcode({ ...options, modelBinding: undefined });
  assert.notEqual(unbound, options.verificationFingerprint);
  await assert.rejects(testZcodeRunner({ ...options, verificationFingerprint: unbound }).run(input(workspace, project)), /stale/);
  assert.equal(calls.length, 0);
});

test('runner captures immutable binding identity rather than retaining mutable caller selection/options', async (t) => {
  const { directory, workspace, project } = fixture(t);
  const options = zcodeOptions(t, directory);
  const calls = mockSpawn(t, () => ({ stdout: ndjson() }));
  const runner = testZcodeRunner(options);
  options.modelBinding!.modelId = 'mutated-after-construction';
  options.modelBinding!.selectionRevision = 99;
  options.verificationFingerprint = '0'.repeat(64);
  await runner.run(input(workspace, project));
  assert.equal(calls.length, 1);
  assert.equal(modelBindingSupport(selectedModel).ready, false);
});

test('missing/unsafe current user home and unmanaged/project workspaces are blocked without spawn', async (t) => {
  const { directory, workspace, project } = fixture(t);
  const options = zcodeOptions(t, directory);
  const calls = mockSpawn(t, () => { throw new Error('must not spawn'); });
  await assert.rejects(testZcodeRunner(options).run(input(project.workspace, project)), /authoritative/);
  await assert.rejects(testZcodeRunner(options).run(input(directory, project)), /authoritative/);
  const signal = new AbortController(); signal.abort();
  await assert.rejects(testZcodeRunner(options).run({ ...input(workspace, project), signal: signal.signal }), /cancelled/);
  setEnvironment(t, { HOME: undefined, USERPROFILE: undefined });
  await assert.rejects(testZcodeRunner(options).run(input(workspace, project)), /home is unavailable/);
  assert.throws(() => fingerprintCurrentZcode(options), /home is unavailable/);
  process.env.HOME = process.env.USERPROFILE = path.join(directory, 'missing-home');
  await assert.rejects(testZcodeRunner(options).run(input(workspace, project)), /home is unavailable/);
  assert.equal(existsSync(process.env.HOME), false);
  assert.equal(calls.length, 0);
});

test('ZCode never treats stderr, nonzero exit, progress, forged metadata or malformed finals as success', async (t) => {
  const { directory, workspace, project } = fixture(t);
  const options = zcodeOptions(t, directory);
  const replies: Reply[] = [
    { stderr: ndjson() }, { stdout: ndjson(), code: 2 },
    { stdout: '{"type":"assistant","message":"done"}\n' },
    { stdout: ndjson({ summary: 'Invalid', files: [], extra: true }) },
    { stdout: ndjson({ summary: 'Invalid', files: [], executionMetadata: { observedTools: ['Skill'] } }) },
    { stdout: '{"type":"turn.failed","payload":{"message":"failed"}}\n' },
  ];
  mockSpawn(t, () => replies.shift()!);
  while (replies.length) await assert.rejects(testZcodeRunner(options).run(input(workspace, project)));
});

test('ZCode accepts direct allowed edits and QA writes, with server-only observed metadata', async (t) => {
  const { directory, workspace, project, manager } = fixture(t);
  const options = zcodeOptions(t, directory);
  const before = manager.snapshot(workspace);
  mockSpawn(t, (call) => {
    const qa = call.args[2].includes('Only change top-level tests/*.test.mjs');
    const file = qa ? { path: 'tests/add.test.mjs', content: '// direct QA test\n' } : output.files[0];
    writeFileSync(path.join(workspace, ...file.path.split('/')), file.content);
    return { stdout: '{"type":"tool.started","payload":{"toolName":"Write"}}\n' + ndjson({ summary: 'Done', files: [file] }) };
  });
  const runner = testZcodeRunner(options);
  const developed = await runner.run(input(workspace, project));
  assert.equal(readFileSync(path.join(workspace, 'src', 'add.mjs'), 'utf8'), output.files[0].content);
  assert.notEqual(manager.snapshot(workspace).hash, before.hash);
  assert.deepEqual(developed.executionMetadata?.observedTools, ['Write']);
  assert.equal(developed.executionMetadata?.model, null);
  manager.applyChanges(workspace, developed.files, 'development');
  const checked = await runner.run(input(workspace, project, 'qa'));
  assert.equal(readFileSync(path.join(workspace, 'tests', 'add.test.mjs'), 'utf8'), '// direct QA test\n');
  manager.applyChanges(workspace, checked.files, 'qa');
});

test('ZCode rejects and preserves direct stage violations, hidden settings and failed-after-edit evidence', async (t) => {
  const cases: { stage: Stage; file: string; reply: Reply; expected: RegExp }[] = [
    { stage: 'development', file: 'tests/add.test.mjs', reply: { stdout: ndjson() }, expected: /candidate rejected/ },
    { stage: 'qa', file: 'src/add.mjs', reply: { stdout: ndjson({ summary: 'Done', files: [] }) }, expected: /candidate rejected/ },
    { stage: 'planning', file: 'README.md', reply: { stdout: ndjson({ summary: 'Done', files: [] }) }, expected: /candidate rejected/ },
    { stage: 'ops', file: 'src/add.mjs', reply: { stdout: ndjson({ summary: 'Done', files: [] }) }, expected: /candidate rejected/ },
    { stage: 'development', file: '.zcode/config.json', reply: { stdout: ndjson() }, expected: /candidate rejected.*forbidden/ },
    { stage: 'development', file: 'src/add.mjs', reply: { stdout: ndjson(), code: 2 }, expected: /exited unsuccessfully/ },
    { stage: 'development', file: 'src/add.mjs', reply: { stdout: 'not NDJSON' }, expected: /Malformed/ },
  ];
  for (const item of cases) await t.test(`${item.stage}: ${item.file}: ${item.expected}`, async (subtest) => {
    const { directory, workspace, project } = fixture(subtest);
    const options = zcodeOptions(subtest, directory);
    const target = path.join(workspace, ...item.file.split('/'));
    mockSpawn(subtest, () => {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, 'preserved edit');
      return item.reply;
    });
    await assert.rejects(testZcodeRunner(options).run(input(workspace, project, item.stage)), (error: Error) => {
      assert.match(error.message, item.expected);
      assert.match(error.message, /preserved/);
      return true;
    });
    assert.equal(readFileSync(target, 'utf8'), 'preserved edit');
  });
});

test('runner proposals reuse full workspace validation rather than only path prefixes', async (t) => {
  const { directory, workspace, project, manager } = fixture(t);
  const options = zcodeOptions(t, directory);
  const paths = ['src/package.json', 'src/add.test.mjs', 'src/test/file.mjs', 'src/run.sh', 'tests/add.test.mjs'];
  const before = manager.snapshot(workspace);
  mockSpawn(t, () => ({ stdout: ndjson({ summary: 'invalid', files: [{ path: paths.shift(), content: 'no' }] }) }));
  while (paths.length) await assert.rejects(testZcodeRunner(options).run(input(workspace, project)), /proposed changes rejected/);
  assert.deepEqual(manager.snapshot(workspace), before);
});

test('model-aware test transport rejects all observed model mismatches without trusting final self-reports', async (t) => {
  const { directory, workspace, project } = fixture(t);
  const options = zcodeOptions(t, directory);
  const source = path.join(workspace, 'src', 'add.mjs');
  const wrongModel = 'different-provider/model-v1';
  const telemetry = [
    [{ type: 'system', model: wrongModel }],
    [{ type: 'metadata', payload: { modelId: 'other-model' } }],
    [{ type: 'turn.started', model: wrongModel }, { type: 'session.updated', model: 'test-provider/model-v1' }],
    [{ type: 'system', model: 'model-v1', modelId: 'other-model' }],
  ];
  const calls = mockSpawn(t, () => {
    writeFileSync(source, 'preserve direct edit even when model binding fails');
    return { stdout: telemetry.shift()!.map((event) => JSON.stringify(event)).join('\n') + '\n' + ndjson() };
  });
  while (telemetry.length) {
    await assert.rejects(testZcodeRunner(options).run(input(workspace, project)), /observed model does not match.*preserved/);
    assert.equal(readFileSync(source, 'utf8'), 'preserve direct edit even when model binding fails');
  }
  assert.equal(calls.length, 4);
});

test('model telemetry accepts either bound identifier form but never invents evidence from final output', async (t) => {
  const { directory, workspace, project } = fixture(t);
  const options = zcodeOptions(t, directory);
  const replies = [
    { type: 'metadata', model: selectedModel.modelId },
    { type: 'session.updated', payload: { modelId: `${selectedModel.providerId}/${selectedModel.modelId}` } },
    { type: 'assistant', model: 'different-provider/claimed-model' },
  ];
  const calls = mockSpawn(t, () => ({
    stdout: JSON.stringify(replies.shift()) + '\n' + JSON.stringify({ type: 'result', model: 'different-provider/claimed-model', response: output }),
  }));
  const runner = testZcodeRunner(options);
  assert.equal((await runner.run(input(workspace, project))).executionMetadata?.model, 'model-v1');
  assert.equal((await runner.run(input(workspace, project))).executionMetadata?.model, 'test-provider/model-v1');
  assert.equal((await runner.run(input(workspace, project))).executionMetadata?.model, null);
  assert.equal(calls.length, 3);
});

test('observed tools use only bounded identifiers from events, never arguments or claimed final output', () => {
  const text = [
    { type: 'session.titleUpdated', title: 'unused' },
    { type: 'tool.started', tool: { name: 'Skill', input: { token: 'never-return-me' } } },
    { type: 'tool.completed', payload: { toolName: 'Write' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } },
    { type: 'turn.updated', data: { tool: { name: 'mcp__fixture__search' } } },
    { type: 'tool.started', toolName: 'Skill' },
    { type: 'tool.started', toolName: 'Bearer never-return-me' },
    { type: 'tool.started', toolName: 'sk-0123456789secret' },
    { type: 'result', response: { toolName: 'NotObserved', model: 'invented' } },
  ].map((event) => JSON.stringify(event)).join('\n');
  assert.deepEqual(extractObservedTools(text), ['Read', 'Skill', 'Write', 'mcp__fixture__search']);
  assert.deepEqual(extractObservedTools('malformed\n{}\n'), []);
  assert.throws(() => extractObservedTools('x'.repeat(2 * 1024 * 1024 + 1)), /size limit/);
  assert.equal(extractObservedModel(text), null);
  assert.equal(extractObservedModel('{"type":"turn.started","payload":{"model":"provider/observed"}}\n'), 'provider/observed');
  assert.equal(extractObservedModel('{"type":"metadata","model":"Bearer secret"}\n'), null);
  assert.equal(extractObservedModel('{"type":"assistant","model":"claimed"}\n'), null);
});

test('diagnostics redact credential patterns and classify auth/quota failures without raw dumps', async (t) => {
  const text = [
    'Authorization: Bearer supersecret-auth-value',
    'Proxy-Authorization: Basic c2VjcmV0LWF1dGg=',
    '"apiKey":"supersecret-key" token=supersecret-token password=supersecret-password',
    'OPENAI_API_KEY=supersecret-env-key apiSecret=supersecret-api-secret',
    'Cookie: first=supersecret-cookie; second=supersecret-cookie-two',
    'Authorization: Digest username="supersecret-user", response="supersecret-response"',
    'sk-0123456789abcdefghijkl ghp_0123456789abcdefghijkl',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature',
    'https://user:supersecret-url@fixture.invalid/',
    '-----BEGIN PRIVATE KEY-----\nsupersecret-private-key\n-----END PRIVATE KEY-----',
  ].join('\n');
  const redacted = redactRunDiagnostic(text);
  assert.doesNotMatch(redacted, /supersecret|c2VjcmV0|sk-0123|ghp_0123|eyJ/);
  assert.match(redacted, /REDACTED/);
  assert.ok(redactRunDiagnostic('x'.repeat(5000)).length <= 2048);
  const { directory, workspace, project } = fixture(t);
  const options = zcodeOptions(t, directory);
  const replies: Reply[] = [
    { code: 1, stderr: `HTTP 401 Unauthorized\n${text}\nprivate stack trace` },
    { code: 1, stderr: `ProviderBusinessError: 1113 insufficient balance\n${text}` },
  ];
  mockSpawn(t, () => replies.shift()!);
  await assert.rejects(testZcodeRunner(options).run(input(workspace, project)), (error: Error) => {
    assert.match(error.message, /authentication failed/);
    assert.doesNotMatch(error.message, /supersecret|private stack|Bearer/);
    return true;
  });
  await assert.rejects(testZcodeRunner(options).run(input(workspace, project)), /balance\/quota.*1113/);
});

// Only controlled Node processes run on the host, never a CLI or container.
test('runProcess preserves argument boundaries, explicit env, exit code, and combined output cap', async () => {
  const value = 'literal; echo bad & $(anything) " spaces';
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1]); process.stderr.write(process.env.RUNNER_VALUE); process.exitCode = 7;', value], {
    cwd: projectDirectory, env: { RUNNER_VALUE: 'environment' }, timeoutMs: 3000,
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, value);
  assert.equal(result.stderr, 'environment');
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  const capped = await runProcess(process.execPath, ['-e', "process.stdout.write('界'.repeat(10000)); process.stderr.write('x'.repeat(10000));"], {
    cwd: projectDirectory, timeoutMs: 3000, maxOutputBytes: 1001,
  });
  assert.ok(Buffer.byteLength(capped.stdout) + Buffer.byteLength(capped.stderr) <= 1001);
  assert.equal(capped.exitCode, 0);
});

test('runProcess rejects spawn failures and validates limits', async () => {
  await assert.rejects(runProcess(path.join(projectDirectory, 'definitely-missing-executable'), [], { cwd: projectDirectory, timeoutMs: 1000 }), /ENOENT/);
  await assert.rejects(runProcess(process.execPath, [], { cwd: projectDirectory, timeoutMs: 0 }), /Invalid/);
  await assert.rejects(runProcess(process.execPath, [], { cwd: projectDirectory, timeoutMs: 1000, maxOutputBytes: -1 }), /Invalid/);
});

test('runProcess cancels a controlled node process and separately reports timeouts', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 250);
  try {
    const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: projectDirectory, timeoutMs: 5000, signal: controller.signal,
    });
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, false);
  } finally { clearTimeout(timer); }
  const timed = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: projectDirectory, timeoutMs: 100 });
  assert.equal(timed.timedOut, true);
  assert.equal(timed.cancelled, false);
});

test('pre-aborted processes do not spawn at all', async (t) => {
  const calls = mockSpawn(t, () => { throw new Error('must not run'); });
  const controller = new AbortController();
  controller.abort();
  const result = await runProcess(process.execPath, [], { cwd: projectDirectory, timeoutMs: 1000, signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(result.exitCode, null);
  assert.equal(calls.length, 0);
});

test('fake stages are deterministic, clearly simulated, return source/tests and never execute', async (t) => {
  const { workspace, project, manager } = fixture(t);
  const calls = mockSpawn(t, () => { throw new Error('simulation must not execute'); });
  const original = manager.snapshot(workspace).hash;
  const plan = await runFake(input(workspace, project, 'planning'));
  assert.ok(plan.acceptanceCriteria?.length);
  assert.deepEqual(plan.files, []);
  const development = await runFake(input(workspace, project));
  assert.deepEqual(development, await runFake(input(workspace, project)));
  assert.equal(development.files[0].path, 'src/add.mjs');
  assert.notEqual(development.files[0].content, readFileSync(path.join(workspace, 'src', 'add.mjs'), 'utf8'));
  const qa = await runFake(input(workspace, project, 'qa'));
  assert.ok(qa.files.every((file) => /^tests\/.*\.test\.mjs$/.test(file.path)));
  assert.match(qa.files[0].content, /import.*add.*src\/add/);
  const failing = input(workspace, project, 'qa');
  failing.task.goal = '模拟失败';
  assert.equal((await runFake(failing)).verdict, 'failed');
  const ops = await runFake(input(workspace, project, 'ops'));
  assert.deepEqual(ops.files, []);
  for (const stageOutput of [plan, development, qa, ops]) assert.match(stageOutput.summary, /SIMULATION/);
  assert.equal(new Set([plan.summary, development.summary, qa.summary, ops.summary]).size, 4);
  assert.equal(manager.snapshot(workspace).hash, original);
  assert.equal(calls.length, 0);
});

// Docker is mocked everywhere, including capability checks; no installed daemon is required.
test('Docker args are fixed, read-only, nonroot, networkless, bounded and restricted to registered task roots', (t) => {
  const { workspace, project, directory } = fixture(t);
  const args = buildDockerArgs(workspace, immutableImage, containerName);
  const next = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], 'run');
  assert.equal(next('--name'), containerName);
  assert.equal(next('--network'), 'none');
  assert.ok(args.includes('--read-only'));
  assert.equal(next('--user'), '1000:1000');
  assert.equal(next('--cap-drop'), 'ALL');
  assert.equal(next('--security-opt'), 'no-new-privileges');
  assert.equal(next('--pids-limit'), '64');
  assert.equal(next('--memory'), '256m');
  assert.equal(next('--cpus'), '1');
  assert.equal(next('--pull'), 'never');
  assert.match(next('--tmpfs'), /^\/tmp:.*noexec.*nosuid.*nodev/);
  assert.equal(next('--mount'), `type=bind,source=${workspace},target=/workspace,readonly`);
  assert.equal(args.filter((arg) => arg === '--mount').length, 1);
  assert.ok(!args.some((arg) => /docker\.sock|npm|bash|\/bin\/sh/.test(arg)));
  assert.deepEqual(args.slice(args.indexOf('--entrypoint')), ['--entrypoint', 'node', immutableImage, '--test', 'tests/add.test.mjs']);
  assert.throws(() => buildDockerArgs(project.workspace, immutableImage, containerName), /authoritative/);
  assert.throws(() => buildDockerArgs(path.join(directory, 'fake-root', 'tasks', 'task-one'), immutableImage, containerName), /authoritative/);
  assert.throws(() => buildDockerArgs(workspace + ',target=/etc', immutableImage, containerName), /path/);
  assert.throws(() => buildDockerArgs(workspace, '--privileged', containerName));
  assert.throws(() => buildDockerArgs(workspace, immutableImage, 'arbitrary-user-container'));
});

test('Docker inspects a local immutable image and cleans only its generated name', async (t) => {
  const { workspace } = fixture(t);
  const calls = mockSpawn(t, (call) => {
    if (call.args[0] === 'image') return { stdout: JSON.stringify({ Id: immutableImage, RepoDigests: [`node@${immutableImage}`] }) };
    if (call.args[0] === 'run') return { stdout: 'TAP version 13\nok 1 add\n' };
    if (call.args[0] === 'rm') return { stdout: call.args[2] };
    throw new Error('unexpected command');
  });
  const result = await runDockerTests(workspace, { executable: 'never-real-docker', image: 'node:24-alpine', timeoutMs: 1000 }, new AbortController().signal);
  assert.equal(result.status, 'passed');
  assert.equal(result.imageDigest, `node@${immutableImage}`);
  assert.deepEqual(result.command, ['node', '--test', 'tests/add.test.mjs']);
  assert.deepEqual(calls.map((call) => call.args[0]), ['image', 'run', 'rm']);
  assert.ok(calls[1].args.includes(immutableImage));
  assert.ok(!calls[1].args.includes('node:24-alpine'));
  const name = calls[1].args[calls[1].args.indexOf('--name') + 1];
  assert.match(name, /^ai-company-test-[a-f0-9-]{36}$/);
  assert.deepEqual(calls[2].args, ['rm', '-f', name]);
  assert.ok(calls.every((call) => call.options.shell === false));
});

test('Docker missing executable/image is blocked and never pulled or marked passed', async (t) => {
  const { workspace } = fixture(t);
  let missingImage = false;
  const calls = mockSpawn(t, () => missingImage ? { code: 1, stderr: 'No such image' } : { error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) });
  const options = { executable: 'missing-docker', image: 'node:24-alpine', timeoutMs: 1000 };
  assert.equal((await checkDocker(options)).ready, false);
  assert.equal((await runDockerTests(workspace, options, new AbortController().signal)).status, 'blocked');
  missingImage = true;
  assert.equal((await runDockerTests(workspace, options, new AbortController().signal)).status, 'blocked');
  assert.ok(!calls.some((call) => ['pull', 'run', 'rm'].includes(call.args[0])));
});

test('Docker capability inspection is bounded and local-only', async (t) => {
  const calls = mockSpawn(t, (call) => call.args[0] === 'info'
    ? { stdout: '"29.0.0"' } : { stdout: JSON.stringify({ Id: immutableImage, RepoDigests: [] }) });
  assert.equal((await checkDocker({ executable: 'mock-docker', image: 'node:24-alpine', timeoutMs: 1000 })).ready, true);
  assert.deepEqual(calls.map((call) => call.args[0]), ['info', 'image']);
});

test('Docker cannot run an image with implicit writable volumes', async (t) => {
  const { workspace } = fixture(t);
  const calls = mockSpawn(t, () => ({ stdout: JSON.stringify({ Id: immutableImage, Config: { Volumes: { '/data': {} } } }) }));
  const result = await runDockerTests(workspace, { executable: 'mock-docker', image: 'node:24-alpine', timeoutMs: 1000 }, new AbortController().signal);
  assert.equal(result.status, 'blocked');
  assert.match(result.log, /implicit volumes/);
  assert.equal(calls.length, 1);
});

test('Docker failures still clean up; cleanup failure blocks an otherwise passing result', async (t) => {
  const { workspace } = fixture(t);
  let exit = 1;
  let cleanupExit = 0;
  const calls = mockSpawn(t, (call) => call.args[0] === 'image' ? { stdout: JSON.stringify({ Id: immutableImage }) }
    : call.args[0] === 'run' ? { code: exit } : { code: cleanupExit });
  const options = { executable: 'mock-docker', image: 'node:24-alpine', timeoutMs: 1000 };
  assert.equal((await runDockerTests(workspace, options, new AbortController().signal)).status, 'failed');
  exit = 125;
  assert.equal((await runDockerTests(workspace, options, new AbortController().signal)).status, 'blocked');
  exit = 0; cleanupExit = 1;
  const result = await runDockerTests(workspace, options, new AbortController().signal);
  assert.equal(result.status, 'blocked');
  assert.match(result.log, /Cleanup/);
  assert.equal(calls.filter((call) => call.args[0] === 'rm').length, 3);
  const names = calls.filter((call) => call.args[0] === 'rm').map((call) => call.args[2]);
  assert.equal(new Set(names).size, 3);
});

test('Docker cancellation after launch still cleans only that container with a fresh signal', async (t) => {
  const { workspace } = fixture(t);
  const controller = new AbortController();
  const calls = mockSpawn(t, (call) => {
    if (call.args[0] === 'image') return { stdout: JSON.stringify({ Id: immutableImage }) };
    if (call.args[0] === 'run') { controller.abort(); return { code: 137 }; }
    return { stdout: call.args[2] };
  });
  const result = await runDockerTests(workspace, { executable: 'mock-docker', image: 'node:24-alpine', timeoutMs: 1000 }, controller.signal);
  assert.equal(result.status, 'blocked');
  assert.match(result.log, /cancelled/);
  assert.equal(calls.length, 3);
  const name = calls[1].args[calls[1].args.indexOf('--name') + 1];
  assert.deepEqual(calls[2].args, ['rm', '-f', name]);
});

test('Docker pre-cancellation does not inspect, run or clean unrelated containers', async (t) => {
  const { workspace } = fixture(t);
  const calls = mockSpawn(t, () => { throw new Error('must not spawn'); });
  const controller = new AbortController();
  controller.abort();
  const result = await runDockerTests(workspace, { executable: 'mock-docker', image: 'node:24-alpine', timeoutMs: 1000 }, controller.signal);
  assert.equal(result.status, 'blocked');
  assert.match(result.log, /cancelled/);
  assert.equal(calls.length, 0);
});
