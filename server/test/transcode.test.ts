import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { browserPlayable, ffmpegArgs } from '../src/transcode.js';
import { loggedInApp } from './helpers.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

test('ffmpeg args copy browser-friendly video and always make AAC audio', () => {
  const copy = ffmpegArgs('http://x/a.m3u8', 'UA', { video: { codec: 'h264' }, audio: { codec: 'ac3' } });
  assert.deepEqual(copy.slice(copy.indexOf('-c:v'), copy.indexOf('-c:v') + 2), ['-c:v', 'copy']);
  assert.deepEqual(copy.slice(copy.indexOf('-c:a'), copy.indexOf('-c:a') + 2), ['-c:a', 'aac']);
  const encode = ffmpegArgs('http://x/a.m3u8', 'UA', { video: { codec: 'mpeg2video' }, audio: { codec: 'aac' } });
  assert.equal(encode[encode.indexOf('-c:v') + 1], 'libx264');
  assert.equal(browserPlayable({ video: { codec: 'h264' }, audio: { codec: 'aac' } }), true);
  assert.equal(browserPlayable({ video: { codec: 'h264' }, audio: { codec: 'eac3' } }), false);
  assert.equal(browserPlayable({ video: { codec: 'hevc' }, audio: null }), false);
});

test('compat mode turns an MPEG-2 + AC-3 channel into H.264 + AAC', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvmv-'));
  const src = path.join(dir, 'cable.ts');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine', '-t', '3', '-c:v', 'mpeg2video', '-c:a', 'ac3', '-f', 'mpegts', src]);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    fs.createReadStream(src).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/cable.ts`;
  try {
    const { call } = await loggedInApp();
    await call('POST', '/api/sources', { type: 'm3u_file', name: 'F', fileContent: `#EXTM3U\n#EXTINF:-1,Food Network\n${url}\n#EXTINF:-1,Local\nfile:///etc/passwd\n` });
    const [food, local] = (await call('GET', '/api/channels')).json().items;

    const probe = (await call('GET', `/api/play/${food.id}/probe`)).json();
    assert.equal(probe.video.codec, 'mpeg2video');
    assert.equal(probe.audio.codec, 'ac3');
    assert.equal(probe.browserPlayable, false);

    const res = await call('GET', `/api/play/${food.id}/compat`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'video/mp2t');
    const out = path.join(dir, 'out.ts');
    fs.writeFileSync(out, res.rawPayload);
    const streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'json', out]).toString()).streams.map((s: { codec_name: string }) => s.codec_name);
    assert.deepEqual(streams.sort(), ['aac', 'h264']);

    assert.equal((await call('GET', `/api/play/${local.id}/compat`)).statusCode, 400, 'non-http URLs are refused');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
