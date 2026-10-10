import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { mosaicArgs } from '../src/mosaic.js';
import { loggedInApp } from './helpers.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

test('mosaic args stack four boxes and take sound only from boxes with audio on', () => {
  const box = (url: string, audio: boolean) => ({ url, userAgent: 'UA', audio });
  const args = mosaicArgs([box('http://a/1', false), null, box('http://b/2', true), box('http://c/3', true)], 12.5);
  assert.equal(args.filter((a) => a === '-i').length, 3);
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /color=c=black[^;]*\[v1\]/, 'empty box is black');
  assert.match(graph, /\[1:a:0\].*\[2:a:0\].*amix=inputs=2/, 'two boxes with audio are mixed');
  assert.doesNotMatch(graph, /\[0:a:0\]/, 'muted box adds no sound');
  assert.equal(args[args.indexOf('-output_ts_offset') + 1], '12.500');
  assert.match(mosaicArgs([null, null, null, null])[mosaicArgs([null, null, null, null]).indexOf('-filter_complex') + 1], /anullsrc/);
});

test('TV link streams the multiview as one picture and skips a channel that is down', { skip: !hasFfmpeg && 'ffmpeg not installed', timeout: 90_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvmv-'));
  const src = path.join(dir, 'ch.ts');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine', '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-f', 'mpegts', src]);
  const upstream = http.createServer((req, res) => {
    if (req.url === '/down.ts') return res.writeHead(503).end();
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    fs.createReadStream(src).pipe(res);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const { app, call } = await loggedInApp();
  try {
    await call('POST', '/api/sources', { type: 'm3u_file', name: 'S', fileContent: `#EXTM3U\n#EXTINF:-1,Up\n${base}/up.ts\n#EXTINF:-1,Down\n${base}/down.ts\n` });
    const [up, down] = (await call('GET', '/api/channels')).json().items;
    await call('PUT', '/api/multiview', { tiles: [{ channelId: up.id, muted: false }, { channelId: down.id, muted: true }, { channelId: null }, { channelId: null }] });
    const links = (await call('GET', '/api/tv')).json();
    assert.match(links.playlistUrl, /\/tv\/[\w-]+\/playlist\.m3u$/);

    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const local = (u: string) => u.replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${port}`);

    const playlist = await (await fetch(local(links.playlistUrl))).text();
    assert.match(playlist, /^#EXTM3U\n#EXTINF:-1 .*,My Multiview\nhttp.*\/multiview\.ts\n$/);
    assert.equal((await fetch(local(links.playlistUrl.replace(/tv\/[^/]+/, 'tv/wrong')))).status, 404);

    // Read a couple of MB of the live stream, then hang up like a TV switching channel.
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      http.get(local(links.streamUrl), (res) => {
        assert.equal(res.headers['content-type'], 'video/mp2t');
        res.on('data', (c: Buffer) => {
          chunks.push(c);
          total += c.length;
          if (total > 1_500_000) {
            res.destroy();
            resolve(Buffer.concat(chunks));
          }
        });
        res.on('error', () => {});
      }).on('error', reject);
    });
    const out = path.join(dir, 'tv.ts');
    fs.writeFileSync(out, bytes);
    const streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', out]).toString()).streams;
    assert.deepEqual(streams.map((s: { codec_name: string }) => s.codec_name).sort(), ['aac', 'h264']);
    const video = streams.find((s: { codec_name: string }) => s.codec_name === 'h264');
    assert.deepEqual([video.width, video.height], [1920, 1080]);
  } finally {
    await app.close();
    upstream.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
