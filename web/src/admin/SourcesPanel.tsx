import { useCallback, useEffect, useState } from 'react';
import { api, type Source } from '../api';
import SourceForm from './SourceForm';
import { timeAgo } from './time';

const TYPE_LABEL = { m3u_url: 'M3U link', m3u_file: 'Uploaded M3U', xtream: 'Xtream' } as const;

export default function SourcesPanel() {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [editing, setEditing] = useState<Source | 'new' | null>(null);
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<Source[]>('/api/sources').then(setSources, (e) => setError(e.message)), []);
  useEffect(() => void load(), [load]);

  async function run(id: number, fn: () => Promise<unknown>) {
    setBusy((b) => new Set(b).add(id));
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(id);
        return next;
      });
    }
  }

  return (
    <section>
      <div className="section-head">
        <p className="muted">Your IPTV playlists. Channels from every source show up together in the Channels tab.</p>
        <button onClick={() => setEditing('new')}>Add source</button>
      </div>
      {error && <div className="error">{error}</div>}
      {sources?.length === 0 && (
        <div className="card empty">
          <p>No sources yet.</p>
          <p className="muted">Add an M3U link, upload an M3U file, or enter your Xtream Codes login.</p>
        </div>
      )}
      <div className="source-list">
        {sources?.map((s) => (
          <div key={s.id} className="card source">
            <div className="source-main">
              <div className="source-title">
                <strong>{s.name}</strong>
                <span className="badge">{TYPE_LABEL[s.type]}</span>
              </div>
              <div className="muted small">
                {s.channelCount.toLocaleString()} channels · refreshed {timeAgo(s.lastRefreshedAt)}
                {s.type !== 'm3u_file' && (s.refreshHours ? ` · auto every ${s.refreshHours} h` : ' · manual refresh')}
              </div>
              {s.lastError && <div className="error small">Last refresh failed: {s.lastError}</div>}
            </div>
            <div className="source-actions">
              {s.type !== 'm3u_file' && (
                <button className="ghost" disabled={busy.has(s.id)} onClick={() => run(s.id, () => api(`/api/sources/${s.id}/refresh`, { method: 'POST' }))}>
                  {busy.has(s.id) ? 'Refreshing…' : 'Refresh'}
                </button>
              )}
              <button className="ghost" onClick={() => setEditing(s)}>
                Edit
              </button>
              <button
                className="ghost danger"
                disabled={busy.has(s.id)}
                onClick={() => {
                  if (confirm(`Delete "${s.name}" and its ${s.channelCount} channels?`)) void run(s.id, () => api(`/api/sources/${s.id}`, { method: 'DELETE' }));
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
      {editing && (
        <SourceForm
          source={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </section>
  );
}
