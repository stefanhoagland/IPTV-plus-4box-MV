import { spawn } from 'node:child_process';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { redactUrl } from './diagnostics.js';
import type { StreamProxy } from './stream.js';

/**
 * Browser-compatibility mode. Browsers only decode H.264/HEVC video with AAC/MP3 audio, but many
 * IPTV channels carry Dolby (AC-3/E-AC-3) audio or MPEG-2 video and just show black. This pipes the
 * channel through ffmpeg: video is copied when the browser can already play it (cheap) and
 * re-encoded to H.264 otherwise; audio always becomes stereo AAC. The player uses it as a fallback.
 */

export interface ProbeResult {
  video: { codec: string; width?: number; height?: number; profile?: string; pixFmt?: string } | null;
  audio: { codec: string; channels?: number } | null;
}

const PROBE_CACHE_MS = 60 * 60 * 1000;
const BROWSER_AUDIO = new Set(['aac', 'mp3']);

/** Browsers only decode 8-bit 4:2:0 H.264; High 10 / 4:2:2 / 4:4:4 broadcast feeds show black. */
function browserVideo(v: NonNullable<ProbeResult['video']>): boolean {
  if (v.codec !== 'h264') return false;
  if (v.pixFmt && !/^yuvj?420p$/.test(v.pixFmt)) return false;
  return !v.profile || !/10|4:2:2|4:4:4/.test(v.profile);
}

export function browserPlayable(p: ProbeResult): boolean {
  return (!p.video || browserVideo(p.video)) && (!p.audio || BROWSER_AUDIO.has(p.audio.codec));
}

/** `reencode`: always re-encode the video, for pictures that stay black even when the codec looks fine. */
export function ffmpegArgs(url: string, userAgent: string, probe: ProbeResult | null, reencode = false): string[] {
  const copyVideo = !reencode && probe?.video ? browserVideo(probe.video) : false;
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-user_agent', userAgent, '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    // Only follow http(s)/HLS-related protocols from the playlist.
    '-protocol_whitelist', 'http,https,tcp,tls,crypto,hls',
    '-fflags', '+genpts+discardcorrupt',
    '-i', url,
    '-map', '0:v:0?', '-map', '0:a:0?',
    ...(copyVideo
      ? ['-c:v', 'copy']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '23', '-g', '50', '-pix_fmt', 'yuv420p', '-vf', "yadif=deint=interlaced,scale=-2:'min(720,ih)'"]),
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-f', 'mpegts', 'pipe:1',
  ];
}

const secs = (since: number) => `${((Date.now() - since) / 1000).toFixed(1)}s`;

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject((e as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`${cmd} is not installed`) : e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().split('\n').pop() || `${cmd} exited with code ${code}`));
    });
  });
}

export class Transcoder {
  private probes = new Map<number, { at: number; result: ProbeResult }>();

  constructor(
    private proxy: StreamProxy,
    private ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg',
    private ffprobe = process.env.FFPROBE_PATH || 'ffprobe',
  ) {}

  async probe(channelId: number): Promise<ProbeResult> {
    const cached = this.probes.get(channelId);
    if (cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached.result;
    const ch = this.channel(channelId);
    const http = ['-user_agent', ch.userAgent];
    const started = Date.now();
    const output = await run(this.ffprobe, ['-v', 'error', ...http, '-protocol_whitelist', 'http,https,tcp,tls,crypto,hls', '-analyzeduration', '5000000', '-probesize', '5000000', '-show_entries', 'stream=codec_type,codec_name,width,height,channels,profile,pix_fmt', '-of', 'json', ch.url], 20_000).catch((err: Error) => {
      // ffprobe quotes the URL in its errors; keep account credentials out of logs and the UI.
      const message = err.message.split(ch.url).join(redactUrl(ch.url));
      this.proxy.diag.note(channelId, `ffprobe failed after ${secs(started)}: ${message}`);
      throw new Error(message);
    });
    const json = JSON.parse(output) as { streams?: { codec_type: string; codec_name: string; width?: number; height?: number; channels?: number; profile?: string; pix_fmt?: string }[] };
    const streams = json.streams ?? [];
    const v = streams.find((s) => s.codec_type === 'video');
    const a = streams.find((s) => s.codec_type === 'audio');
    const result: ProbeResult = {
      video: v ? { codec: v.codec_name, width: v.width, height: v.height, profile: v.profile, pixFmt: v.pix_fmt } : null,
      audio: a ? { codec: a.codec_name, channels: a.channels } : null,
    };
    this.probes.set(channelId, { at: Date.now(), result });
    const v2 = result.video;
    this.proxy.diag.note(
      channelId,
      `ffprobe (${secs(started)}): video ${v2 ? [v2.codec, v2.profile, v2.pixFmt, v2.width && `${v2.width}x${v2.height}`].filter(Boolean).join(' ') : 'none'}, audio ${result.audio ? `${result.audio.codec} ${result.audio.channels ?? '?'}ch` : 'none'}`,
    );
    return result;
  }

  proxyChannel(channelId: number) {
    return this.proxy.channel(channelId);
  }

  events(channelId: number) {
    return this.proxy.diag.get(channelId);
  }

  /** Only http(s): ffmpeg would happily open file:// or other protocols named in a provider's playlist. */
  private channel(channelId: number) {
    const ch = this.proxy.channel(channelId);
    if (!ch) throw Object.assign(new Error('Channel not found'), { statusCode: 404 });
    if (!/^https?:\/\//i.test(ch.url)) throw Object.assign(new Error('Only http(s) streams can be converted'), { statusCode: 400 });
    return ch;
  }

  async stream(req: FastifyRequest, reply: FastifyReply, channelId: number, reencode = false) {
    let ch: { url: string; userAgent: string };
    try {
      ch = this.channel(channelId);
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
    const note = (msg: string) => {
      this.proxy.diag.note(channelId, msg);
      req.log.info(`channel ${channelId}: ${msg}`);
    };
    const started = Date.now();
    // Forced re-encoding needs no probe, which saves a provider connection and several seconds.
    // Without a probe, re-encode video to be safe; a probe failure shouldn't block playback.
    const probe = reencode ? null : await this.probe(channelId).catch(() => null);
    const args = ffmpegArgs(ch.url, ch.userAgent, probe, reencode);
    note(`ffmpeg starting (${args[args.indexOf('-c:v') + 1] === 'copy' ? 'copy video' : 're-encode video'}, AAC audio)`);
    const child = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-2000);
      for (const line of String(d).split('\n').filter((l) => l.trim()).slice(0, 5)) note(`ffmpeg: ${line.split(ch.url).join(redactUrl(ch.url)).trim().slice(0, 300)}`);
    });
    let bytes = 0;
    child.stdout.on('data', (d: Buffer) => {
      if (bytes === 0) note(`ffmpeg sending video after ${secs(started)}`);
      bytes += d.length;
    });
    const spawned = await new Promise<Error | null>((resolve) => {
      child.once('spawn', () => resolve(null));
      child.once('error', (e) => resolve(e));
    });
    if (spawned) {
      const missing = (spawned as NodeJS.ErrnoException).code === 'ENOENT';
      return reply.code(missing ? 501 : 500).send({ error: missing ? 'ffmpeg is not installed on the server' : spawned.message });
    }
    child.on('close', (code, signal) => {
      note(`ffmpeg stopped after ${secs(started)} (${signal ?? `exit ${code}`}), sent ${(bytes / 1e6).toFixed(1)} MB`);
      if (code && code !== 255 && stderr) req.log.warn(`ffmpeg for channel ${channelId} exited ${code}: ${stderr.split(ch.url).join(redactUrl(ch.url)).trim().split('\n').pop()}`);
    });
    // Stop ffmpeg (and the provider connection) as soon as the viewer goes away.
    reply.raw.on('close', () => child.kill('SIGKILL'));
    return reply.header('content-type', 'video/mp2t').header('cache-control', 'no-cache').send(child.stdout);
  }
}

export async function transcodeRoutes(app: FastifyInstance, opts: { transcoder: Transcoder }) {
  const { transcoder } = opts;
  const channelId = (req: FastifyRequest) => Number((req.params as { id: string }).id);

  app.get('/api/play/:id/probe', async (req, reply) => {
    try {
      const result = await transcoder.probe(channelId(req));
      return { ...result, browserPlayable: browserPlayable(result) };
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      return reply.code(e.statusCode ?? 502).send({ error: `Could not inspect the stream: ${e.message}` });
    }
  });

  /** What happened recently with this channel, for the box's Details panel. */
  app.get('/api/play/:id/diagnostics', async (req, reply) => {
    const id = channelId(req);
    const ch = transcoder.proxyChannel(id);
    if (!ch) return reply.code(404).send({ error: 'Channel not found' });
    return { channel: { id, name: ch.name, source: ch.source, url: redactUrl(ch.url), userAgent: ch.userAgent }, events: transcoder.events(id) };
  });

  app.get('/api/play/:id/compat', async (req, reply) => {
    const reencode = (req.query as { reencode?: string }).reencode === '1';
    return transcoder.stream(req, reply, channelId(req), reencode);
  });
}
