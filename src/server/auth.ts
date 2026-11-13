import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Store, id, now, type UserRow, type SessionRow } from './db.js';
import { AppError, text } from './policy.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const hashPassword = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key)));
function validatePassword(value: unknown, min: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > 128) throw new AppError(`密码长度应为 ${min}–128 个字符`);
  return value;
}
export interface Identity { id: string; username: string; csrf: string; sessionHash: string; }

export class Auth {
  private attempts = new Map<string, { count: number; reset: number }>();
  constructor(private store: Store) {}
  setupRequired() { return Number((this.store.sql.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n) === 0; }
  private limit(key: string) {
    const time = Date.now();
    const previous = this.attempts.get(key);
    if (!previous || previous.reset < time) this.attempts.set(key, { count: 1, reset: time + 60_000 });
    else if (++previous.count > 8) throw new AppError('尝试过于频繁，请 60 秒后再试', 429);
  }
  identify(req: IncomingMessage): Identity | null {
    const cookie = req.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith('zy_session='))?.slice(11);
    if (!cookie || !/^[a-f0-9]{64}$/.test(cookie)) return null;
    const row = this.store.sql.prepare('SELECT sessions.*, users.username FROM sessions JOIN users ON users.id=sessions.user_id WHERE id_hash=? AND expires_at>?').get(digest(cookie), now()) as (SessionRow & { username: string }) | undefined;
    return row ? { id: row.user_id, username: row.username, csrf: row.csrf, sessionHash: row.id_hash } : null;
  }
  revalidate(req: IncomingMessage, identity: Identity): Identity {
    const current = this.identify(req);
    if (!current || current.sessionHash !== identity.sessionHash || current.id !== identity.id) throw new AppError('登录已失效，请重新登录', 401);
    this.csrf(req, current);
    return current;
  }
  sessionValid(identity: Identity): boolean {
    return !!this.store.sql.prepare('SELECT 1 FROM sessions WHERE id_hash=? AND user_id=? AND csrf=? AND expires_at>?').get(identity.sessionHash, identity.id, identity.csrf, now());
  }
  csrf(req: IncomingMessage, identity: Identity) {
    const token = req.headers['x-csrf-token'];
    if (typeof token !== 'string' || token !== identity.csrf) throw new AppError('请求校验失效，请刷新页面后重试', 403);
  }
  private newSession(user: UserRow) {
    const token = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');
    this.store.sql.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now());
    this.store.sql.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(token), user.id, csrfToken, new Date(Date.now() + 8 * 3600_000).toISOString());
    return { cookie: `zy_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`, body: { setupRequired: false, user: { id: user.id, username: user.username }, csrfToken } };
  }
  async setup(usernameValue: unknown, passwordValue: unknown, ip: string) {
    this.limit(`setup:${ip}`);
    if (!this.setupRequired()) throw new AppError('管理员已经创建，请登录', 409);
    const username = text(usernameValue, '用户名', 60, 2);
    const password = validatePassword(passwordValue, 12);
    const salt = randomBytes(32).toString('hex');
    const key = await hashPassword(password, salt);
    const user: UserRow = { id: id('user'), username, password_hash: key.toString('hex'), salt, created_at: now() };
    this.store.transaction(() => {
      if (!this.setupRequired()) throw new AppError('管理员已在另一请求中创建', 409);
      this.store.sql.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(user.id, user.username, user.password_hash, user.salt, user.created_at);
      this.store.audit(user.id, '创建本地管理员', user.id, '密码仅保存 scrypt 哈希；自动注册入口已关闭');
    });
    return this.newSession(user);
  }
  async login(usernameValue: unknown, passwordValue: unknown, ip: string) {
    this.limit(`login:${ip}`);
    const username = text(usernameValue, '用户名', 60);
    const password = validatePassword(passwordValue, 1);
    const user = this.store.sql.prepare('SELECT * FROM users WHERE username=?').get(username) as unknown as UserRow | undefined;
    const actual = await hashPassword(password, user?.salt ?? 'invalid-user-constant-salt');
    const expected = user ? Buffer.from(user.password_hash, 'hex') : Buffer.alloc(64);
    if (!timingSafeEqual(actual, expected) || !user) throw new AppError('用户名或密码不正确', 401);
    this.store.audit(user.id, '管理员登录', user.id, '本机认证成功');
    return this.newSession(user);
  }
  logout(identity: Identity) {
    this.store.sql.prepare('DELETE FROM sessions WHERE id_hash=?').run(identity.sessionHash);
    return 'zy_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
  }
}
