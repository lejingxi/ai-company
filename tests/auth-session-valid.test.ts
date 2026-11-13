import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/db.js';
import { Auth } from '../src/server/auth.js';
import { createHash } from 'node:crypto';

test('后台连接测试的会话有效性检查在登出与过期后立即失败', () => {
  const store = new Store(':memory:');
  const auth = new Auth(store);
  const cookie = 'temporary-test-cookie-only';
  const sessionHash = createHash('sha256').update(cookie).digest('hex');
  const identity = { id: 'test-user', username: 'test', csrf: 'csrf-test', sessionHash };
  try {
    store.sql.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(identity.id, identity.username, 'not-a-password', 'test', new Date().toISOString());
    store.sql.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(sessionHash, identity.id, identity.csrf, new Date(Date.now() + 60_000).toISOString());
    assert.equal(auth.sessionValid(identity), true);
    assert.equal(auth.sessionValid({ ...identity, id: 'other-user' }), false);
    assert.equal(auth.sessionValid({ ...identity, csrf: 'other-token' }), false);
    store.sql.prepare('UPDATE sessions SET expires_at=? WHERE id_hash=?').run('2000-01-01T00:00:00Z', sessionHash);
    assert.equal(auth.sessionValid(identity), false);
    store.sql.prepare('UPDATE sessions SET expires_at=? WHERE id_hash=?').run(new Date(Date.now() + 60_000).toISOString(), sessionHash);
    assert.equal(auth.sessionValid(identity), true);
    auth.logout(identity);
    assert.equal(auth.sessionValid(identity), false);
  } finally { store.close(); }
});
