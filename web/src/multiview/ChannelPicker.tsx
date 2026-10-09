import { useEffect, useRef, useState } from 'react';
import { api, qs, type Channel, type ChannelGroup } from '../api';
import Modal from '../components/Modal';

const PAGE = 60;

export default function ChannelPicker({ box, currentId, onPick, onClose }: { box: number; currentId: number | null; onPick(c: Channel): void; onClose(): void }) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [group, setGroup] = useState('');
  const [groups, setGroups] = useState<ChannelGroup[]>([]);
  const [items, setItems] = useState<Channel[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 200);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    void api<ChannelGroup[]>('/api/channels/groups').then((g) => setGroups(g.filter((x) => x.enabled > 0)), () => {});
  }, []);

  async function load(offset: number) {
    const id = ++request.current;
    setLoading(true);
    try {
      const res = await api<{ total: number; items: Channel[] }>(
        `/api/channels${qs({ enabled: true, search: debounced || undefined, group: group || undefined, offset, limit: PAGE })}`,
      );
      if (id !== request.current) return;
      setTotal(res.total);
      setItems((prev) => (offset === 0 ? res.items : [...prev, ...res.items]));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, group]);

  return (
    <Modal title={`Choose a channel for box ${box}`} onClose={onClose}>
      <div className="picker">
        <div className="filters">
          <input
            type="search"
            placeholder="Search channels"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && items[0] && onPick(items[0])}
          />
          {groups.length > 1 && (
            <select value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Group">
              <option value="">All groups</option>
              {groups.filter((g) => g.name).map((g) => (
                <option key={g.name} value={g.name!}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <ul className="picker-list">
          {items.map((c) => (
            <li key={c.id}>
              <button className={`picker-item${c.id === currentId ? ' current' : ''}`} onClick={() => onPick(c)}>
                <span className="picker-num">{c.number ?? ''}</span>
                <span className="picker-logo">{c.logo && <img src={c.logo} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />}</span>
                <span className="picker-name">{c.name}</span>
                <span className="picker-group muted">{c.group}</span>
              </button>
            </li>
          ))}
        </ul>
        {total === 0 && !loading && <p className="muted center-text">{debounced || group ? 'No channels match.' : 'No visible channels yet. Add a source in Admin.'}</p>}
        {total !== null && items.length < total && (
          <button className="ghost load-more" disabled={loading} onClick={() => void load(items.length)}>
            {loading ? 'Loading…' : `Show more (${(total - items.length).toLocaleString()} left)`}
          </button>
        )}
      </div>
    </Modal>
  );
}
