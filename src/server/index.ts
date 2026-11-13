import { loadConfig } from './config.js';
import { createApp } from './api.js';

const config = loadConfig();
const app = createApp(config);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try { await app.close(); process.exitCode = 0; }
  catch (error) { console.error(error); process.exitCode = 1; }
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
app.server.on('error', error => { console.error('服务启动失败：', error.message); void shutdown(); });
app.server.listen(config.port, '127.0.0.1', () => {
  console.log(`智研司 · http://127.0.0.1:${config.port}`);
  console.log('本机认证已启用。复用当前用户 ZCode 配置；真实任务需显式连接与 Docker 检查。合并和发布执行器保持关闭。');
  console.log('首次访问请自行创建管理员账号（密码至少 12 位）。');
});
