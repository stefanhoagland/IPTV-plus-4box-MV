import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth';

export default function LoginPage({ mode }: { mode: 'setup' | 'login' }) {
  const { setup, login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (mode === 'setup' && password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await (mode === 'setup' ? setup : login)(username, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form className="card login" onSubmit={onSubmit}>
        <h1>
          <img src="/icon.svg" alt="" width={28} height={28} /> IPTV Multiview
        </h1>
        <p className="muted">{mode === 'setup' ? 'Create the admin account to get started.' : 'Sign in to continue.'}</p>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
            required
          />
        </label>
        {mode === 'setup' && (
          <label>
            Confirm password
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
          </label>
        )}
        {error && <div className="error">{error}</div>}
        <button type="submit" disabled={busy}>
          {mode === 'setup' ? 'Create account' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
