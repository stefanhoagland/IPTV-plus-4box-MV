import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type AuthStatus, type User } from './api';

interface AuthContextValue {
  status: AuthStatus | null;
  setup(username: string, password: string): Promise<void>;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);

  useEffect(() => {
    api<AuthStatus>('/api/auth/status').then(setStatus, () => setStatus({ setupRequired: false, user: null }));
  }, []);

  const signIn = useCallback(async (path: string, username: string, password: string) => {
    const { user } = await api<{ user: User }>(path, { method: 'POST', body: { username, password } });
    setStatus({ setupRequired: false, user });
  }, []);

  const value: AuthContextValue = {
    status,
    setup: (u, p) => signIn('/api/auth/setup', u, p),
    login: (u, p) => signIn('/api/auth/login', u, p),
    logout: async () => {
      await api('/api/auth/logout', { method: 'POST' });
      setStatus({ setupRequired: false, user: null });
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
