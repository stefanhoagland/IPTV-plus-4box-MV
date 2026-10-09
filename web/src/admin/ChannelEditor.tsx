import { useState, type FormEvent } from 'react';
import { api, type Channel } from '../api';
import Modal from '../components/Modal';

export default function ChannelEditor({ channel, onClose, onSaved }: { channel: Channel; onClose(): void; onSaved(c: Channel): void }) {
  const [name, setName] = useState(channel.customName ?? '');
  const [group, setGroup] = useState(channel.customGroup ?? '');
  const [logo, setLogo] = useState(channel.customLogo ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await api<Channel>(`/api/channels/${channel.id}`, { method: 'PATCH', body: { customName: name, customGroup: group, customLogo: logo } }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const preview = logo.trim() || channel.originalLogo;
  return (
    <Modal title="Edit channel" onClose={onClose}>
      <form className="form" onSubmit={onSubmit}>
        <p className="muted small">Leave a field empty to use what the playlist provides. Your changes are kept when the source refreshes.</p>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={channel.originalName} autoFocus />
        </label>
        <label>
          Group
          <input value={group} onChange={(e) => setGroup(e.target.value)} placeholder={channel.originalGroup ?? 'No group'} />
        </label>
        <label>
          Logo URL
          <input value={logo} onChange={(e) => setLogo(e.target.value)} placeholder={channel.originalLogo ?? 'https://…/logo.png'} />
        </label>
        {preview && <img className="logo-preview" src={preview} alt="" />}
        <p className="muted small">
          From {channel.sourceName}
          {channel.tvgId && <> · EPG id {channel.tvgId}</>}
        </p>
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
