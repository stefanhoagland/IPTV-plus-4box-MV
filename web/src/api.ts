export interface User {
  id: number;
  username: string;
  isAdmin: boolean;
}

export interface UserSummary extends User {
  createdAt: string;
}

export interface AuthStatus {
  setupRequired: boolean;
  user: User | null;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export type SourceType = 'm3u_url' | 'm3u_file' | 'xtream';

export interface Source {
  id: number;
  name: string;
  type: SourceType;
  url: string | null;
  username: string | null;
  hasPassword: boolean;
  userAgent: string | null;
  refreshHours: number;
  enabled: boolean;
  lastRefreshedAt: string | null;
  lastError: string | null;
  channelCount: number;
  refreshing: boolean;
}

export interface Channel {
  id: number;
  sourceId: number;
  sourceName: string;
  number: number | null;
  name: string;
  group: string | null;
  logo: string | null;
  originalName: string;
  originalGroup: string | null;
  originalLogo: string | null;
  tvgId: string | null;
  enabled: boolean;
  customName: string | null;
  customGroup: string | null;
  customLogo: string | null;
}

export interface ChannelGroup {
  name: string | null;
  total: number;
  enabled: number;
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
