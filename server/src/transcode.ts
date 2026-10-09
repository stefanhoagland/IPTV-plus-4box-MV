import { spawn } from 'node:child_process';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { StreamProxy } from './stream.js';

/**
 * Browser-compatibility mode. Browsers only decode H.264/HEVC video with AAC/MP3 audio, but many
 * IPTV channels carry Dolby (AC-3/E-AC-3) audio or MPEG-2 video and just show black. This pipes the
 * channel through ffmpeg: video is copied when the browser can already play it (cheap) and
 * re-encoded to H.264 otherwise; audio always becomes stereo AAC. The player uses it as a fallback.
 */

export interface ProbeResult {
  video: { codec: string; width?: number; height?: number } | null;
  audio: { codec: string; channels?: number } | null;
}

const PROBE_CACHE_MS = 60 * 60 * 1000;
const BROWSER_VIDEO = new Set(['h264']);
const BROWSER_AUDIO = new Set(['aac', 'mp3']);

export function browserPlayable(p: ProbeResult): boolean {
  return (!p.video || BROWSER_VIDEO.has(p.video.codec)) && (!p.audio || BROWSER_AUDIO.has(p.audio.codec));
}

export function ffmpegArgs(url: string, userAgent: string, probe: ProbeResult | null): string[] {
  const copyVideo = probe?.video ? BROWSER_VIDEO.has(probe.video.codec) : false;
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
    const json = JSON.parse(
      await run(this.ffprobe, ['-v', 'error', ...http, '-protocol_whitelist', 'http,https,tcp,tls,crypto,hls', '-analyzeduration', '5000000', '-probesize', '5000000', '-show_entries', 'stream=codec_type,codec_name,width,height,channels', '-of', 'json', ch.url], 20_000),
    ) as { streams?: { codec_type: string; codec_name: string; width?: number; height?: number; channels?: number }[] };
    const streams = json.streams ?? [];
    const v = streams.find((s) => s.codec_type === 'video');
    const a = streams.find((s) => s.codec_type === 'audio');
    const result: ProbeResult = {
      video: v ? { codec: v.codec_name, width: v.width, height: v.height } : null,
      audio: a ? { codec: a.codec_name, channels: a.channels } : null,
    };
    this.probes.set(channelId, { at: Date.now(), result });
    return result;
  }

  /** Only http(s): ffmpeg would happily open file:// or other protocols named in a provider's playlist. */
  private channel(channelId: number) {
    const ch = this.proxy.channel(channelId);
    if (!ch) throw Object.assign(new Error('Channel not found'), { statusCode: 404 });
    if (!/^https?:\/\//i.test(ch.url)) throw Object.assign(new Error('Only http(s) streams can be converted'), { statusCode: 400 });
    return ch;
  }

  async stream(req: FastifyRequest, reply: FastifyReply, channelId: number) {
    let ch: { url: string; userAgent: string };
    try {
      ch = this.channel(channelId);
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
    // Without a probe, re-encode video to be safe; a probe failure shouldn't block playback.
    const probe = await this.probe(channelId).catch(() => null);
    const child = spawn(this.ffmpeg, ffmpegArgs(ch.url, ch.userAgent, probe), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    const spawned = await new Promise<Error | null>((resolve) => {
      child.once('spawn', () => resolve(null));
      child.once('error', (e) => resolve(e));
    });
    if (spawned) {
      const missing = (spawned as NodeJS.ErrnoException).code === 'ENOENT';
      return reply.code(missing ? 501 : 500).send({ error: missing ? 'ffmpeg is not installed on the server' : spawned.message });
    }
    child.on('close', (code) => {
      if (code && code !== 255 && stderr) req.log.warn(`ffmpeg for channel ${channelId} exited ${code}: ${stderr.trim().split('\n').pop()}`);
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

  app.get('/api/play/:id/compat', async (req, reply) => transcoder.stream(req, reply, channelId(req)));
}
