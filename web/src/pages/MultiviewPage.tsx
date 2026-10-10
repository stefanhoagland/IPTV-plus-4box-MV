import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Channel } from '../api';
import Player from '../multiview/Player';
import WatchOnTv from '../multiview/WatchOnTv';
import ChannelPicker from '../multiview/ChannelPicker';
import NflPreset from '../multiview/NflPreset';
import { Close, FixPicture, Info, Fullscreen, Plus, SpeakerOff, SpeakerOn } from '../multiview/icons';

interface Tile {
  channelId: number | null;
  muted: boolean;
  channel: Channel | null;
}

const EMPTY: Tile[] = Array.from({ length: 4 }, () => ({ channelId: null, muted: true, channel: null }));

export default function MultiviewPage() {
  const [tiles, setTiles] = useState<Tile[]>(EMPTY);
  const [picking, setPicking] = useState<number | null>(null);
  const [nfl, setNfl] = useState(false);
  const [tv, setTv] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fixRequests, setFixRequests] = useState([0, 0, 0, 0]);
  const [detailsRequests, setDetailsRequests] = useState([0, 0, 0, 0]);
  const tileRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    api<{ tiles: Tile[] }>('/api/multiview').then((r) => setTiles(r.tiles), (e) => setError(e.message));
  }, []);

  const save = useCallback((next: Tile[]) => {
    void api('/api/multiview', { method: 'PUT', body: { tiles: next.map(({ channelId, muted }) => ({ channelId, muted })) } }).catch((e) => setError(e.message));
    return next;
  }, []);

  const update = useCallback(
    (index: number, change: Partial<Tile>) => setTiles((prev) => save(prev.map((t, i) => (i === index ? { ...t, ...change } : t)))),
    [save],
  );

  /** Presets: put these channels in boxes 1..n, keeping each box's audio setting; leftover boxes keep what they had. */
  const fill = useCallback(
    (channels: Channel[]) => setTiles((prev) => save(prev.map((t, i) => (channels[i] ? { ...t, channelId: channels[i].id, channel: channels[i] } : t)))),
    [save],
  );

  // Keys 1-4 toggle each box's audio.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (picking !== null || nfl || e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 4 && tiles[n - 1].channelId !== null) update(n - 1, { muted: !tiles[n - 1].muted });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tiles, picking, nfl, update]);

  const fullscreen = (i: number) => {
    const el = tileRefs.current[i];
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().catch(() => {});
  };

  return (
    <div className="multiview">
      <div className="mv-toolbar">
        <span className="muted small">Click a box to choose its channel</span>
        <div className="mv-actions">
          <button className="ghost small-btn" onClick={() => setTv(true)}>
            📺 Watch on TV
          </button>
          <button className="ghost small-btn" onClick={() => setNfl(true)}>
            🏈 Live NFL
          </button>
        </div>
      </div>
      {error && (
        <div className="mv-error" role="alert">
          {error}
          <button className="ghost icon" onClick={() => setError(null)} aria-label="Dismiss">
            <Close />
          </button>
        </div>
      )}
      <div className="grid-2x2">
        {tiles.map((t, i) => (
          <div
            key={i}
            ref={(el) => {
              tileRefs.current[i] = el;
            }}
            className={`tile${t.channelId !== null && !t.muted ? ' audible' : ''}${t.channelId === null ? ' empty' : ''}`}
            onClick={() => setPicking(i)}
            role="button"
            tabIndex={0}
            aria-label={t.channel ? `Box ${i + 1}: ${t.channel.name}. Click to change channel` : `Box ${i + 1}: click to choose a channel`}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget === e.target && setPicking(i)}
          >
            {t.channelId !== null && t.channel ? (
              <>
                <Player channelId={t.channelId} muted={t.muted} fixRequest={fixRequests[i]} detailsRequest={detailsRequests[i]} />
                <div className="tile-bar" onClick={(e) => e.stopPropagation()}>
                  <div className="tile-title">
                    <span className="box-num">{i + 1}</span>
                    {t.channel.logo && <img src={t.channel.logo} alt="" onError={(e) => (e.currentTarget.style.display = 'none')} />}
                    <span className="tile-name">{t.channel.name}</span>
                  </div>
                  <div className="tile-buttons">
                    <button
                      className={`tile-btn audio${t.muted ? '' : ' on'}`}
                      onClick={() => update(i, { muted: !t.muted })}
                      aria-pressed={!t.muted}
                      aria-label={t.muted ? `Turn on audio for box ${i + 1}` : `Turn off audio for box ${i + 1}`}
                      title={t.muted ? `Audio off (press ${i + 1})` : `Audio on (press ${i + 1})`}
                    >
                      {t.muted ? <SpeakerOff /> : <SpeakerOn />}
                    </button>
                    <button
                      className="tile-btn"
                      onClick={() => setFixRequests((f) => f.map((n, j) => (j === i ? n + 1 : n)))}
                      aria-label={`Fix picture in box ${i + 1}`}
                      title="Black picture? Have the server convert this channel (click again to undo)"
                    >
                      <FixPicture />
                    </button>
                    <button
                      className="tile-btn"
                      onClick={() => setDetailsRequests((f) => f.map((n, j) => (j === i ? n + 1 : n)))}
                      aria-label={`Details for box ${i + 1}`}
                      title="Details: what the player and server saw, to copy when reporting a problem"
                    >
                      <Info />
                    </button>
                    <button className="tile-btn" onClick={() => fullscreen(i)} aria-label={`Fullscreen box ${i + 1}`} title="Fullscreen">
                      <Fullscreen />
                    </button>
                    <button className="tile-btn" onClick={() => update(i, { channelId: null, channel: null, muted: true })} aria-label={`Clear box ${i + 1}`} title="Clear box">
                      <Close />
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="tile-empty">
                <Plus />
                <span>Box {i + 1}</span>
                <small className="muted">Click to choose a channel</small>
              </div>
            )}
          </div>
        ))}
      </div>
      {tv && <WatchOnTv onClose={() => setTv(false)} />}
      {nfl && (
        <NflPreset
          onClose={() => setNfl(false)}
          onFill={(channels) => {
            fill(channels);
            setNfl(false);
          }}
          onPlace={(box, c) => update(box, { channelId: c.id, channel: c })}
        />
      )}
      {picking !== null && (
        <ChannelPicker
          box={picking + 1}
          currentId={tiles[picking].channelId}
          onClose={() => setPicking(null)}
          onPick={(c) => {
            update(picking, { channelId: c.id, channel: c });
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}
