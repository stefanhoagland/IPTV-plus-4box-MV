import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.js';
import { DEFAULT_USER_AGENT } from './sources.js';
import { Diagnostics, describePlaylist, redactUrl } from './diagnostics.js';

/**
 * Same-origin stream proxy for the multiview player.
 *
 * Browsers can't play most IPTV streams directly (no CORS headers, mixed http/https,
 * credentials in URLs), so the player always goes through here:
 *   GET /api/play/:id            -> the channel's stream URL (playlist rewritten, or bytes piped;
 *                                   with ?as=hls a non-playlist answers 415 so the player can switch to mpegts.js)
 *   GET /api/play/:id/r?u=&s=    -> any URL referenced by that playlist (variants, segments, keys)
 * Referenced URLs are HMAC-signed so the proxy only fetches what an upstream playlist pointed at.
 */

const UPSTREAM_TIMEOUT_MS = 20_000;
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'];

export function isPlaylist(url: string, contentType: string | null): boolean {
  const ct = (contentType ?? '').toLowerCase();
  return ct.includes('mpegurl') || /\.m3u8?($|\?)/i.test(new URL(url).pathname);
}

export function rewritePlaylist(text: string, baseUrl: string, link: (absolute: string) => string): string {
  const abs = (ref: string) => new URL(ref, baseUrl).toString();
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        // URI="..." inside tags such as EXT-X-KEY, EXT-X-MEDIA, EXT-X-MAP, EXT-X-I-FRAME-STREAM-INF.
        return line.replace(/URI="([^"]+)"/g, (_m, ref: string) => `URI="${ref.startsWith('data:') ? ref : link(abs(ref))}"`);
      }
      return link(abs(trimmed));
    })
    .join('\n');
}

export class StreamProxy {
  private secret = crypto.randomBytes(32);

  constructor(
    private db: Db,
    private fetchFn: typeof fetch = fetch,
    readonly diag = new Diagnostics(),
  ) {}

  sign(channelId: number, url: string): string {
    return crypto.createHmac('sha256', this.secret).update(`${channelId}\n${url}`).digest('base64url').slice(0, 32);
  }

  verify(channelId: number, url: string, sig: string): boolean {
    const expected = Buffer.from(this.sign(channelId, url));
    const given = Buffer.from(sig);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  }

  link(channelId: number, url: string): string {
    return `/api/play/${channelId}/r?u=${Buffer.from(url).toString('base64url')}&s=${this.sign(channelId, url)}`;
  }

  channel(id: number): { url: string; userAgent: string; name: string; source: string } | null {
    const row = this.db
      .prepare(
        'SELECT c.stream_url, COALESCE(c.custom_name, c.name) AS name, s.name AS source, s.user_agent FROM channels c JOIN sources s ON s.id = c.source_id WHERE c.id = ?',
      )
      .get(id) as { stream_url: string; name: string; source: string; user_agent: string | null } | undefined;
    return row ? { url: row.stream_url, userAgent: row.user_agent || DEFAULT_USER_AGENT, name: row.name, source: row.source } : null;
  }

  async proxy(req: FastifyRequest, reply: FastifyReply, channelId: number, url: string, userAgent: string, opts: { expectPlaylist?: boolean; logPlaylist?: boolean } = {}) {
    const abort = new AbortController();
    // Stop pulling from the provider as soon as the player goes away (channel change, tab closed).
    reply.raw.on('close', () => abort.abort());
    const timeout = setTimeout(() => abort.abort(), UPSTREAM_TIMEOUT_MS);

    const headers: Record<string, string> = { 'User-Agent': userAgent };
    if (req.headers.range) headers.Range = req.headers.range;

    const note = (msg: string) => this.diag.note(channelId, `${redactUrl(url)}: ${msg}`);
    let upstream: Response;
    try {
      upstream = await this.fetchFn(url, { headers, signal: abort.signal, redirect: 'follow' });
    } catch (err) {
      clearTimeout(timeout);
      if (abort.signal.aborted && reply.raw.destroyed) return reply.hijack();
      const cause = (err as Error & { cause?: Error }).cause?.message;
      note(`could not connect: ${(err as Error).message}${cause ? ` (${cause})` : ''}`);
      return reply.code(502).send({ error: `Could not reach the stream: ${(err as Error).message}` });
    }

    if (!upstream.ok && upstream.status !== 206) {
      clearTimeout(timeout);
      void upstream.body?.cancel();
      note(`provider answered HTTP ${upstream.status}`);
      return reply.code(502).send({ error: `Stream server returned HTTP ${upstream.status}` });
    }

    const finalUrl = upstream.url || url;
    if (!upstream.body) {
      clearTimeout(timeout);
      return reply.code(502).send({ error: 'Stream server sent an empty response' });
    }

    // Sniff the first bytes: content types and file extensions from IPTV servers are unreliable.
    const reader = upstream.body.getReader();
    let first: Uint8Array | undefined;
    try {
      first = (await reader.read()).value;
    } catch (err) {
      clearTimeout(timeout);
      if (reply.raw.destroyed) return reply.hijack();
      note(`stream stopped: ${(err as Error).message}`);
      return reply.code(502).send({ error: `Stream stopped: ${(err as Error).message}` });
    }
    const head = first ? Buffer.from(first.subarray(0, 32)).toString('utf8').replace(/^\uFEFF/, '').trimStart() : '';

    if (head.startsWith('#EXTM3U') || (isPlaylist(finalUrl, upstream.headers.get('content-type')) && head.startsWith('#'))) {
      const chunks: Uint8Array[] = first ? [first] : [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
      } finally {
        clearTimeout(timeout);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (opts.logPlaylist) note(describePlaylist(text));
      return reply
        .header('content-type', 'application/vnd.apple.mpegurl')
        .header('cache-control', 'no-cache')
        .send(rewritePlaylist(text, finalUrl, (abs) => this.link(channelId, abs)));
    }

    clearTimeout(timeout);
    if (opts.expectPlaylist) {
      note(`raw stream (${upstream.headers.get('content-type') ?? 'no content type'}), switching to the MPEG-TS player`);
      // The HLS player asked, but this is a raw stream (usually continuous MPEG-TS): tell it to switch players.
      void reader.cancel();
      return reply.code(415).send({ error: 'Not an HLS playlist' });
    }

    // Segment, key or a continuous MPEG-TS stream: pipe bytes straight through.
    reply.code(upstream.status);
    for (const h of PASS_HEADERS) {
      const v = upstream.headers.get(h);
      // fetch() has already decompressed the body, so a compressed length would be wrong.
      if (v && !(h === 'content-length' && upstream.headers.has('content-encoding'))) reply.header(h, v);
    }
    const body = Readable.from(
      (async function* () {
        if (first) yield first;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      })(),
    );
    body.on('close', () => void reader.cancel().catch(() => {}));
    return reply.send(body);
  }
}

export async function streamRoutes(app: FastifyInstance, opts: { proxy: StreamProxy }) {
  const { proxy } = opts;

  app.get('/api/play/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const ch = Number.isInteger(id) ? proxy.channel(id) : null;
    if (!ch) return reply.code(404).send({ error: 'Channel not found' });
    const { as } = req.query as { as?: string };
    return proxy.proxy(req, reply, id, ch.url, ch.userAgent, { expectPlaylist: as === 'hls', logPlaylist: true });
  });

  app.get('/api/play/:id/r', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { u, s } = req.query as { u?: string; s?: string };
    if (!u || !s) return reply.code(400).send({ error: 'Missing parameters' });
    const url = Buffer.from(u, 'base64url').toString();
    if (!proxy.verify(id, url, s)) return reply.code(403).send({ error: 'Invalid link' });
    const ch = proxy.channel(id);
    if (!ch) return reply.code(404).send({ error: 'Channel not found' });
    // Log variant playlists once in a while, not every live refresh.
    const isVariant = /\.m3u8?($|\?)/i.test(url) && !proxy.diag.get(id).some((e) => e.includes(redactUrl(url)));
    return proxy.proxy(req, reply, id, url, ch.userAgent, { logPlaylist: isVariant });
  });
}
