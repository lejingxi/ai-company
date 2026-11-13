import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export interface ModelApiConnection {
  baseUrl: string; apiKey: string;
  apiType: 'openai-chat-completions' | 'openai-responses' | 'anthropic-messages';
  effectiveReasoning: string | null; reasoningMap: string | null; maxOutputMap: string | null;
  catalogRevision: string;
}
export interface ApiRequestInput { connection: ModelApiConnection; modelId: string; signal: AbortSignal; timeoutMs: number; }
export interface ApiRequestResult { status: 'passed' | 'failed'; code: string; message: string; reasoningHonored: 'not-confirmed' | 'reported'; }
export type ModelApiRequest = (input: ApiRequestInput) => Promise<ApiRequestResult>;
export class ModelApiError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ModelApiError'; }
}
const MAX_RESPONSE = 512 * 1024;
const blocks = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocks.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
const deniedV6 = new BlockList(); deniedV6.addSubnet('2001:db8::', 32, 'ipv6'); deniedV6.addSubnet('2001::', 23, 'ipv6'); deniedV6.addSubnet('2002::', 16, 'ipv6');
export function isPublicIp(address: string): boolean {
  const version = isIP(address);
  return version === 4 ? !blocks.check(address, 'ipv4') : version === 6 && globalV6.check(address, 'ipv6') && !deniedV6.check(address, 'ipv6');
}
export function validatePublicUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ModelApiError('invalid_endpoint', '配置的服务地址无效'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443') || !host.includes('.') && !isIP(host) || host.toLowerCase() === 'localhost' || /\.(?:localhost|local|internal|lan)$/.test(host.toLowerCase()) || isIP(host) && !isPublicIp(host)) throw new ModelApiError('endpoint_not_allowed', '仅支持无认证信息、查询参数或重定向的公网 HTTPS 443 服务');
  return url;
}
function compact(value: string): string {
  let result = '';
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (/\s/.test(char)) continue;
    if (char !== '"' && char !== "'") { result += char; continue; }
    const quote = char;
    let text = '', closed = false;
    while (++i < value.length) {
      if (value[i] === quote) { closed = true; break; }
      // Verified bundled maps use plain string literals. Escapes are not evaluated.
      if (value[i] === '\\' || /[\r\n\u0000-\u001f]/.test(value[i])) throw new ModelApiError('reasoning_mapping_unsupported', '参数映射含未支持的字符串形式');
      text += value[i];
    }
    if (!closed) throw new ModelApiError('reasoning_mapping_unsupported', '参数映射字符串不完整');
    result += JSON.stringify(text);
  }
  return result;
}
const CHAT_MAP = `{"thinking":{"type":reasoningLevel=="disabled"||reasoningLevel=="none"?"disabled":"enabled"},"enable_thinking":reasoningLevel!="disabled"&&reasoningLevel!="none","reasoning_effort":reasoningLevel=="disabled"?"none":reasoningLevel=="enabled"?"high":reasoningLevel,"reasoning":{"effort":reasoningLevel=="disabled"?"none":reasoningLevel=="enabled"?"high":reasoningLevel}}`;
const RESPONSE_MAP = `{"reasoning":{"effort":reasoningLevel=="disabled"?"none":reasoningLevel=="enabled"?"high":reasoningLevel}}`;
const ANTHROPIC_MAP = `reasoningLevel=="disabled"?{"thinking":{"type":"disabled"}}:{"thinking":{"type":"adaptive"},"output_config":{"effort":reasoningLevel=="enabled"?"high":reasoningLevel}}`;
export function reasoningPatch(map: string | null, level: string | null, protocol: ModelApiConnection['apiType']): Record<string, unknown> {
  if (level === null) { if (map) throw new ModelApiError('reasoning_unknown', '模型思考强度默认值尚未确定，拒绝省略参数测试'); return {}; }
  if (!/^[a-zA-Z0-9_-]{1,24}$/.test(level) || !map || map.length > 16_384) throw new ModelApiError('reasoning_mapping_unsupported', '此模型的思考强度映射尚未支持');
  const expression = compact(map), effort = level === 'disabled' ? 'none' : level === 'enabled' ? 'high' : level;
  if (protocol === 'openai-chat-completions' && expression === CHAT_MAP) return { thinking: { type: ['disabled', 'none'].includes(level) ? 'disabled' : 'enabled' }, enable_thinking: !['disabled', 'none'].includes(level), reasoning_effort: effort, reasoning: { effort } };
  if (protocol === 'openai-responses' && expression === RESPONSE_MAP) return { reasoning: { effort } };
  if (protocol === 'openai-responses' && expression === '{"reasoning":{"effort":reasoningLevel}}') return { reasoning: { effort: level } };
  if (protocol === 'openai-chat-completions' && expression === '{"reasoning_effort":reasoningLevel}') return { reasoning_effort: level };
  if (protocol === 'anthropic-messages' && expression === ANTHROPIC_MAP) return level === 'disabled' ? { thinking: { type: 'disabled' } } : { thinking: { type: 'adaptive' }, output_config: { effort } };
  if (protocol === 'anthropic-messages' && expression === '{"thinking":{"type":"adaptive"},"output_config":{"effort":reasoningLevel}}') return { thinking: { type: 'adaptive' }, output_config: { effort: level } };
  const typeMap = '{"thinking":{"type":reasoningLevel=="enabled"?"enabled":"disabled"}}';
  if ((protocol === 'anthropic-messages' || protocol === 'openai-chat-completions') && expression === typeMap) return { thinking: { type: level === 'enabled' ? 'enabled' : 'disabled' } };
  const dsChat = 'reasoningLevel=="disabled"?{"thinking":{"type":"disabled"}}:{"thinking":{"type":"enabled"},"reasoning_effort":reasoningLevel}';
  const dsAnthropic = 'reasoningLevel=="disabled"?{"thinking":{"type":"disabled"}}:{"thinking":{"type":"enabled"},"output_config":{"effort":reasoningLevel}}';
  if (protocol === 'openai-chat-completions' && expression === dsChat) return level === 'disabled' ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled' }, reasoning_effort: level };
  if (protocol === 'anthropic-messages' && expression === dsAnthropic) return level === 'disabled' ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled' }, output_config: { effort: level } };
  throw new ModelApiError('reasoning_mapping_unsupported', '此协议的思考强度映射尚未核验；不会猜测、降档或删参数重试');
}
export function buildModelRequest(connection: ModelApiConnection, modelId: string): { url: URL; headers: Record<string, string>; body: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(modelId)) throw new ModelApiError('invalid_model', '模型标识无效');
  if (!connection.apiKey || connection.apiKey.length > 8192 || /[\r\n]/.test(connection.apiKey)) throw new ModelApiError('auth_config_invalid', '模型凭据缺失或格式不支持');
  const protocol = connection.apiType;
  const suffix = protocol === 'openai-chat-completions' ? '/chat/completions' : protocol === 'openai-responses' ? '/responses' : protocol === 'anthropic-messages' ? '/messages' : null;
  if (!suffix) throw new ModelApiError('protocol_unsupported', '当前服务协议不支持连接测试');
  const url = validatePublicUrl(connection.baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, '') + suffix;
  const budgetField = protocol === 'openai-chat-completions' ? 'max_completion_tokens' : protocol === 'openai-responses' ? 'max_output_tokens' : 'max_tokens';
  if (!connection.maxOutputMap || compact(connection.maxOutputMap) !== `{"${budgetField}":maxOutputTokens}`) throw new ModelApiError('output_mapping_unsupported', '输出预算参数映射未核验，不能发起测试');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (protocol === 'anthropic-messages') { headers['x-api-key'] = connection.apiKey; headers['anthropic-version'] = '2023-06-01'; }
  else headers.Authorization = `Bearer ${connection.apiKey}`;
  const body: Record<string, unknown> = { model: modelId, stream: false, [budgetField]: 2048, ...reasoningPatch(connection.reasoningMap, connection.effectiveReasoning, protocol) };
  if (protocol === 'openai-responses') { body.input = 'Reply exactly OK.'; body.store = false; }
  else body.messages = [{ role: 'user', content: 'Reply exactly OK.' }];
  return { url, headers, body: JSON.stringify(body) };
}
export function parseModelResponse(status: number, raw: string, protocol: ModelApiConnection['apiType'], reasoning: string | null): ApiRequestResult {
  const failure = (code: string, message: string): ApiRequestResult => ({ status: 'failed', code, message, reasoningHonored: 'not-confirmed' });
  if (status >= 300 && status < 400) return failure('redirect_rejected', '服务返回重定向，未携带凭据继续请求');
  if (status === 401 || status === 403) return failure('authentication_failed', '服务拒绝认证或当前模型访问权限');
  if (status === 429 || /余额不足|insufficient[_ -]quota|quota exceeded/i.test(raw)) return failure('quota_or_rate_limit', '服务额度不足或限流；没有重试');
  if (status === 400 && /reasoning|effort|thinking|unsupported.*parameter|unknown.*parameter/i.test(raw)) return failure('reasoning_rejected', '服务拒绝所选思考强度或映射参数；没有降档、删参数或换协议重试');
  if (status < 200 || status >= 300) return failure('upstream_error', `模型服务返回 HTTP ${status}；原始响应已隐藏`);
  let value: any;
  try { value = JSON.parse(raw); } catch { return failure('invalid_response', '服务未返回有效 JSON 生成结果'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.error) return failure('invalid_response', '服务返回错误或不完整结果，不计为连接成功');
  if (value.status === 'incomplete' || value.incomplete_details?.reason === 'max_output_tokens' || value.stop_reason === 'max_tokens' || value.choices?.[0]?.finish_reason === 'length') return failure('output_budget_exhausted', '本次输出预算耗尽，未取得完整可见回复；不会自动增加额度重试');
  let visible = '';
  if (protocol === 'openai-chat-completions') {
    const answer = value.choices?.[0]?.message?.content;
    if (typeof answer === 'string') visible = answer;
  } else if (protocol === 'anthropic-messages' && Array.isArray(value.content)) visible = value.content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('');
  else if (protocol === 'openai-responses' && Array.isArray(value.output)) visible = value.output.flatMap((part: any) => Array.isArray(part?.content) ? part.content : []).filter((part: any) => part?.type === 'output_text' && typeof part.text === 'string').map((part: any) => part.text).join('');
  if (!visible.trim()) return failure('no_visible_output', '服务没有返回可见生成内容，不能仅凭 HTTP 200 判定成功');
  const reported = value.reasoning?.effort ?? value.reasoning_effort ?? value.output_config?.effort;
  const reasoningHonored = reasoning !== null && reported === reasoning ? 'reported' : 'not-confirmed';
  return { status: 'passed', code: 'generation_received', message: '模型 API 已返回有效生成内容；不代表 ZCode 员工、工具或 Docker 已接通。', reasoningHonored };
}
export const requestModelOnce: ModelApiRequest = async input => {
  const { url, headers, body } = buildModelRequest(input.connection, input.modelId);
  if (input.signal.aborted) throw new ModelApiError('cancelled', '测试已取消');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const timeoutMs = Math.max(1, Math.min(input.timeoutMs, 45_000));
  const deadline = Date.now() + timeoutMs;
  let addresses: { address: string; family: number }[];
  try {
    addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new ModelApiError('timeout', 'DNS 解析超时')), Math.min(timeoutMs, 10_000)); timer.unref(); }),
    ]);
  } catch (error) { if (error instanceof ModelApiError) throw error; throw new ModelApiError('dns_failed', '服务域名解析失败；未发送凭据'); }
  if (!addresses.length || addresses.some(item => !isPublicIp(item.address))) throw new ModelApiError('endpoint_not_allowed', '服务域名解析到非公网地址，已阻止请求');
  if (input.signal.aborted) throw new ModelApiError('cancelled', '测试已取消');
  const chosen = addresses[0];
  return new Promise<ApiRequestResult>((resolve, reject) => {
    let settled = false, bytes = 0;
    const chunks: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: ModelApiError, result?: ApiRequestResult) => {
      if (settled) return; settled = true; clearTimeout(timer); input.signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result!);
    };
    const req = https.request(url, {
      method: 'POST', headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) }, agent: false,
      servername: isIP(host) ? undefined : host,
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'object' && options.all) (callback as any)(null, [{ address: chosen.address, family: chosen.family }]);
        else (callback as any)(null, chosen.address, chosen.family);
      },
    }, res => {
      if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) { res.resume(); req.destroy(); finish(undefined, parseModelResponse(res.statusCode!, '', input.connection.apiType, input.connection.effectiveReasoning)); return; }
      res.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_RESPONSE) { req.destroy(); finish(new ModelApiError('response_too_large', '模型响应超过512 KiB，已停止读取')); } else chunks.push(Buffer.from(chunk)); });
      res.on('end', () => finish(undefined, parseModelResponse(res.statusCode ?? 0, Buffer.concat(chunks).toString('utf8'), input.connection.apiType, input.connection.effectiveReasoning)));
      res.on('error', () => finish(new ModelApiError('network_error', '模型响应读取失败；未重试')));
    });
    function abort() { req.destroy(); finish(new ModelApiError('cancelled', '测试已取消')); }
    req.on('error', () => finish(new ModelApiError('network_error', 'HTTPS 连接失败或中断；没有重试，未回显底层错误')));
    timer = setTimeout(() => { req.destroy(); finish(new ModelApiError('timeout', '模型连接测试超时；没有重试')); }, Math.max(1, deadline - Date.now()));
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort(); else req.end(body);
  });
};
