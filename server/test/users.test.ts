import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loggedInApp } from './helpers.js';

async function loginAs(app: Awaited<ReturnType<typeof loggedInApp>>['app'], username: string, password: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  assert.equal(res.statusCode, 200, res.body);
  const raw = res.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0] : String(raw)).split(';')[0];
  return (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as object, headers: { cookie } });
}

test('each viewer has their own multiview and cannot manage the app', async () => {
  const { app, call } = await loggedInApp();
  await call('POST', '/api/sources', { type: 'm3u_file', name: 'S', fileContent: '#EXTM3U\n#EXTINF:-1,One\nhttp://x/1.m3u8\n#EXTINF:-1,Two\nhttp://x/2.m3u8\n' });
  const [one, two] = (await call('GET', '/api/channels')).json().items;

  assert.equal((await call('POST', '/api/users', { username: 'kid', password: 'short' })).statusCode, 400);
  const created = await call('POST', '/api/users', { username: 'kid', password: 'cartoons123' });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().user.isAdmin, false);
  assert.equal((await call('POST', '/api/users', { username: 'KID', password: 'cartoons123' })).statusCode, 409);

  const kid = await loginAs(app, 'kid', 'cartoons123');
  const tile = (channelId: number | null) => ({ channelId, muted: true });
  await call('PUT', '/api/multiview', { tiles: [tile(one.id), tile(null), tile(null), tile(null)] });
  await kid('PUT', '/api/multiview', { tiles: [tile(two.id), tile(null), tile(null), tile(null)] });
  assert.equal((await call('GET', '/api/multiview')).json().tiles[0].channelId, one.id);
  assert.equal((await kid('GET', '/api/multiview')).json().tiles[0].channelId, two.id);

  // Viewers can browse and play, but not change sources, channels or accounts.
  assert.equal((await kid('GET', '/api/channels?enabled=true')).statusCode, 200);
  assert.equal((await kid('GET', '/api/sources')).statusCode, 403);
  assert.equal((await kid('PATCH', `/api/channels/${one.id}`, { customName: 'x' })).statusCode, 403);
  assert.equal((await kid('GET', '/api/users')).statusCode, 403);
});

test('admins manage accounts but never lock themselves out', async () => {
  const { app, call } = await loggedInApp();
  const me = (await call('GET', '/api/auth/status')).json().user;
  assert.equal(me.isAdmin, true);
  assert.equal((await call('DELETE', `/api/users/${me.id}`)).statusCode, 400);
  assert.equal((await call('PATCH', `/api/users/${me.id}`, { isAdmin: false })).statusCode, 400);

  const mom = (await call('POST', '/api/users', { username: 'mom', password: 'password123', isAdmin: true })).json().user;
  const momCall = await loginAs(app, 'mom', 'password123');
  assert.equal((await momCall('GET', '/api/users')).json().users.length, 2);

  // A password reset signs the user out.
  assert.equal((await call('PATCH', `/api/users/${mom.id}`, { password: 'newpassword1' })).statusCode, 200);
  assert.equal((await momCall('GET', '/api/users')).statusCode, 401);
  await loginAs(app, 'mom', 'newpassword1');

  assert.equal((await call('PATCH', `/api/users/${mom.id}`, { isAdmin: false })).json().user.isAdmin, false);
  assert.equal((await call('DELETE', `/api/users/${mom.id}`)).statusCode, 200);
  assert.equal((await call('GET', '/api/users')).json().users.length, 1);
});
