import { useEffect, useState } from 'react';
import { api } from '../api';
import Modal from '../components/Modal';

interface TvLinks {
  playlistUrl: string;
  streamUrl: string;
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <label>
      {label}
      <div className="copy-field">
        <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
        <button
          type="button"
          className="ghost"
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </label>
  );
}

/** Private link that plays this user's four boxes as one channel in any TV IPTV app. */
export default function WatchOnTv({ onClose }: { onClose(): void }) {
  const [links, setLinks] = useState<TvLinks | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<TvLinks>('/api/tv').then(setLinks, (e) => setError(e.message));
  }, []);

  async function reset() {
    if (!confirm('Make a new link? TVs using the old one stop working until you add the new one.')) return;
    try {
      setLinks(await api<TvLinks>('/api/tv/reset', { method: 'POST' }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Modal title="Watch on TV" onClose={onClose}>
      <div className="form">
        <p className="muted">
          Your four boxes as one channel, for an IPTV app on Apple TV, Roku, Fire Stick or a smart TV (for example TiviMate, IPTV Smarters or VLC). Add the playlist
          link as a new M3U playlist in that app and open <strong>My Multiview</strong>. Change boxes and audio here as usual; the TV follows within a few seconds.
        </p>
        {error && <div className="error">{error}</div>}
        {links && (
          <>
            <CopyField label="Playlist link (M3U)" value={links.playlistUrl} />
            <CopyField label="Direct stream link" value={links.streamUrl} />
          </>
        )}
        <p className="muted small">Anyone with these links can watch your boxes, so keep them private. The server re-encodes the combined picture while a TV is watching, which uses a couple of CPU cores.</p>
        <div className="actions">
          <button type="button" className="ghost danger" onClick={() => void reset()}>
            New link
          </button>
          <button type="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
