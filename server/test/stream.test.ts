import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewritePlaylist } from '../src/stream.js';
import { fakeFetch, loggedInApp } from './helpers.js';

test('rewritePlaylist resolves relative URIs and rewrites tag URIs', () => {
  const out = rewritePlaylist(
    ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"', '#EXT-X-MAP:URI="data:abc"', '#EXTINF:6,', 'seg1.ts', '/abs/seg2.ts', 'http://other/seg3.ts'].join('\n'),
    'http://host/live/ch/index.m3u8?token=1',
    (abs) => `P(${abs})`,
  );
  assert.equal(
    out,
    [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="P(http://host/live/ch/key.bin)"',
      '#EXT-X-MAP:URI="data:abc"',
      '#EXTINF:6,',
      'P(http://host/live/ch/seg1.ts)',
      'P(http://host/abs/seg2.ts)',
      'P(http://other/seg3.ts)',
    ].join('\n'),
  );
});

test('play endpoint proxies the playlist chain with signed links and the source user agent', async () => {
  const { fn, calls } = fakeFetch({
    'http://provider/list.m3u': '#EXTM3U\n#EXTINF:-1 group-title="News",News\nhttp://cdn/news/master.m3u8\n',
    'http://cdn/news/master.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow/index.m3u8\n',
    'http://cdn/news/low/index.m3u8': '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg1.ts\n',
    'http://cdn/news/low/seg1.ts': 'TSBYTES',
  });
  const { call } = await loggedInApp({ fetch: fn });
  await call('POST', '/api/sources', { type: 'm3u_url', name: 'P', url: 'http://provider/list.m3u', userAgent: 'TiviMate/4' });
  const channelId = (await call('GET', '/api/channels')).json().items[0].id;

  const master = await call('GET', `/api/play/${channelId}`);
  assert.equal(master.statusCode, 200);
  assert.equal(master.headers['content-type'], 'application/vnd.apple.mpegurl');
  const variantLink = master.body.split('\n')[2];
  assert.match(variantLink, new RegExp(`^/api/play/${channelId}/r\\?u=`));

  const media = await call('GET', variantLink);
  assert.equal(media.statusCode, 200);
  const segLink = media.body.trim().split('\n').at(-1)!;

  const seg = await call('GET', segLink);
  assert.equal(seg.statusCode, 200);
  assert.equal(seg.body, 'TSBYTES');
  assert.deepEqual(calls.slice(1).map((c) => c.userAgent), ['TiviMate/4', 'TiviMate/4', 'TiviMate/4']);

  // Tampered links are refused, so the proxy can't be pointed at arbitrary URLs.
  const tampered = segLink.replace(/u=[^&]+/, `u=${Buffer.from('http://169.254.169.254/').toString('base64url')}`);
  assert.equal((await call('GET', tampered)).statusCode, 403);
  assert.equal((await call('GET', '/api/play/999')).statusCode, 404);
});

test('upstream failures become 502s', async () => {
  const { fn } = fakeFetch({ 'http://provider/list.m3u': '#EXTM3U\n#EXTINF:-1,Dead\nhttp://cdn/dead.m3u8\n' });
  const { call } = await loggedInApp({ fetch: fn });
  await call('POST', '/api/sources', { type: 'm3u_url', name: 'P', url: 'http://provider/list.m3u' });
  const id = (await call('GET', '/api/channels')).json().items[0].id;
  const res = await call('GET', `/api/play/${id}`);
  assert.equal(res.statusCode, 502);
  assert.match(res.json().error, /HTTP 404/);
});

test('multiview layout is saved per user with channel details', async () => {
  const { call } = await loggedInApp();
  await call('POST', '/api/sources', { type: 'm3u_file', name: 'F', fileContent: '#EXTM3U\n#EXTINF:-1 group-title="G",One\nhttp://x/1.m3u8\n' });
  const id = (await call('GET', '/api/channels')).json().items[0].id;

  const empty = (await call('GET', '/api/multiview')).json();
  assert.deepEqual(empty.tiles.map((t: { channelId: number | null; muted: boolean }) => [t.channelId, t.muted]), [
    [null, true],
    [null, true],
    [null, true],
    [null, true],
  ]);

  const saved = await call('PUT', '/api/multiview', {
    tiles: [{ channelId: id, muted: false }, { channelId: 12345, muted: true }, { channelId: null, muted: true }, {}],
  });
  assert.equal(saved.statusCode, 200);
  const tiles = (await call('GET', '/api/multiview')).json().tiles;
  assert.equal(tiles[0].channelId, id);
  assert.equal(tiles[0].muted, false);
  assert.equal(tiles[0].channel.name, 'One');
  assert.equal(tiles[1].channelId, null, 'unknown channels are dropped');
  assert.equal((await call('PUT', '/api/multiview', { tiles: [] })).statusCode, 400);
});

test('raw MPEG-TS channels are piped, or refused with 415 when the HLS player asks', async () => {
  const { fn } = fakeFetch({
    'http://provider/list.m3u': '#EXTM3U\n#EXTINF:-1,Raw\nhttp://cdn/raw/stream\n#EXTINF:-1,Odd\nhttp://cdn/get?id=1\n',
    'http://cdn/raw/stream': 'G\u0000TSDATA',
    'http://cdn/get?id=1': '#EXTM3U\n#EXTINF:6,\nseg.ts\n',
  });
  const { call } = await loggedInApp({ fetch: fn });
  await call('POST', '/api/sources', { type: 'm3u_url', name: 'P', url: 'http://provider/list.m3u' });
  const [raw, odd] = (await call('GET', '/api/channels')).json().items;

  assert.equal((await call('GET', `/api/play/${raw.id}?as=hls`)).statusCode, 415);
  const piped = await call('GET', `/api/play/${raw.id}`);
  assert.equal(piped.statusCode, 200);
  assert.equal(piped.body, 'G\u0000TSDATA');

  // A playlist without .m3u8 in the URL or an HLS content type is still recognised.
  const playlist = await call('GET', `/api/play/${odd.id}?as=hls`);
  assert.equal(playlist.statusCode, 200);
  assert.match(playlist.body, new RegExp(`/api/play/${odd.id}/r\\?u=`));
});
