import type { FastifyInstance } from 'fastify';
import type { NflService } from '../nfl.js';
import type { SourceService } from '../sources.js';

/** Providers rename their event channels ("NFL 01: …") on game day, so stale playlists are re-pulled first. */
const MAX_PLAYLIST_AGE_HOURS = 3;

export async function nflRoutes(app: FastifyInstance, opts: { nfl: NflService; sources: SourceService }) {
  app.get('/api/presets/nfl', async (_req, reply) => {
    try {
      const games = await opts.nfl.games();
      if (games.some((g) => g.state !== 'post')) await opts.sources.refreshStale(MAX_PLAYLIST_AGE_HOURS);
      return { games: await opts.nfl.matches() };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message || 'NFL schedule unavailable' });
    }
  });
}
