import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import type { ChannelService } from '../channels.js';

export const TILE_COUNT = 4;

export interface Tile {
  channelId: number | null;
  muted: boolean;
}

/** A user's saved 2x2 layout. */
export function loadTiles(db: Db, userId: number): Tile[] {
  const row = db.prepare(`SELECT value FROM user_settings WHERE user_id = ? AND key = 'multiview'`).get(userId) as { value: string } | undefined;
  let saved: Partial<Tile>[] = [];
  try {
    saved = row ? JSON.parse(row.value) : [];
  } catch {
    saved = [];
  }
  return Array.from({ length: TILE_COUNT }, (_, i) => ({
    channelId: Number.isInteger(saved[i]?.channelId) ? (saved[i]!.channelId as number) : null,
    muted: saved[i]?.muted !== false,
  }));
}

/** The saved 2x2 layout per user, with channel details filled in for display. */
export async function multiviewRoutes(app: FastifyInstance, opts: { db: Db; channels: ChannelService; onChange?: (userId: number) => void }) {
  const { db, channels } = opts;
  const load = (userId: number) => loadTiles(db, userId);

  const withChannels = (tiles: Tile[]) =>
    tiles.map((t) => {
      const ch = t.channelId !== null ? channels.get(t.channelId) : null;
      return { channelId: ch ? t.channelId : null, muted: t.muted, channel: ch };
    });

  app.get('/api/multiview', async (req) => ({ tiles: withChannels(load(req.user!.id)) }));

  app.put('/api/multiview', async (req, reply) => {
    const body = req.body as { tiles?: unknown };
    if (!Array.isArray(body?.tiles) || body.tiles.length !== TILE_COUNT) return reply.code(400).send({ error: `tiles must be a list of ${TILE_COUNT}` });
    const tiles: Tile[] = body.tiles.map((t: { channelId?: unknown; muted?: unknown }) => ({
      channelId: Number.isInteger(t?.channelId) ? (t.channelId as number) : null,
      muted: t?.muted !== false,
    }));
    db.prepare(
      `INSERT INTO user_settings (user_id, key, value) VALUES (?, 'multiview', ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
    ).run(req.user!.id, JSON.stringify(tiles));
    opts.onChange?.(req.user!.id);
    return { tiles: withChannels(tiles) };
  });
}
