import type { Db } from './db.js';
import type { ChannelService, ChannelView } from './channels.js';

/**
 * "Live NFL" preset: today's games come from ESPN's public scoreboard, then each game is
 * matched to a channel in the user's own list, first by team names (event channels such as
 * "NFL 03: Bears vs Packers"), then by the network carrying it (CBS, FOX, NBC, ESPN, ...).
 */

export const SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const CACHE_MS = 60_000;

export interface Team {
  name: string; // "Bears"
  fullName: string; // "Chicago Bears"
  abbreviation: string; // "CHI"
}

export interface Game {
  id: string;
  name: string;
  shortName: string;
  startsAt: string;
  state: 'pre' | 'in' | 'post';
  status: string;
  home: Team;
  away: Team;
  networks: string[];
}

export interface GameMatch extends Game {
  channel: ChannelView | null;
  matchedBy: 'teams' | 'network' | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseScoreboard(json: any): Game[] {
  const events: any[] = Array.isArray(json?.events) ? json.events : [];
  const games: Game[] = [];
  for (const e of events) {
    const comp = e?.competitions?.[0];
    const competitors: any[] = comp?.competitors ?? [];
    const team = (side: string): Team | null => {
      const t = competitors.find((c) => c?.homeAway === side)?.team;
      if (!t) return null;
      return { name: t.name ?? t.shortDisplayName ?? '', fullName: t.displayName ?? '', abbreviation: t.abbreviation ?? '' };
    };
    const home = team('home');
    const away = team('away');
    if (!home || !away) continue;
    const networks = new Set<string>();
    for (const b of comp?.broadcasts ?? []) for (const n of b?.names ?? []) if (typeof n === 'string') networks.add(n);
    for (const g of comp?.geoBroadcasts ?? []) if (typeof g?.media?.shortName === 'string') networks.add(g.media.shortName);
    const state = e?.status?.type?.state;
    games.push({
      id: String(e.id),
      name: e.name ?? `${away.fullName} at ${home.fullName}`,
      shortName: e.shortName ?? `${away.abbreviation} @ ${home.abbreviation}`,
      startsAt: e.date ?? '',
      state: state === 'in' || state === 'post' ? state : 'pre',
      status: e?.status?.type?.shortDetail ?? '',
      home,
      away,
      networks: [...networks],
    });
  }
  return games;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim()} `;
const has = (haystack: string, word: string) => word.length > 0 && haystack.includes(` ${norm(word).trim()} `);

/**
 * Patterns for a network's main channel name, excluding its sister channels
 * (FOX News, CBS Sports Network, ESPN2 when looking for ESPN, ...).
 */
const NETWORKS: { test: RegExp; channel: RegExp }[] = [
  { test: /^cbs/i, channel: /\bcbs\b(?!\s*(sports|news|reality|drama))/i },
  { test: /^fox/i, channel: /\bfox\b(?!\s*(news|business|weather|soul|life|deportes|sports\s*[12]|\s*sports\s*(racing|plus)))/i },
  { test: /^nbc/i, channel: /\bnbc\b(?!\s*(news|sports\s*(bay|boston|chicago|philadelphia|washington|california)|universo))/i },
  { test: /^abc/i, channel: /\babc\b(?!\s*news)/i },
  { test: /^espn2/i, channel: /\bespn\s*2\b/i },
  { test: /^espn\s*deportes/i, channel: /\bespn\s*deportes\b/i },
  { test: /^espn/i, channel: /\bespn\b(?!\s*(2|u\b|news|deportes|classic|plus|\+))/i },
  { test: /^nfl\s*net/i, channel: /\bnfl\s*network\b/i },
  { test: /^nfl\s*red\s*zone|^redzone/i, channel: /\bred\s*zone\b/i },
  { test: /^(prime|amazon)/i, channel: /\b(prime\s*video|amazon|thursday\s*night\s*football|tnf)\b/i },
  { test: /^peacock/i, channel: /\bpeacock\b/i },
  { test: /^netflix/i, channel: /\bnetflix\b/i },
];

function teamsMatch(name: string, game: Game): boolean {
  const n = norm(name);
  const named = (t: Team) => has(n, t.name) || has(n, t.fullName);
  if (named(game.home) && named(game.away)) return true;
  // Abbreviations are short and ambiguous ("NO", "LA"), so only accept "CHI vs GB" / "CHI @ GB" shapes.
  const a = game.away.abbreviation.toLowerCase();
  const h = game.home.abbreviation.toLowerCase();
  if (!a || !h) return false;
  const lower = name.toLowerCase();
  const re = (x: string, y: string) => new RegExp(`\\b${x}\\s*(vs\\.?|v|@|at|-)\\s*${y}\\b`);
  return re(a, h).test(lower) || re(h, a).test(lower);
}

export class NflService {
  private cache: { at: number; games: Game[] } | null = null;

  constructor(
    private db: Db,
    private channels: ChannelService,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async games(): Promise<Game[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.games;
    const res = await this.fetchFn(process.env.NFL_SCOREBOARD_URL || SCOREBOARD_URL, { signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`NFL schedule unavailable (HTTP ${res.status})`);
    const games = parseScoreboard(await res.json());
    this.cache = { at: Date.now(), games };
    return games;
  }

  /** Every game on today's slate with the best channel for it; live games first. */
  async matches(): Promise<GameMatch[]> {
    const games = await this.games();
    const all = this.db
      .prepare('SELECT id, COALESCE(custom_name, name) AS name, enabled FROM channels ORDER BY enabled DESC, number IS NULL, number, length(COALESCE(custom_name, name))')
      .all() as { id: number; name: string; enabled: number }[];
    const used = new Set<number>();
    const order = { in: 0, pre: 1, post: 2 } as const;
    const sorted = [...games].sort((x, y) => order[x.state] - order[y.state] || x.startsAt.localeCompare(y.startsAt));

    const result = new Map<string, GameMatch>();
    // Pass 1: game-specific channels, which can only carry one game.
    for (const g of sorted) {
      const hit = all.find((c) => !used.has(c.id) && teamsMatch(c.name, g));
      if (hit) {
        used.add(hit.id);
        result.set(g.id, { ...g, channel: this.channels.get(hit.id), matchedBy: 'teams' });
      }
    }
    // Pass 2: the national/network channel. Two regional CBS games still map to the one CBS
    // channel you have, so network channels may repeat.
    for (const g of sorted) {
      if (result.has(g.id)) continue;
      let hit: { id: number } | undefined;
      for (const net of g.networks) {
        const pattern = NETWORKS.find((n) => n.test.test(net.trim()))?.channel;
        if (!pattern) continue;
        hit = all.find((c) => pattern.test(c.name));
        if (hit) break;
      }
      result.set(g.id, { ...g, channel: hit ? this.channels.get(hit.id) : null, matchedBy: hit ? 'network' : null });
    }
    return sorted.map((g) => result.get(g.id)!);
  }
}
