// Credentials stay in the browser. The session cookie is managed by the server;
// CSRF state deliberately never touches localStorage/sessionStorage or a URL.
let csrfToken: string | null = null;

export function setCsrfToken(token?: string) {
  csrfToken = token || null;
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, options: {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  signal?: AbortSignal;
} = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  const authEntry = path === '/api/auth/setup' || path === '/api/auth/login';
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && !authEntry) {
    if (!csrfToken) throw new ApiError('登录凭证尚未就绪，请重新登录后再操作。', 403);
    headers['X-CSRF-Token'] = csrfToken;
  }
  const response = await fetch(path, {
    method, headers, credentials: 'same-origin', cache: 'no-store',
    signal: options.signal,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  // Expire the UI even if a proxy returned a non-JSON 401 response.
  if (response.status === 401 && !authEntry) {
    csrfToken = null;
    window.dispatchEvent(new Event('zhiyansi:session-expired'));
  }
  const text = await response.text();
  let value: unknown = null;
  if (text) {
    try { value = JSON.parse(text); }
    catch { throw new ApiError('服务返回了无法识别的响应，请确认本机服务已启动。', response.status); }
  }
  if (!response.ok) {
    const message = value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
      ? value.error : `请求未完成（HTTP ${response.status}）`;
    throw new ApiError(message, response.status);
  }
  return value as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof TypeError) return '无法连接本机服务，请检查服务是否正在运行后重试。';
  return error instanceof Error ? error.message : '操作未完成，请重试。';
}
