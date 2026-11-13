import { Store, id, now } from './db.js';
import { AppError } from './policy.js';
import type { Monitor } from '../shared/types.js';

export function validateMonitorUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError('监控地址不是有效 URL'); }
  // Initial release checks only a user-registered local demonstration service.
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.hash) throw new AppError('首版监控仅允许明确登记的本机 HTTP 演示服务，不接生产或外部地址');
  if (url.search || value.includes('?')) throw new AppError('首版监控不接受查询参数，请使用不含凭据的健康地址');
  if (!url.port || !/^\d+$/.test(url.port) || Number(url.port) < 1024) throw new AppError('监控必须指定非特权端口');
  if (url.pathname.length > 256 || url.search.length > 256) throw new AppError('监控地址过长');
  return url;
}
export class Monitoring {
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = new Set<string>();
  constructor(private store: Store, private allowed: boolean) {}
  start() {
    if (!this.allowed || this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 10_000);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  private async tick() {
    for (const monitor of this.store.all('monitors')) {
      if (monitor.enabled && (!monitor.lastCheckedAt || Date.now() - Date.parse(monitor.lastCheckedAt) >= monitor.intervalSeconds * 1000)) {
        await this.check(monitor.id, 'scheduler').catch(() => undefined);
      }
    }
  }
  async check(monitorId: string, actor: string): Promise<Monitor> {
    const monitor = this.store.get('monitors', monitorId);
    if (!monitor) throw new AppError('监控不存在', 404);
    if (this.active.has(monitorId)) throw new AppError('该检查正在运行', 409);
    const url = validateMonitorUrl(monitor.url);
    this.active.add(monitorId);
    let status: Monitor['lastStatus'] = 'failed';
    let detail = '';
    const started = Date.now();
    try {
      const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Zhiyansi-ReadOnly-Monitor/0.1', Accept: 'application/json,text/plain' } });
      status = response.ok ? 'healthy' : 'failed';
      detail = `HTTP ${response.status}；耗时 ${Date.now() - started} ms；没有读取或执行响应中的指令`;
      await response.body?.cancel();
    } catch (error) { detail = `探针失败：${error instanceof Error ? error.message : String(error)}；未执行恢复操作`; }
    finally { this.active.delete(monitorId); }
    const next = { ...monitor, lastStatus: status, lastCheckedAt: now(), detail };
    this.store.transaction(() => {
      this.store.put('monitors', next);
      this.store.audit(actor, '只读健康检查', monitor.id, detail);
      if (status === 'failed' && !this.store.all('incidents').some(item => item.projectId === monitor.projectId && item.status === 'open' && item.title === `监控异常：${monitor.url}`)) {
        this.store.put('incidents', { id: id('incident'), projectId: monitor.projectId, title: `监控异常：${monitor.url}`, severity: 'warning', status: 'open', detail: `${detail}\n运维 AI 分析尚未启用。请项目负责人确认影响范围；重启、回滚、发布仍需本人批准。`, createdAt: now() });
      }
    });
    return next;
  }
}
