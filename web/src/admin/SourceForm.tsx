import { useState, type FormEvent } from 'react';
import { api, type Source, type SourceType } from '../api';
import Modal from '../components/Modal';

const TYPES: { value: SourceType; label: string }[] = [
  { value: 'm3u_url', label: 'M3U link' },
  { value: 'm3u_file', label: 'Upload M3U' },
  { value: 'xtream', label: 'Xtream login' },
];

export default function SourceForm({ source, onClose, onSaved }: { source: Source | null; onClose(): void; onSaved(s: Source): void }) {
  const editing = source !== null;
  const [type, setType] = useState<SourceType>(source?.type ?? 'm3u_url');
  const [name, setName] = useState(source?.name ?? '');
  const [url, setUrl] = useState(source?.url ?? '');
  const [username, setUsername] = useState(source?.username ?? '');
  const [password, setPassword] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [userAgent, setUserAgent] = useState(source?.userAgent ?? '');
  const [refreshHours, setRefreshHours] = useState(String(source?.refreshHours ?? 24));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { name, refreshHours: Number(refreshHours) || 0, userAgent };
      if (!editing) body.type = type;
      if (type === 'm3u_file') {
        if (file) body.fileContent = await file.text();
      } else {
        // Only send connection fields that changed, so a plain rename doesn't trigger a re-import.
        if (!editing || url !== (source.url ?? '')) body.url = url;
        if (type === 'xtream') {
          if (!editing || username !== (source.username ?? '')) body.username = username;
          if (password) body.password = password;
        }
      }
      if (editing && userAgent === (source.userAgent ?? '')) delete body.userAgent;
      const saved = editing
        ? await api<Source>(`/api/sources/${source.id}`, { method: 'PATCH', body })
        : await api<Source>('/api/sources', { method: 'POST', body });
      onSaved(saved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={editing ? `Edit ${source.name}` : 'Add a source'} onClose={onClose}>
      <form className="form" onSubmit={onSubmit}>
        {!editing && (
          <div className="segmented" role="radiogroup" aria-label="Source type">
            {TYPES.map((t) => (
              <button type="button" key={t.value} role="radio" aria-checked={type === t.value} className={type === t.value ? 'on' : ''} onClick={() => setType(t.value)}>
                {t.label}
              </button>
            ))}
          </div>
        )}
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My IPTV provider" required autoFocus />
        </label>

        {type === 'm3u_url' && (
          <label>
            Playlist URL
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://provider.example/get.php?…&type=m3u_plus" required />
          </label>
        )}
        {type === 'xtream' && (
          <>
            <label>
              Server URL
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://provider.example:8080" required />
            </label>
            <div className="row">
              <label>
                Username
                <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" required />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  placeholder={editing && source.hasPassword ? 'Unchanged' : ''}
                  required={!editing}
                />
              </label>
            </div>
          </>
        )}
        {type === 'm3u_file' && (
          <label>
            M3U file{editing && ' (leave empty to keep the current one)'}
            <input type="file" accept=".m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl,text/plain" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required={!editing} />
          </label>
        )}

        <details>
          <summary className="muted">Advanced</summary>
          <div className="row">
            {type !== 'm3u_file' && (
              <label>
                Refresh every (hours, 0 = manual)
                <input type="number" min={0} max={720} value={refreshHours} onChange={(e) => setRefreshHours(e.target.value)} />
              </label>
            )}
            <label>
              User agent
              <input value={userAgent} onChange={(e) => setUserAgent(e.target.value)} placeholder="VLC/3.0.20 LibVLC/3.0.20" />
            </label>
          </div>
        </details>

        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy}>
            {busy ? 'Importing…' : editing ? 'Save' : 'Add and import'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
