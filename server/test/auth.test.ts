import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';

async function makeApp(env: Record<string, string> = {}) {
  const config = loadConfig({ DATA_DIR: ':memory:', WEB_DIR: '/nonexistent', LOG_LEVEL: 'silent', ...env });
  return buildApp(config, openDb(':memory:'));
}

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : String(raw);
  return first.split(';')[0];
}

test('first run requires setup, then setup logs you in', async () => {
  const app = await makeApp();
  const status = await app.inject({ url: '/api/auth/status' });
  assert.deepEqual(status.json(), { setupRequired: true, user: null });

  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'admin', password: 'hunter2hunter2' } });
  assert.equal(setup.statusCode, 200);
  const me = await app.inject({ url: '/api/auth/status', headers: { cookie: cookieFrom(setup) } });
  assert.deepEqual(me.json(), { setupRequired: false, user: { id: 1, username: 'admin', isAdmin: true } });

  const again = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'other', password: 'hunter2hunter2' } });
  assert.equal(again.statusCode, 409);
});

test('setup rejects weak credentials', async () => {
  const app = await makeApp();
  const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'admin', password: 'short' } });
  assert.equal(res.statusCode, 400);
});

test('login, protected API and logout', async () => {
  const app = await makeApp({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'correct-horse' });
  app.get('/api/secret', async () => ({ secret: true }));

  assert.equal((await app.inject({ url: '/api/secret' })).statusCode, 401);

  const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'wrong-password' } });
  assert.equal(bad.statusCode, 401);

  const good = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ADMIN', password: 'correct-horse' } });
  assert.equal(good.statusCode, 200);
  const cookie = cookieFrom(good);
  assert.equal((await app.inject({ url: '/api/secret', headers: { cookie } })).statusCode, 200);

  await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
  assert.equal((await app.inject({ url: '/api/secret', headers: { cookie } })).statusCode, 401);
});

test('repeated failed logins are rate limited', async () => {
  const app = await makeApp({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'correct-horse' });
  for (let i = 0; i < 10; i++) {
    await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'nope-nope' } });
  }
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse' } });
  assert.equal(res.statusCode, 429);
});
