import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, loggedInApp } from './helpers.js';

const playlist = (extra = '') => `#EXTM3U
#EXTINF:-1 tvg-id="news.1" tvg-logo="http://l/news.png" group-title="News",News One
http://iptv/stream/news1.m3u8?token=a
#EXTINF:-1 tvg-id="sport.1" group-title="Sports",Sport One
http://iptv/stream/sport1.m3u8?token=a
#EXTINF:-1 group-title="Sports",Sport Two
http://iptv/stream/sport2.m3u8?token=a
${extra}`;

test('admin API requires login', async () => {
  const { app } = await loggedInApp();
  assert.equal((await app.inject({ url: '/api/sources' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/channels' })).statusCode, 401);
});

test('M3U URL source imports channels and refresh keeps edits', async () => {
  let body = playlist();
  const { fn, calls } = fakeFetch({ 'http://provider/list.m3u': () => body });
  const { call } = await loggedInApp({ fetch: fn });

  const created = await call('POST', '/api/sources', { type: 'm3u_url', name: 'Provider', url: 'http://provider/list.m3u' });
  assert.equal(created.statusCode, 201);
  const source = created.json();
  assert.equal(source.channelCount, 3);
  assert.equal(source.lastError, null);
  assert.equal(calls[0].userAgent, 'VLC/3.0.20 LibVLC/3.0.20');

  const list = (await call('GET', '/api/channels')).json();
  assert.equal(list.total, 3);
  assert.deepEqual(list.items.map((c: { name: string }) => c.name), ['News One', 'Sport One', 'Sport Two']);
  assert.equal(list.items[0].logo, 'http://l/news.png');
  assert.equal('streamUrl' in list.items[0], false, 'stream URLs (with credentials) are not exposed in listings');

  const news = list.items[0];
  const sport2 = list.items[2];
  await call('PATCH', `/api/channels/${news.id}`, { customName: 'My News', number: 5 });
  await call('PATCH', `/api/channels/${sport2.id}`, { enabled: false, number: 1 });

  // Provider rotates tokens, renames nothing, drops Sport One and adds a new channel.
  body = playlist('#EXTINF:-1 group-title="Kids",Cartoons\nhttp://iptv/stream/kids.m3u8?token=b')
    .replace(/token=a/g, 'token=b')
    .replace(/#EXTINF:-1 tvg-id="sport.1"[^\n]*\n[^\n]*\n/, '');
  const refreshed = (await call('POST', `/api/sources/${source.id}/refresh`)).json();
  assert.equal(refreshed.channelCount, 3);

  const after = (await call('GET', '/api/channels')).json();
  assert.deepEqual(
    after.items.map((c: { name: string; number: number | null; enabled: boolean }) => [c.name, c.number, c.enabled]),
    [
      ['Sport Two', 1, false],
      ['My News', 5, true],
      ['Cartoons', null, true],
    ],
  );
  assert.equal(after.items[1].id, news.id, 'channel identity survives refresh');
});

test('failed refresh is recorded on the source, not thrown', async () => {
  const { fn } = fakeFetch({});
  const { call } = await loggedInApp({ fetch: fn });
  const res = await call('POST', '/api/sources', { type: 'm3u_url', name: 'Broken', url: 'http://nowhere/list.m3u' });
  assert.equal(res.statusCode, 201);
  assert.match(res.json().lastError, /HTTP 404/);
});

test('Xtream source builds HLS URLs and never returns the password', async () => {
  const { fn, calls } = fakeFetch({
    'http://xt.example:8080/player_api.php?username=me&password=s%26cret&action=get_live_categories': [{ category_id: '7', category_name: 'Movies' }],
    'http://xt.example:8080/player_api.php?username=me&password=s%26cret&action=get_live_streams': [
      { stream_id: 101, name: 'Film 1', stream_icon: 'http://i/1.png', epg_channel_id: 'film1', category_id: '7' },
      { stream_id: 102, name: 'Other', category_id: null },
    ],
  });
  const { call } = await loggedInApp({ fetch: fn });
  const res = await call('POST', '/api/sources', {
    type: 'xtream',
    name: 'XT',
    url: 'http://xt.example:8080/',
    username: 'me',
    password: 's&cret',
    userAgent: 'MyPlayer/1.0',
  });
  const source = res.json();
  assert.equal(source.channelCount, 2, JSON.stringify(source));
  assert.equal(source.hasPassword, true);
  assert.equal('password' in source, false);
  assert.equal(calls[0].userAgent, 'MyPlayer/1.0');

  const groups = (await call('GET', '/api/channels/groups')).json();
  assert.deepEqual(groups, [
    { name: 'Movies', total: 1, enabled: 1 },
    { name: null, total: 1, enabled: 1 },
  ]);

  // Editing without a password keeps the saved one.
  const edited = (await call('PATCH', `/api/sources/${source.id}`, { name: 'Renamed', password: '' })).json();
  assert.equal(edited.name, 'Renamed');
  assert.equal(edited.hasPassword, true);
});

test('uploaded M3U file source, group bulk hide, filters and delete', async () => {
  const { call } = await loggedInApp();
  const res = await call('POST', '/api/sources', { type: 'm3u_file', name: 'Upload', fileContent: playlist() });
  const source = res.json();
  assert.equal(source.channelCount, 3);

  const bulk = (await call('POST', '/api/channels/bulk', { enabled: false, filter: { group: 'Sports' } })).json();
  assert.equal(bulk.changed, 2);
  assert.equal((await call('GET', '/api/channels?enabled=true')).json().total, 1);
  assert.equal((await call('GET', '/api/channels?search=sport')).json().total, 2);
  assert.equal((await call('GET', '/api/channels?group=News')).json().total, 1);

  assert.equal((await call('PATCH', '/api/channels/1', { customLogo: 'javascript:alert(1)' })).statusCode, 400);
  assert.equal((await call('PATCH', '/api/channels/1', { number: 1.5 })).statusCode, 400);

  assert.equal((await call('DELETE', `/api/sources/${source.id}`)).statusCode, 200);
  assert.equal((await call('GET', '/api/channels')).json().total, 0);
});

test('source validation', async () => {
  const { call } = await loggedInApp();
  assert.equal((await call('POST', '/api/sources', { type: 'm3u_url', name: 'x', url: 'ftp://bad' })).statusCode, 400);
  assert.equal((await call('POST', '/api/sources', { type: 'xtream', name: 'x', url: 'http://a' })).statusCode, 400);
  assert.equal((await call('POST', '/api/sources', { type: 'm3u_file', name: 'x' })).statusCode, 400);
  assert.equal((await call('POST', '/api/sources', { type: 'm3u_url', url: 'http://a' })).statusCode, 400);
});
