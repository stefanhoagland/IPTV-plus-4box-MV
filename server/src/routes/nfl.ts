import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ScoreboardService } from '../nfl.js';
import type { SourceService } from '../sources.js';

/** Providers rename their event channels ("NFL 01: …") on game day, so stale playlists are re-pulled first. */
const MAX_PLAYLIST_AGE_HOURS = 3;

/** GET /api/presets/nfl, /api/presets/ncaab: today's games matched to channels. */
export async function sportsRoutes(app: FastifyInstance, opts: { leagues: Record<string, ScoreboardService>; sources: SourceService }) {
  app.get('/api/presets/:league', async (req: FastifyRequest<{ Params: { league: string } }>, reply) => {
    const service = opts.leagues[req.params.league];
    if (!service) return reply.code(404).send({ error: 'Unknown preset' });
    try {
      const games = await service.games();
      if (games.some((g) => g.state !== 'post')) await opts.sources.refreshStale(MAX_PLAYLIST_AGE_HOURS);
      return { games: await service.matches() };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message || 'Schedule unavailable' });
    }
  });
}
