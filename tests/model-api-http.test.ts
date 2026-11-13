import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { requestModelOnce, ModelApiError, reasoningPatch, type ModelApiConnection } from '../src/server/model-api-http.js';

const connection: ModelApiConnection = { baseUrl: 'https://models.example.com/v1', apiKey: 'FIXTURE_KEY_NEVER_PUBLIC', apiType: 'openai-responses', effectiveReasoning: 'max', reasoningMap: '{"reasoning":{"effort":reasoningLevel}}', maxOutputMap: '{"max_output_tokens":maxOutputTokens}', catalogRevision: 'a'.repeat(64) };

test('真实HTTP适配层固定DNS公网地址且只发一次请求，不跟随重定向或重试限流', async t => {
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }] as any);
  syncBuiltinESMExports();
  let calls = 0, status = 200;
  t.mock.method(https, 'request', ((url: URL, options: any, callback: (response: any) => void) => {
    calls++;
    assert.equal(url.href, 'https://models.example.com/v1/responses');
    assert.equal(options.servername, 'models.example.com');
    assert.equal(options.agent, false);
    options.lookup('models.example.com', { all: false }, (error: unknown, address: string, family: number) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
    const req = new EventEmitter() as any;
    req.destroy = () => req;
    req.end = (payload: string) => {
      const parsed = JSON.parse(payload); assert.equal(parsed.reasoning.effort, 'max'); assert.equal(parsed.max_output_tokens, 2048); assert.equal(parsed.tools, undefined);
      queueMicrotask(() => { const res = Object.assign(new PassThrough(), { statusCode: status }); callback(res); res.end(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: 'OK' }] }] })); });
    };
    return req;
  }) as any);
  for (const value of [200, 302, 403, 429]) {
    status = value;
    const before = calls;
    const result = await requestModelOnce({ connection, modelId: 'model-fixture', signal: new AbortController().signal, timeoutMs: 1000 });
    assert.equal(calls, before + 1);
    assert.equal(result.status, value === 200 ? 'passed' : 'failed');
    assert.ok(!JSON.stringify(result).includes(connection.apiKey));
  }
});

test('DNS返回私网或混合地址时不向HTTPS发送任何凭据', async t => {
  let calls = 0;
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] as any);
  syncBuiltinESMExports();
  t.mock.method(https, 'request', (() => { calls++; throw new Error('must not send'); }) as any);
  await assert.rejects(requestModelOnce({ connection, modelId: 'model-fixture', signal: new AbortController().signal, timeoutMs: 1000 }), (error: unknown) => error instanceof ModelApiError && error.code === 'endpoint_not_allowed');
  assert.equal(calls, 0);
});

test('映射字符串内的空白不能被规范化为另一条已核验映射', () => {
  assert.deepEqual(reasoningPatch('{ "reasoning": {"effort": reasoningLevel} }', 'max', 'openai-responses'), { reasoning: { effort: 'max' } });
  assert.throws(() => reasoningPatch('{"reason ing":{"effort":reasoningLevel}}', 'max', 'openai-responses'));
  assert.throws(() => reasoningPatch('{"reasoning":{"eff ort":reasoningLevel}}', 'max', 'openai-responses'));
  assert.throws(() => reasoningPatch('{"reasoning":{"effort":eval(reasoningLevel)}}', 'max', 'openai-responses'));
});
