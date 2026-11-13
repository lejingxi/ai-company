import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { PassThrough, Writable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { RpcFault, ZcodeRpcClient, type ZcodeRpcOptions } from '../src/server/runners/zcode-rpc.js';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const line = (value: unknown): string => JSON.stringify(value) + '\n';
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
type Message = Record<string, unknown>;
type SpawnCall = { command: string; args: string[]; options: childProcess.SpawnOptions };

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly writes: string[] = [];
  readonly kills: (NodeJS.Signals | number | undefined)[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  closed = false;
  unreferenced = false;
  onKill?: () => void;
  heldWrite?: () => void;

  constructor(readonly pid: number, blockInput = false) {
    super();
    this.stdin = new Writable({ write: (chunk: Buffer, _encoding, callback) => {
      this.writes.push(chunk.toString('utf8'));
      if (blockInput) this.heldWrite = () => callback(); else callback();
    } });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal);
    this.onKill?.();
    return true;
  }

  unref(): void { this.unreferenced = true; }

  close(code = 0): void {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.stdin.destroy();
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }

  send(value: unknown): void { this.stdout.write(line(value)); }
  messages(): Message[] { return this.writes.join('').trim().split('\n').filter(Boolean).map((value) => JSON.parse(value) as Message); }
}

function mockChild(t: TestContext, settings: {
  autoClose?: boolean; blockInput?: boolean; onSpawn?: () => void; spawnError?: boolean;
} = {}) {
  const root = new FakeChild(512345, settings.blockInput);
  const helpers: FakeChild[] = [];
  const calls: SpawnCall[] = [];
  const clients: ZcodeRpcClient[] = [];
  const groupKills: { pid: number; signal: NodeJS.Signals | number | undefined }[] = [];
  const autoClose = settings.autoClose ?? true;
  root.onKill = () => { if (autoClose) queueMicrotask(() => root.close()); };
  const originalSpawn = childProcess.spawn;
  const originalKill = process.kill;
  childProcess.spawn = ((command: string, args: string[], options: childProcess.SpawnOptions) => {
    calls.push({ command, args, options });
    if (command.endsWith('taskkill.exe')) {
      const helper = new FakeChild(612345 + helpers.length);
      helpers.push(helper);
      if (autoClose) queueMicrotask(() => { root.close(); helper.close(); });
      return helper;
    }
    settings.onSpawn?.();
    if (settings.spawnError) throw new Error('synthetic-secret spawn path and credentials');
    return root;
  }) as unknown as typeof childProcess.spawn;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    groupKills.push({ pid, signal });
    if (autoClose) queueMicrotask(() => root.close());
    return true;
  }) as typeof process.kill;
  syncBuiltinESMExports();
  t.after(async () => {
    try {
      await Promise.all(clients.map((client) => client.dispose()));
      root.heldWrite?.();
      root.close();
      for (const helper of helpers) helper.close();
    } finally {
      childProcess.spawn = originalSpawn;
      process.kill = originalKill;
      syncBuiltinESMExports();
    }
  });
  const client = (overrides: Partial<ZcodeRpcOptions> = {}): ZcodeRpcClient => {
    const value = new ZcodeRpcClient({
      command: 'test-only-never-zcode', args: ['literal; not-a-shell', 'space value'], cwd,
      env: { RPC_FIXTURE: 'yes' }, timeoutMs: 5000,
      onRequest: () => { throw new RpcFault(-32601, 'Method not found'); }, onEvent: () => {}, ...overrides,
    });
    clients.push(value);
    return value;
  };
  return { root, calls, helpers, groupKills, client };
}

async function rejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error: Error) => {
    assert.match(error.message, pattern);
    assert.doesNotMatch(error.message, /synthetic-secret|Bearer|private-payload/);
    return true;
  });
}

test('native transport spawns pipes without shell, handshake, or JSON-RPC framing', async (t) => {
  const h = mockChild(t);
  const client = h.client();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0], {
    command: 'test-only-never-zcode', args: ['literal; not-a-shell', 'space value'],
    options: { cwd, env: { RPC_FIXTURE: 'yes' }, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] },
  });
  assert.deepEqual(h.root.messages(), []);
  const pending = client.request<{ ok: boolean }>('runtime/capabilities', { trace: 'literal' });
  const request = h.root.messages()[0];
  assert.deepEqual(request, { id: 'client-1', method: 'runtime/capabilities', params: { trace: 'literal' } });
  h.root.send({ id: request.id, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
  client.assertAlive();
  await client.dispose();
  if (process.platform === 'win32') {
    assert.match(h.calls[1].command, /\\System32\\taskkill\.exe$/);
    assert.deepEqual(h.calls[1].args, ['/PID', String(h.root.pid), '/T', '/F']);
    assert.deepEqual(h.calls[1].options, { shell: false, windowsHide: true, stdio: 'ignore' });
  } else assert.ok(h.groupKills.every((call) => call.pid === -h.root.pid));
  assert.ok(h.calls.every((call) => !call.args.includes('/IM')));
});

test('partial NDJSON and every UTF-8 byte boundary preserve text, CRLF, trace and notifications', async (t) => {
  const h = mockChild(t);
  const events: unknown[] = [];
  const client = h.client({ onEvent: (method, params) => { events.push([method, params]); } });
  const pending = client.request('echo', undefined);
  assert.deepEqual(h.root.messages()[0], { id: 'client-1', method: 'echo' });
  const bytes = Buffer.from(line({ method: 'ready', params: { text: '界😀é' }, trace: { any: true } })
    + JSON.stringify({ id: 'client-1', result: '界😀é' }) + '\r\n');
  for (const byte of bytes) h.root.stdout.write(Buffer.from([byte]));
  assert.equal(await pending, '界😀é');
  assert.deepEqual(events, [['ready', { text: '界😀é' }]]);
});

test('responses may arrive out of order and peer string and integer IDs stay distinct', async (t) => {
  const h = mockChild(t);
  const client = h.client({ onRequest: (_method, params) => params });
  const first = client.request('first', null);
  const second = client.request('second', {});
  h.root.send({ id: 'client-2', result: 2 });
  h.root.send({ id: 'client-1', result: 1 });
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  h.root.send({ id: 7, method: 'callback', params: 'number' });
  h.root.send({ id: '7', method: 'callback', params: 'string' });
  h.root.send({ id: 'server-1', method: 'callback', params: false, trace: 'opaque' });
  await flush();
  assert.deepEqual(h.root.messages().slice(2), [{ id: 7, result: 'number' }, { id: '7', result: 'string' }, { id: 'server-1', result: false }]);
});

test('bidirectional callbacks send results, explicit safe faults and generic untrusted exceptions', async (t) => {
  const h = mockChild(t);
  const client = h.client({ onRequest: async (method, params) => {
    if (method === 'ok') return { answer: params };
    if (method === 'empty') return undefined;
    if (method === 'unsafe') throw new Error('Bearer synthetic-secret private-payload');
    throw new RpcFault(-32601, 'Method not found');
  } });
  for (const [id, method] of ['ok', 'empty', 'unsafe', 'unknown'].entries()) h.root.send({ id, method, params: 'text' });
  await flush();
  assert.deepEqual(h.root.messages(), [
    { id: 0, result: { answer: 'text' } }, { id: 1, result: null },
    { id: 2, error: { code: -32603, message: 'Request handler failed' } },
    { id: 3, error: { code: -32601, message: 'Method not found' } },
  ]);
  client.assertAlive();
});

test('remote faults preserve code but never echo message, data, or stderr', async (t) => {
  const h = mockChild(t);
  const client = h.client();
  const pending = client.request('denied', {});
  h.root.stderr.write('Bearer synthetic-secret private-payload\n');
  h.root.send({ id: 'client-1', error: { code: -32000, message: 'synthetic-secret', data: { token: 'private-payload' } } });
  await assert.rejects(pending, (error: RpcFault) => {
    assert.ok(error instanceof RpcFault);
    assert.equal(error.code, -32000);
    assert.equal(error.message, 'ZCode RPC request rejected');
    assert.equal('data' in error, false);
    return true;
  });
  client.assertAlive();
  const next = client.request('next', null);
  h.root.send({ id: 'client-2', result: null });
  assert.equal(await next, null);
});

test('malformed, ambiguous, legacy, and unexpected envelopes fail closed', async (t) => {
  const invalid = [
    'not-json private-payload\n', '\n', '[]\n', 'null\n', '{}\n', 'Content-Length: 7\r\n',
    { jsonrpc: '2.0', id: 'client-1', result: true }, { id: 'client-1' },
    { id: 'client-1', result: true, error: { code: 1, message: 'no' } },
    { id: 'client-1', result: true, trace: {} }, { id: 'client-1', result: true, extra: true },
    { id: null, result: true }, { id: {}, result: true }, { id: 1.1, result: true },
    { id: Number.MAX_SAFE_INTEGER + 1, result: true }, { id: 'not-pending', result: true },
    { id: 'client-1', error: null }, { id: 'client-1', error: { code: '1', message: 'private-payload' } },
    { id: 'client-1', error: { code: null, message: 'private-payload' } },
    { id: 'client-1', error: { code: 1, message: 1 } },
    { id: 'client-1', error: { code: 1, message: 'error', unexpected: true } },
    { method: '' }, { method: 'bad\nmethod' }, { method: 42 }, { method: 'event', result: {} },
    { id: null, method: 'callback' }, { method: 'event', jsonrpc: '2.0' },
  ];
  for (const [index, value] of invalid.entries()) await t.test(`invalid envelope ${index + 1}`, async (subtest) => {
    const h = mockChild(subtest);
    const client = h.client();
    const pending = client.request('waiting', {});
    const rejected = rejection(pending, /malformed|invalid|unknown|duplicate/);
    h.root.stdout.write(typeof value === 'string' ? value : line(value));
    await rejected;
    assert.ok(await client.failure instanceof Error);
    assert.throws(() => client.assertAlive());
  });
});

test('duplicate replies in one batch cannot produce a late success', async (t) => {
  const h = mockChild(t);
  const client = h.client();
  const pending = client.request('one', {});
  const rejected = rejection(pending, /duplicate/);
  const response = line({ id: 'client-1', result: 'not success' });
  h.root.stdout.write(response + response);
  await rejected;
  await rejection(client.request('after-failure', {}), /duplicate/);
});

test('duplicate peer IDs fail closed both during and after callback completion', async (t) => {
  for (const delayed of [false, true]) await t.test(String(delayed), async (subtest) => {
    const h = mockChild(subtest);
    let calls = 0;
    const client = h.client({ onRequest: () => { calls++; return delayed ? new Promise(() => {}) : true; } });
    h.root.send({ id: 'server-1', method: 'callback' });
    await flush();
    h.root.send({ id: 'server-1', method: 'callback' });
    assert.match((await client.failure).message, /duplicate peer/);
    assert.equal(calls, 1);
  });
});

test('combined raw stdout and stderr bytes are capped, without treating stderr as RPC', async (t) => {
  const h = mockChild(t);
  const client = h.client({ maxOutputBytes: 80 });
  const pending = client.request('waiting', {});
  const rejected = rejection(pending, /output limit/);
  h.root.stderr.write(line({ id: 'client-1', result: 'not a response' }));
  client.assertAlive();
  h.root.stdout.write(Buffer.alloc(40, 32));
  await rejected;
  assert.match((await client.failure).message, /combined output/);
});

test('output line limit is enforced across chunks before JSON parsing', async (t) => {
  const h = mockChild(t);
  const client = h.client();
  h.root.stdout.write(Buffer.alloc(512 * 1024, 32));
  h.root.stdout.write(Buffer.alloc(512 * 1024, 32));
  client.assertAlive();
  h.root.stdout.write(' ');
  assert.match((await client.failure).message, /line limit/);
});

test('a valid 1 MiB snapshot line is accepted while the default 2 MiB total is strict', async (t) => {
  const h = mockChild(t);
  const client = h.client();
  const payload = 'x'.repeat(1024 * 1024 - Buffer.byteLength(JSON.stringify({ id: 'client-1', result: '' })));
  const first = client.request('snapshot', {});
  h.root.send({ id: 'client-1', result: payload });
  assert.equal((await first as string).length, payload.length);
  const second = client.request('snapshot', {});
  const rejected = rejection(second, /combined output/);
  h.root.send({ id: 'client-2', result: payload });
  await rejected;
});

test('invalid UTF-8, truncated characters, and unterminated final lines cannot succeed', async (t) => {
  for (const kind of ['invalid', 'truncated', 'no-newline']) await t.test(kind, async (subtest) => {
    const h = mockChild(subtest);
    const client = h.client();
    const pending = client.request('waiting', {});
    const rejected = rejection(pending, /UTF-8|malformed|unterminated/);
    if (kind === 'invalid') h.root.stdout.write(Buffer.from([0xff, 10]));
    else if (kind === 'truncated') { h.root.stdout.write(Buffer.from([0xe7])); h.root.stdout.end(); }
    else { h.root.stdout.write(JSON.stringify({ id: 'client-1', result: true })); h.root.stdout.end(); }
    await rejected;
  });
});

test('outgoing request count is bounded and overflow settles every pending request', async (t) => {
  const h = mockChild(t);
  const client = h.client();
  const pending = Promise.allSettled(Array.from({ length: 65 }, () => client.request('waiting', {})));
  const results = await pending;
  assert.ok(results.every((result) => result.status === 'rejected'));
  assert.equal(h.root.messages().length, 64);
  assert.match((await client.failure).message, /pending request limit/);
});

test('incoming callback count and backpressured input bytes are bounded', async (t) => {
  await t.test('callbacks', async (subtest) => {
    const h = mockChild(subtest);
    const client = h.client({ onRequest: () => new Promise(() => {}) });
    for (let id = 0; id < 65; id++) h.root.send({ id, method: 'waiting' });
    assert.match((await client.failure).message, /peer request limit/);
  });
  await t.test('write bytes', async (subtest) => {
    const h = mockChild(subtest, { blockInput: true });
    const client = h.client();
    const results = await Promise.allSettled(Array.from({ length: 3 }, () => client.request('large', 'x'.repeat(800 * 1024))));
    assert.ok(results.every((result) => result.status === 'rejected'));
    assert.match((await client.failure).message, /input queue limit/);
  });
  await t.test('write count independent of callbacks', async (subtest) => {
    const h = mockChild(subtest, { blockInput: true });
    const client = h.client({ onRequest: () => true });
    for (let id = 0; id < 65; id++) { h.root.send({ id, method: 'done' }); await flush(); }
    assert.match((await client.failure).message, /input queue limit/);
  });
});

test('pre-cancellation never spawns and failure resolves rather than rejects', async (t) => {
  const h = mockChild(t);
  const controller = new AbortController();
  controller.abort(new Error('synthetic-secret'));
  const client = h.client({ signal: controller.signal });
  assert.match((await client.failure).message, /cancelled/);
  assert.equal(h.calls.length, 0);
  await rejection(client.request('no', {}), /cancelled/);
  assert.throws(() => client.assertAlive(), /cancelled/);
  await client.dispose();
});

test('cancellation during spawn still stops the newly owned child', async (t) => {
  const controller = new AbortController();
  const h = mockChild(t, { onSpawn: () => controller.abort() });
  const client = h.client({ signal: controller.signal });
  assert.match((await client.failure).message, /cancelled/);
  await client.dispose();
  assert.equal(h.root.closed, true);
  assert.equal(h.root.stdin.destroyed, true);
});

test('cancellation settles pending work and discards late results and callback rejections', async (t) => {
  const h = mockChild(t);
  const controller = new AbortController();
  let rejectCallback!: (error: Error) => void;
  const client = h.client({ signal: controller.signal,
    onRequest: () => new Promise((_resolve, reject) => { rejectCallback = reject; }),
  });
  const pending = client.request('waiting', {});
  const rejected = rejection(pending, /cancelled/);
  h.root.send({ id: 'server-1', method: 'waiting' });
  controller.abort(new Error('synthetic-secret'));
  h.root.send({ id: 'client-1', result: 'too late' });
  rejectCallback(new Error('synthetic-secret'));
  await rejected;
  await flush();
  assert.equal(h.root.messages().length, 1);
  await client.dispose();
});

test('an abort after a parsed reply but before its continuation cannot return success', async (t) => {
  const h = mockChild(t);
  const controller = new AbortController();
  const client = h.client({ signal: controller.signal });
  const pending = client.request('reply-then-abort', {});
  const rejected = rejection(pending, /cancelled/);
  h.root.send({ id: 'client-1', result: 'not delivered' });
  controller.abort();
  await rejected;
});

test('request deadline is rechecked before delivering an already parsed result', async (t) => {
  const h = mockChild(t);
  const client = h.client();
  const pending = client.request('parsed-before-deadline', {}, 20);
  const rejected = rejection(pending, /timed out/);
  h.root.send({ id: 'client-1', result: 'not delivered late' });
  const until = performance.now() + 30;
  while (performance.now() < until) { /* hold the promise continuation past its deadline */ }
  await rejected;
});

test('a late callback result is not written after disposal', async (t) => {
  const h = mockChild(t);
  let resolveCallback!: (value: unknown) => void;
  const client = h.client({ onRequest: () => new Promise((resolve) => { resolveCallback = resolve; }) });
  h.root.send({ id: 'server-1', method: 'delayed' });
  const stopped = client.dispose();
  resolveCallback('not delivered');
  await stopped;
  await flush();
  assert.deepEqual(h.root.messages(), []);
});

test('request timeout terminates the connection and rejects all pending work', async (t) => {
  const h = mockChild(t);
  const client = h.client();
  const results = Promise.allSettled([client.request('short', {}, 10), client.request('other', {})]);
  const failure = await client.failure;
  assert.match(failure.message, /request timed out/);
  h.root.send({ id: 'client-1', result: 'late' });
  assert.ok((await results).every((result) => result.status === 'rejected' && result.reason === failure));
});

test('absolute total and request deadlines prevent success even before timer callbacks run', async (t) => {
  for (const total of [true, false]) await t.test(total ? 'total' : 'request', async (subtest) => {
    const h = mockChild(subtest);
    const client = h.client({ timeoutMs: total ? 20 : 5000 });
    const pending = client.request('late', {}, total ? 5000 : 20);
    const rejected = rejection(pending, /deadline|timed out/);
    const until = performance.now() + 30;
    while (performance.now() < until) { /* deliberately hold the timer phase */ }
    h.root.send({ id: 'client-1', result: true });
    await rejected;
  });
});

test('idle transport has a total deadline with no request required', async (t) => {
  const h = mockChild(t);
  const client = h.client({ timeoutMs: 10 });
  assert.match((await client.failure).message, /total deadline/);
  await client.dispose();
  assert.ok(h.root.closed);
});

test('spawn, stream, exit, and event errors use only generic diagnostics', async (t) => {
  for (const kind of ['spawn-throw', 'spawn-error', 'stdin', 'stdout', 'stderr', 'exit', 'event', 'async-event']) {
    await t.test(kind, async (subtest) => {
      const h = mockChild(subtest, { spawnError: kind === 'spawn-throw' });
      const handler = () => {
        if (kind === 'async-event') return Promise.reject(new Error('private-payload'));
        throw new Error('synthetic-secret');
      };
      const client = h.client({ onEvent: handler });
      if (kind === 'spawn-error') h.root.emit('error', new Error('private-payload'));
      else if (kind === 'stdin' || kind === 'stdout' || kind === 'stderr') h.root[kind].emit('error', new Error('private-payload'));
      else if (kind === 'exit') { h.root.stderr.write('synthetic-secret'); h.root.close(9); }
      else if (kind === 'event' || kind === 'async-event') h.root.send({ method: 'bad' });
      assert.doesNotMatch((await client.failure).message, /synthetic-secret|private-payload/);
      await rejection(client.request('after', {}), /ZCode RPC/);
    });
  }
});

test('normal dispose is idempotent, closes owned pipes, and does not signal a failure', async (t) => {
  const h = mockChild(t);
  const client = h.client();
  let failed = false;
  void client.failure.then(() => { failed = true; });
  const pending = client.request('waiting', {});
  const rejected = rejection(pending, /disposed/);
  const stopped = client.dispose();
  assert.equal(client.dispose(), stopped);
  await stopped;
  await rejected;
  assert.equal(failed, false);
  assert.equal(h.root.stdin.destroyed, true);
  assert.equal(h.root.stdout.destroyed, true);
  assert.equal(h.root.stderr.destroyed, true);
  assert.equal(h.root.unreferenced, true);
  assert.throws(() => client.assertAlive(), /disposed/);
});

test('Windows disposal waits for taskkill after parent closure and kills a stuck helper at the force deadline', async (t) => {
  if (process.platform !== 'win32') { t.skip('Windows-owned taskkill lifecycle'); return; }
  await t.test('waits for helper', async (subtest) => {
    const h = mockChild(subtest, { autoClose: false });
    const client = h.client();
    let finished = false;
    const stopped = client.dispose().then(() => { finished = true; });
    h.root.close();
    await flush();
    assert.equal(finished, false);
    assert.equal(h.helpers[0].kills.length, 0);
    h.helpers[0].close();
    await stopped;
    assert.equal(finished, true);
  });
  await t.test('failed helper falls back to the owned child', async (subtest) => {
    const h = mockChild(subtest, { autoClose: false });
    const client = h.client();
    const stopped = client.dispose();
    h.helpers[0].emit('error', new Error('synthetic-secret'));
    assert.deepEqual(h.root.kills, ['SIGKILL']);
    h.root.close();
    await stopped;
    assert.equal(h.calls.length, 2);
  });
  await t.test('nonzero helper falls back to the owned child', async (subtest) => {
    const h = mockChild(subtest, { autoClose: false });
    const client = h.client();
    const stopped = client.dispose();
    h.helpers[0].close(1);
    assert.deepEqual(h.root.kills, ['SIGKILL']);
    h.root.close();
    await stopped;
  });
  await t.test('force deadline', async (subtest) => {
    subtest.mock.timers.enable({ apis: ['setTimeout'] });
    const h = mockChild(subtest, { autoClose: false });
    const client = h.client();
    const stopped = client.dispose();
    subtest.mock.timers.tick(3001);
    await stopped;
    assert.deepEqual(h.root.kills, ['SIGKILL']);
    assert.deepEqual(h.helpers[0].kills, ['SIGKILL']);
    assert.equal(h.helpers[0].unreferenced, true);
    assert.equal(h.root.stdout.destroyed, true);
    assert.equal(h.root.stderr.destroyed, true);
  });
});

test('POSIX termination is scoped to the owned process group and escalates with a bounded deadline', async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = mockChild(t, { autoClose: false });
  const client = h.client();
  assert.equal(h.calls[0].options.detached, true);
  const stopped = client.dispose();
  assert.deepEqual(h.groupKills, [{ pid: -h.root.pid, signal: 'SIGTERM' }]);
  t.mock.timers.tick(250);
  assert.deepEqual(h.groupKills[1], { pid: -h.root.pid, signal: 'SIGKILL' });
  t.mock.timers.tick(2751);
  await stopped;
  assert.equal(h.root.stdout.destroyed, true);
  assert.equal(h.root.stderr.destroyed, true);
  assert.equal(h.root.unreferenced, true);
  assert.ok(h.groupKills.every((call) => call.pid === -h.root.pid));
  assert.equal(h.calls.length, 1);
});

test('explicit failure preserves the first safe error and settles every request once', async (t) => {
  const h = mockChild(t);
  const client = h.client();
  const error = new Error('Safe upper-layer rejection');
  const pending = Promise.allSettled([client.request('one', {}), client.request('two', {})]);
  client.fail(error);
  client.fail(new Error('Ignored second failure'));
  assert.equal(await client.failure, error);
  assert.ok((await pending).every((result) => result.status === 'rejected' && result.reason === error));
  await client.dispose();
});

test('invalid options and outgoing JSON fail safely without unwanted spawns or writes', async (t) => {
  const h = mockChild(t);
  for (const options of [{ command: '' }, { args: ['bad\0arg'] }, { cwd: '' }, { timeoutMs: 0 },
    { timeoutMs: 2_147_483_648 }, { maxOutputBytes: -1 }, { maxOutputBytes: 2 * 1024 * 1024 + 1 }]) {
    assert.throws(() => h.client(options), /invalid transport/);
  }
  assert.equal(h.calls.length, 0);
  assert.throws(() => new RpcFault(Number.NaN, 'bad'));
  assert.throws(() => new RpcFault(1, 'bad\nmessage'));
  const client = h.client();
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await rejection(client.request('circular', circular), /serializable/);
  await rejection(client.request('big', 'x'.repeat(1024 * 1024)), /line limit/);
  await rejection(client.request('function', () => {}), /serializable/);
  await rejection(client.request('invalid\nmethod', {}), /invalid request/);
  await rejection(client.request('timeout', {}, 0), /invalid request/);
  assert.equal(h.root.messages().length, 0);
  client.assertAlive();
});

test('cancellation from JSON serialization cannot leave a new request pending', async (t) => {
  const h = mockChild(t);
  const controller = new AbortController();
  const client = h.client({ signal: controller.signal });
  await rejection(client.request('reentrant', { toJSON() { controller.abort(); return {}; } }), /cancelled/);
  assert.equal(h.root.messages().length, 0);
});

test('non-serializable callback results fail closed instead of emitting malformed replies', async (t) => {
  const h = mockChild(t);
  const client = h.client({ onRequest: () => 1n });
  h.root.send({ id: 'server-1', method: 'bad-result' });
  assert.match((await client.failure).message, /invalid request handler result/);
  assert.equal(h.root.messages().length, 0);
});

// Synthetic Node peers only. Empty env avoids inherited NODE_OPTIONS and user configuration.
const fixturePeer = String.raw`
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
let waiting;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'roundtrip') {
    waiting = message.id;
    send({ method: 'fixture/ready', params: { text: '界😀é' }, trace: 'fixture' });
    send({ id: 'server-1', method: 'fixture/callback', params: message.params });
  } else if (message.id === 'server-1') {
    send({ id: waiting, result: message.result });
  } else if (message.method === 'tree') {
    const descendant = spawn(process.execPath, ['--input-type=commonjs', '-e', 'setInterval(() => {}, 1000)'],
      { env: {}, shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
    send({ id: message.id, result: { parent: process.pid, descendant: descendant.pid } });
  }
});
setInterval(() => {}, 1000);
`;
function realClient(t: TestContext, overrides: Partial<ZcodeRpcOptions> = {}): ZcodeRpcClient {
  const client = new ZcodeRpcClient({
    command: process.execPath, args: ['--input-type=commonjs', '-e', fixturePeer], cwd, env: {}, timeoutMs: 8000,
    onRequest: (_method, params) => ({ received: params }), onEvent: () => {}, ...overrides,
  });
  t.after(() => client.dispose());
  return client;
}
function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

test('fresh Node peer exercises actual bidirectional pipes without ZCode or model calls', async (t) => {
  const events: unknown[] = [];
  const client = realClient(t, { onEvent: (method, params) => { events.push([method, params]); } });
  assert.deepEqual(await client.request('roundtrip', { text: '界😀é', literal: '; & $(never)' }),
    { received: { text: '界😀é', literal: '; & $(never)' } });
  assert.deepEqual(events, [['fixture/ready', { text: '界😀é' }]]);
  await client.dispose();
  assert.throws(() => client.assertAlive(), /disposed/);
});

test('normal disposal stops the actual owned Node tree and releases inherited pipes', async (t) => {
  const client = realClient(t);
  const pids = await client.request<{ parent: number; descendant: number }>('tree', {});
  t.after(() => { for (const pid of Object.values(pids)) { try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ } } });
  await client.dispose();
  for (let attempt = 0; attempt < 30 && Object.values(pids).some(isRunning); attempt++) await delay(25);
  assert.equal(isRunning(pids.parent), false);
  assert.equal(isRunning(pids.descendant), false);
});

test('cancellation stops the actual owned Node tree and releases inherited pipes', async (t) => {
  const controller = new AbortController();
  const client = realClient(t, { signal: controller.signal });
  const pids = await client.request<{ parent: number; descendant: number }>('tree', {});
  // Cleanup targets only these two freshly spawned fixture PIDs if an assertion fails.
  t.after(() => { for (const pid of Object.values(pids)) { try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ } } });
  assert.equal(isRunning(pids.parent), true);
  assert.equal(isRunning(pids.descendant), true);
  const rejected = rejection(client.request('never-answered', {}), /cancelled/);
  controller.abort();
  await rejected;
  const started = performance.now();
  await client.dispose();
  assert.ok(performance.now() - started < 4000);
  for (let attempt = 0; attempt < 30 && Object.values(pids).some(isRunning); attempt++) await delay(25);
  assert.equal(isRunning(pids.parent), false);
  assert.equal(isRunning(pids.descendant), false);
});
