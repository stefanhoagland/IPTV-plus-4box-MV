import { useCallback, useEffect, useState } from 'react';
import { api, qs, type Channel, type ChannelGroup, type Source } from '../api';
import ChannelEditor from './ChannelEditor';

const PAGE = 100;
const NO_GROUP = '\u0000none';

type Visibility = 'all' | 'visible' | 'hidden';

export default function ChannelsPanel() {
  const [sources, setSources] = useState<Source[]>([]);
  const [groups, setGroups] = useState<ChannelGroup[]>([]);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [group, setGroup] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('all');
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ total: number; items: Channel[] } | null>(null);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setPage(0), [debounced, sourceId, group, visibility]);
  useEffect(() => void api<Source[]>('/api/sources').then(setSources, () => {}), []);

  const filter = {
    search: debounced || undefined,
    sourceId: sourceId || undefined,
    group: group === '' ? undefined : group === NO_GROUP ? '' : group,
    enabled: visibility === 'all' ? undefined : visibility === 'visible',
  };

  const load = useCallback(async () => {
    try {
      const [list, g] = await Promise.all([
        api<{ total: number; items: Channel[] }>(`/api/channels${qs({ ...filter, offset: page * PAGE, limit: PAGE })}`),
        api<ChannelGroup[]>(`/api/channels/groups${qs({ sourceId: filter.sourceId })}`),
      ]);
      setData(list);
      setGroups(g);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, sourceId, group, visibility, page]);
  useEffect(() => void load(), [load]);

  function replace(c: Channel) {
    setData((d) => d && { ...d, items: d.items.map((x) => (x.id === c.id ? c : x)) });
  }

  async function patch(c: Channel, body: Partial<Pick<Channel, 'enabled' | 'number'>>) {
    try {
      replace(await api<Channel>(`/api/channels/${c.id}`, { method: 'PATCH', body }));
      if ('enabled' in body) void api<ChannelGroup[]>(`/api/channels/groups${qs({ sourceId: filter.sourceId })}`).then(setGroups);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function bulk(enabled: boolean) {
    const { enabled: _ignored, ...scope } = filter;
    await api('/api/channels/bulk', { method: 'POST', body: { enabled, filter: Object.fromEntries(Object.entries(scope).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])) } });
    await load();
  }

  const totalChannels = groups.reduce((n, g) => n + g.total, 0);
  const visibleChannels = groups.reduce((n, g) => n + g.enabled, 0);
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;
  const filtered = !!(filter.search || filter.group !== undefined || filter.sourceId);

  if (sources.length === 0 && data?.total === 0) {
    return (
      <div className="card empty">
        <p>No channels yet.</p>
        <p className="muted">Add a source in the Sources tab and its channels will appear here.</p>
      </div>
    );
  }

  return (
    <section>
      <p className="muted">
        {visibleChannels.toLocaleString()} of {totalChannels.toLocaleString()} channels are visible in the multiview picker. Hide the ones you don't watch, and give your
        favourites a number to put them first.
      </p>
      <div className="filters">
        <input type="search" placeholder="Search name or number" value={search} onChange={(e) => setSearch(e.target.value)} />
        {sources.length > 1 && (
          <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} aria-label="Source">
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <select value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Group">
          <option value="">All groups</option>
          {groups.map((g) => (
            <option key={g.name ?? NO_GROUP} value={g.name ?? NO_GROUP}>
              {g.name ?? 'No group'} ({g.enabled}/{g.total})
            </option>
          ))}
        </select>
        <select value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)} aria-label="Visibility">
          <option value="all">Visible and hidden</option>
          <option value="visible">Visible only</option>
          <option value="hidden">Hidden only</option>
        </select>
      </div>
      <div className="bulk">
        <span className="muted small">{filtered ? `${data?.total.toLocaleString() ?? '…'} matching channels:` : 'All channels:'}</span>
        <button className="ghost" onClick={() => void bulk(true)}>
          Show all
        </button>
        <button className="ghost" onClick={() => void bulk(false)}>
          Hide all
        </button>
      </div>
      {error && <div className="error">{error}</div>}

      <div className="table-wrap">
        <table className="channels">
          <thead>
            <tr>
              <th>Visible</th>
              <th>#</th>
              <th></th>
              <th>Name</th>
              <th>Group</th>
              {sources.length > 1 && <th>Source</th>}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((c) => (
              <tr key={c.id} className={c.enabled ? '' : 'hidden-row'}>
                <td>
                  <input type="checkbox" className="switch" checked={c.enabled} onChange={(e) => void patch(c, { enabled: e.target.checked })} aria-label={`Show ${c.name}`} />
                </td>
                <td>
                  <NumberCell value={c.number} onSave={(number) => void patch(c, { number })} />
                </td>
                <td className="logo-cell">{c.logo && <img src={c.logo} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />}</td>
                <td>
                  {c.name}
                  {c.customName && <span className="muted small"> ({c.originalName})</span>}
                </td>
                <td className="muted">{c.group ?? '—'}</td>
                {sources.length > 1 && <td className="muted">{c.sourceName}</td>}
                <td>
                  <button className="ghost small-btn" onClick={() => setEditing(c)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.items.length === 0 && <p className="muted center-text">No channels match.</p>}
      </div>

      {pages > 1 && (
        <div className="pager">
          <button className="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span className="muted">
            Page {page + 1} of {pages}
          </span>
          <button className="ghost" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </div>
      )}

      {editing && (
        <ChannelEditor
          channel={editing}
          onClose={() => setEditing(null)}
          onSaved={(c) => {
            replace(c);
            setEditing(null);
            void api<ChannelGroup[]>(`/api/channels/groups${qs({ sourceId: filter.sourceId })}`).then(setGroups);
          }}
        />
      )}
    </section>
  );
}

function NumberCell({ value, onSave }: { value: number | null; onSave(n: number | null): void }) {
  const [text, setText] = useState(value?.toString() ?? '');
  useEffect(() => setText(value?.toString() ?? ''), [value]);
  const commit = () => {
    const trimmed = text.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    if (next !== null && (!Number.isInteger(next) || next < 0)) return setText(value?.toString() ?? '');
    if (next !== value) onSave(next);
  };
  return (
    <input
      className="num-input"
      inputMode="numeric"
      value={text}
      placeholder="–"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      aria-label="Channel number"
    />
  );
}
