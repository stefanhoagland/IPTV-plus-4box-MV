import { buildApp, type AppDeps } from '../src/app.js';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';

export async function loggedInApp(deps: AppDeps = {}) {
  const config = loadConfig({
    DATA_DIR: ':memory:',
    WEB_DIR: '/nonexistent',
    LOG_LEVEL: 'silent',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'correct-horse',
  });
  const app = await buildApp(config, openDb(':memory:'), deps);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse' } });
  const raw = login.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0] : String(raw)).split(';')[0];
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as object, headers: { cookie } });
  return { app, call };
}

/** A fake fetch that serves fixed bodies by URL prefix and records what was requested. */
export function fakeFetch(routes: Record<string, string | object | (() => string | object)>) {
  const calls: { url: string; userAgent: string | null }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, userAgent: new Headers(init?.headers).get('user-agent') });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return new Response('not found', { status: 404 });
    const value = routes[key];
    const body = typeof value === 'function' ? value() : value;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { fn, calls };
}
