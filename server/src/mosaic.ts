import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.js';
import { redactUrl } from './diagnostics.js';
import { loadTiles, type Tile } from './routes/multiview.js';
import type { StreamProxy } from './stream.js';

/**
 * "Watch on TV": a user's four boxes combined by ffmpeg into one MPEG-TS stream, so any TV player
 * (TiviMate, VLC, an Apple TV / Roku / Fire Stick IPTV app) can show the multiview as a single channel.
 * Audio comes from the boxes whose audio is on. The stream follows layout changes made in the web app.
 * TV apps can't log in, so the stream sits behind a private per-user link instead of the session cookie.
 */

export interface MosaicInput {
  url: string;
  userAgent: string;
  /** Include this box's sound. */
  audio: boolean;
}

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 25;
/** How long a channel that broke the stream is left out before trying it again. */
const FAILED_INPUT_MS = 60_000;
/** Wait for quick successive box changes before restarting ffmpeg. */
const LAYOUT_DEBOUNCE_MS = 1500;

/** ffmpeg arguments for a 2x2 mosaic; `null` boxes are black. */
export function mosaicArgs(boxes: (MosaicInput | null)[], tsOffsetSeconds = 0): string[] {
  const w = WIDTH / 2;
  const h = HEIGHT / 2;
  const inputs: string[] = [];
  const filters: string[] = [];
  const sounds: string[] = [];
  let n = 0;
  boxes.forEach((box, i) => {
    if (!box) {
      filters.push(`color=c=black:s=${w}x${h}:r=${FPS},format=yuv420p[v${i}]`);
      return;
    }
    inputs.push(
      '-user_agent', box.userAgent,
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-rw_timeout', '15000000',
      '-protocol_whitelist', 'http,https,tcp,tls,crypto,hls',
      '-thread_queue_size', '1024', '-fflags', '+genpts+discardcorrupt',
      '-i', box.url,
    );
    filters.push(
      `[${n}:v:0]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p[v${i}]`,
    );
    if (box.audio) {
      filters.push(`[${n}:a:0]aresample=async=1:first_pts=0,aformat=sample_rates=48000:channel_layouts=stereo[a${sounds.length}]`);
      sounds.push(`[a${sounds.length}]`);
    }
    n++;
  });
  filters.push(`[v0][v1][v2][v3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[vout]`);
  if (sounds.length === 0) filters.push('anullsrc=r=48000:cl=stereo[aout]');
  else if (sounds.length === 1) filters.push(`${sounds[0]}anull[aout]`);
  else filters.push(`${sounds.join('')}amix=inputs=${sounds.length}:normalize=0[aout]`);

  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-b:v', '6M', '-maxrate', '6M', '-bufsize', '12M', '-g', String(FPS * 2),
    '-c:a', 'aac', '-b:a', '160k',
    // Keep timestamps moving forward across restarts, so players don't stall when the boxes change.
    '-output_ts_offset', tsOffsetSeconds.toFixed(3),
    '-f', 'mpegts', 'pipe:1',
  ];
}

export class MosaicService {
  private changes = new EventEmitter();

  constructor(
    private db: Db,
    private proxy: StreamProxy,
    private ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg',
  ) {
    this.changes.setMaxListeners(0);
  }

  layoutChanged(userId: number) {
    this.changes.emit(String(userId));
  }

  /** The user's private TV link token, created on first use. */
  token(userId: number, reset = false): string {
    const row = this.db.prepare(`SELECT value FROM user_settings WHERE user_id = ? AND key = 'tvToken'`).get(userId) as { value: string } | undefined;
    if (row && !reset) return row.value;
    const token = crypto.randomBytes(18).toString('base64url');
    this.db
      .prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?, 'tvToken', ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`)
      .run(userId, token);
    return token;
  }

  userForToken(token: string): number | null {
    const row = this.db.prepare(`SELECT user_id FROM user_settings WHERE key = 'tvToken' AND value = ?`).get(token) as { user_id: number } | undefined;
    return row?.user_id ?? null;
  }

  private boxes(userId: number, skip: Map<number, number>): { tiles: Tile[]; boxes: (MosaicInput | null)[] } {
    const tiles = loadTiles(this.db, userId);
    const now = Date.now();
    const boxes = tiles.map((t) => {
      if (t.channelId === null || (skip.get(t.channelId) ?? 0) > now) return null;
      const ch = this.proxy.channel(t.channelId);
      if (!ch || !/^https?:\/\//i.test(ch.url)) return null;
      return { url: ch.url, userAgent: ch.userAgent, audio: !t.muted };
    });
    return { tiles, boxes };
  }

  stream(req: FastifyRequest, reply: FastifyReply, userId: number) {
    const out = new PassThrough();
    const startedAt = Date.now();
    const skip = new Map<number, number>();
    let child: ChildProcess | null = null;
    let stopped = false;
    let quickFailures = 0;
    let layoutTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const stopChild = () => {
      if (!child) return;
      child.stdout?.unpipe(out);
      child.kill('SIGKILL');
      child = null;
    };

    const start = () => {
      if (stopped) return;
      const { tiles, boxes } = this.boxes(userId, skip);
      req.log.info(`TV stream for user ${userId}: showing ${boxes.filter(Boolean).length} box(es)`);
      const proc = spawn(this.ffmpeg, mosaicArgs(boxes, (Date.now() - startedAt) / 1000), { stdio: ['ignore', 'pipe', 'pipe'] });
      child = proc;
      const ranFrom = Date.now();
      let stderr = '';
      proc.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
      proc.stdout!.pipe(out, { end: false });
      proc.on('error', (err) => {
        req.log.error(`TV stream: could not start ffmpeg: ${err.message}`);
        stop();
      });
      proc.on('close', (code) => {
        if (stopped || child !== proc) return;
        child = null;
        // A channel that won't open (offline, out of connections) would take the whole picture down:
        // leave it black for a while and carry on with the rest.
        tiles.forEach((t, i) => {
          if (t.channelId !== null && boxes[i] && stderr.includes(boxes[i]!.url)) skip.set(t.channelId, Date.now() + FAILED_INPUT_MS);
        });
        const quick = Date.now() - ranFrom < 30_000;
        quickFailures = quick ? quickFailures + 1 : 0;
        const message = boxes.reduce((m, b) => (b ? m.split(b.url).join(redactUrl(b.url)) : m), stderr.trim().split('\n').slice(-2).join(' | '));
        req.log.warn(`TV stream for user ${userId}: ffmpeg exited ${code}: ${message}`);
        if (quickFailures > 10) return stop();
        retryTimer = setTimeout(start, Math.min(1000 * quickFailures, 10_000));
      });
    };

    const onLayout = () => {
      clearTimeout(layoutTimer);
      layoutTimer = setTimeout(() => {
        req.log.info(`TV stream for user ${userId}: boxes changed, switching picture`);
        skip.clear();
        quickFailures = 0;
        clearTimeout(retryTimer);
        stopChild();
        start();
      }, LAYOUT_DEBOUNCE_MS);
    };

    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(layoutTimer);
      clearTimeout(retryTimer);
      this.changes.off(String(userId), onLayout);
      stopChild();
      out.end();
    };

    this.changes.on(String(userId), onLayout);
    reply.raw.on('close', stop);
    start();
    return reply.header('content-type', 'video/mp2t').header('cache-control', 'no-cache').send(out);
  }
}

export async function mosaicRoutes(app: FastifyInstance, opts: { mosaic: MosaicService }) {
  const { mosaic } = opts;
  const origin = (req: FastifyRequest) => `${req.protocol}://${req.host}`;
  const links = (req: FastifyRequest, token: string) => ({
    playlistUrl: `${origin(req)}/tv/${token}/playlist.m3u`,
    streamUrl: `${origin(req)}/tv/${token}/multiview.ts`,
  });

  app.get('/api/tv', async (req) => links(req, mosaic.token(req.user!.id)));
  app.post('/api/tv/reset', async (req) => links(req, mosaic.token(req.user!.id, true)));

  const userFor = (req: FastifyRequest, reply: FastifyReply) => {
    const userId = mosaic.userForToken((req.params as { token: string }).token);
    if (userId === null) void reply.code(404).send({ error: 'This TV link is no longer valid' });
    return userId;
  };

  app.get('/tv/:token/playlist.m3u', async (req, reply) => {
    if (userFor(req, reply) === null) return reply;
    const { streamUrl } = links(req, (req.params as { token: string }).token);
    return reply
      .header('content-type', 'audio/x-mpegurl')
      .send(`#EXTM3U\n#EXTINF:-1 tvg-id="iptv-multiview" tvg-logo="${origin(req)}/icon.svg" group-title="Multiview",My Multiview\n${streamUrl}\n`);
  });

  app.get('/tv/:token/multiview.ts', async (req, reply) => {
    const userId = userFor(req, reply);
    if (userId === null) return reply;
    return mosaic.stream(req, reply, userId);
  });
}

