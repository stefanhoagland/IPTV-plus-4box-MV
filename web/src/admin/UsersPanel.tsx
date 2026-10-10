import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type UserSummary } from '../api';
import { useAuth } from '../auth';
import Modal from '../components/Modal';

/** Accounts for everyone who watches. Each person gets their own boxes and audio settings. */
export default function UsersPanel() {
  const { status } = useAuth();
  const me = status?.user?.id;
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [editing, setEditing] = useState<UserSummary | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<{ users: UserSummary[] }>('/api/users').then((r) => setUsers(r.users), (e) => setError(e.message)), []);
  useEffect(() => void load(), [load]);

  async function remove(u: UserSummary) {
    if (!confirm(`Delete ${u.username}? Their saved boxes are deleted too.`)) return;
    setError(null);
    try {
      await api(`/api/users/${u.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section>
      <div className="section-head">
        <p className="muted">Everyone gets their own login and their own four boxes. Viewers can watch; admins can also change sources, channels and users.</p>
        <button onClick={() => setEditing('new')}>Add user</button>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="source-list">
        {users?.map((u) => (
          <div key={u.id} className="card source">
            <div className="source-main">
              <div className="source-title">
                <strong>{u.username}</strong>
                <span className="badge">{u.isAdmin ? 'Admin' : 'Viewer'}</span>
                {u.id === me && <span className="muted small">(you)</span>}
              </div>
            </div>
            <div className="source-actions">
              <button className="ghost" onClick={() => setEditing(u)}>
                Edit
              </button>
              {u.id !== me && (
                <button className="ghost danger" onClick={() => void remove(u)}>
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {editing && (
        <UserForm
          user={editing === 'new' ? null : editing}
          isMe={editing !== 'new' && editing.id === me}
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

function UserForm({ user, isMe, onClose, onSaved }: { user: UserSummary | null; isMe: boolean; onClose(): void; onSaved(): void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(user?.isAdmin ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (user) {
        const body: Record<string, unknown> = {};
        if (password) body.password = password;
        if (isAdmin !== user.isAdmin) body.isAdmin = isAdmin;
        if (Object.keys(body).length) await api(`/api/users/${user.id}`, { method: 'PATCH', body });
        // Your own new password ends this session too: go back to the login screen.
        if (isMe && password) return window.location.reload();
      } else {
        await api('/api/users', { method: 'POST', body: { username, password, isAdmin } });
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={user ? `Edit ${user.username}` : 'Add a user'} onClose={onClose}>
      <form className="form" onSubmit={onSubmit}>
        {!user && (
          <label>
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" required autoFocus />
          </label>
        )}
        <label>
          {user ? 'New password (leave empty to keep it)' : 'Password'}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required={!user} />
        </label>
        {user && isMe && password && <p className="muted small">Changing your own password signs you out everywhere, including here.</p>}
        <label className="row-check">
          <input type="checkbox" className="switch" checked={isAdmin} disabled={isMe} onChange={(e) => setIsAdmin(e.target.checked)} />
          Admin (can change sources, channels and users)
        </label>
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : user ? 'Save' : 'Add user'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
