import { useEffect, useState } from 'react';
import { api, type Channel } from '../api';
import Modal from '../components/Modal';

interface Game {
  id: string;
  shortName: string;
  name: string;
  startsAt: string;
  state: 'pre' | 'in' | 'post';
  status: string;
  networks: string[];
  channel: Channel | null;
  matchedBy: 'teams' | 'network' | null;
}

const SECTIONS: { state: Game['state']; title: string }[] = [
  { state: 'in', title: 'Live now' },
  { state: 'pre', title: 'Later' },
  { state: 'post', title: 'Final' },
];

function kickoff(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export type League = 'nfl' | 'ncaab';

const LEAGUES: Record<League, { title: string; name: string; example: string; networks: string }> = {
  nfl: { title: 'Live NFL', name: 'NFL', example: 'NFL 01: Bears vs Packers', networks: 'CBS, FOX, NBC, ESPN…' },
  ncaab: { title: 'College Basketball', name: 'college basketball', example: 'NCAAB 01: Duke vs North Carolina', networks: 'ESPN, ESPNU, CBS Sports Network, FS1, Big Ten Network…' },
};

export default function SportsPreset({
  league,
  onFill,
  onPlace,
  onClose,
}: {
  league: League;
  onFill(channels: Channel[]): void;
  onPlace(box: number, c: Channel): void;
  onClose(): void;
}) {
  const info = LEAGUES[league];
  const [games, setGames] = useState<Game[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ games: Game[] }>(`/api/presets/${league}`).then((r) => setGames(r.games), (e) => setError(e.message));
  }, [league]);

  // Dedicated game channels first: a network channel (e.g. FOX) may be showing a different regional game.
  const liveChannels: Channel[] = [];
  const live = (games ?? []).filter((g) => g.state === 'in' && g.channel);
  for (const g of [...live.filter((g) => g.matchedBy === 'teams'), ...live.filter((g) => g.matchedBy !== 'teams')]) {
    if (!liveChannels.some((c) => c.id === g.channel!.id)) liveChannels.push(g.channel!);
  }
  const liveCount = games?.filter((g) => g.state === 'in').length ?? 0;

  return (
    <Modal title={info.title} onClose={onClose}>
      <div className="nfl">
        {error && <div className="error">{error}</div>}
        {!games && !error && <p className="muted">Checking today's games…</p>}
        {games && games.length === 0 && <p className="muted">No {info.name} games on the schedule today.</p>}
        {games && games.length > 0 && (
          <div className="nfl-fill">
            {liveChannels.length > 0 ? (
              <>
                <button onClick={() => onFill(liveChannels.slice(0, 4))}>
                  Put {Math.min(4, liveChannels.length)} live game{liveChannels.length === 1 ? '' : 's'} in the boxes
                </button>
                {liveChannels.length > 4 && <span className="muted small">{liveChannels.length - 4} more below: use the box numbers to swap them in.</span>}
              </>
            ) : (
              <span className="muted">{liveCount ? 'Games are live, but none matched a channel in your list.' : 'No games are live right now.'}</span>
            )}
          </div>
        )}
        {SECTIONS.map(({ state, title }) => {
          const list = games?.filter((g) => g.state === state) ?? [];
          if (!list.length) return null;
          return (
            <section key={state}>
              <h4>{title}</h4>
              <ul className="nfl-list">
                {list.map((g) => (
                  <li key={g.id} className={`nfl-game ${g.state}`}>
                    <div className="nfl-main">
                      <strong>{g.shortName}</strong>
                      <span className="muted small">
                        {g.state === 'pre' ? kickoff(g.startsAt) : g.status}
                        {g.networks.length > 0 && ` · ${g.networks.join(', ')}`}
                      </span>
                      <span className={`small ${g.channel ? '' : 'muted'}`}>
                        {g.channel ? `▶ ${g.channel.name}` : 'No matching channel in your list'}
                        {g.matchedBy === 'network' && <span className="muted"> (network)</span>}
                      </span>
                    </div>
                    {g.channel && g.state !== 'post' && (
                      <div className="nfl-boxes" aria-label={`Put ${g.shortName} in a box`}>
                        {[1, 2, 3, 4].map((n) => (
                          <button key={n} className="ghost small-btn" title={`Put in box ${n}`} onClick={() => onPlace(n - 1, g.channel!)}>
                            {n}
                          </button>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        <p className="muted small">
          Games come from ESPN's schedule and are matched to your channels by team names (e.g. "{info.example}"), then by network ({info.networks}). Event channel names
          change on game day, so playlists older than 3 hours are refreshed before matching.
        </p>
      </div>
    </Modal>
  );
}
