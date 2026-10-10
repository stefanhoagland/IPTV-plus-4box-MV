import fs from 'node:fs';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { AuthService, SESSION_TTL_MS, validateCredentials, type User } from './auth.js';
import { SourceService } from './sources.js';
import { ChannelService } from './channels.js';
import { adminRoutes } from './routes/admin.js';
import { userRoutes } from './routes/users.js';
import { multiviewRoutes } from './routes/multiview.js';
import { StreamProxy, streamRoutes } from './stream.js';
import { Transcoder, transcodeRoutes } from './transcode.js';
import { NflService } from './nfl.js';
import { nflRoutes } from './routes/nfl.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
  interface FastifyInstance {
    sources: SourceService;
  }
}

const SESSION_COOKIE = 'iptvmv_session';
const PUBLIC_API = new Set(['/api/health', '/api/auth/status', '/api/auth/login', '/api/auth/setup']);

// Simple in-memory brute-force guard for login: 10 failures per IP per 15 minutes.
/** Viewers can watch and pick channels; managing sources, channel edits and accounts is for admins. */
function adminOnly(method: string, url: string): boolean {
  if (url.startsWith('/api/sources') || url.startsWith('/api/users')) return true;
  return url.startsWith('/api/channels') && method !== 'GET';
}

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

export interface AppDeps {
  fetch?: typeof fetch;
}

export async function buildApp(config: Config, db: Db, deps: AppDeps = {}) {
  const app = Fastify({ logger: { level: config.logLevel }, trustProxy: true });
  const auth = new AuthService(db);
  const loginFailures = new Map<string, { count: number; since: number }>();

  if (config.adminUsername && config.adminPassword) {
    const problem = validateCredentials(config.adminUsername, config.adminPassword);
    if (problem) throw new Error(`ADMIN_USERNAME/ADMIN_PASSWORD rejected: ${problem}`);
    await auth.upsertAdmin(config.adminUsername, config.adminPassword);
    app.log.info(`Admin account "${config.adminUsername}" set from environment`);
  }
  auth.pruneSessions();

  await app.register(cookie);
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req, reply) => {
    req.user = auth.getSessionUser(req.cookies[SESSION_COOKIE]);
    const url = req.url.split('?')[0];
    if (url.startsWith('/api/') && !PUBLIC_API.has(url) && !req.user) {
      return reply.code(401).send({ error: 'Not logged in' });
    }
    if (req.user && !req.user.isAdmin && adminOnly(req.method, url)) {
      return reply.code(403).send({ error: 'Only admins can do that' });
    }
  });

  function startSession(reply: FastifyReply, user: User) {
    reply.setCookie(SESSION_COOKIE, auth.createSession(user.id), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookies,
      maxAge: SESSION_TTL_MS / 1000,
    });
  }

  app.get('/api/health', { logLevel: 'silent' }, async () => ({ ok: true }));

  app.get('/api/auth/status', async (req) => ({
    setupRequired: !auth.hasUsers(),
    user: req.user,
  }));

  app.post('/api/auth/setup', async (req: FastifyRequest<{ Body: { username?: string; password?: string } }>, reply) => {
    if (auth.hasUsers()) return reply.code(409).send({ error: 'Setup has already been completed' });
    const { username, password } = req.body ?? {};
    const problem = validateCredentials(username, password);
    if (problem) return reply.code(400).send({ error: problem });
    // The first account runs the place.
    const user = await auth.createUser(username!, password!, true);
    startSession(reply, user);
    return { user };
  });

  app.post('/api/auth/login', async (req: FastifyRequest<{ Body: { username?: string; password?: string } }>, reply) => {
    const now = Date.now();
    const entry = loginFailures.get(req.ip);
    if (entry && now - entry.since < LOGIN_WINDOW_MS && entry.count >= LOGIN_MAX_FAILURES) {
      return reply.code(429).send({ error: 'Too many failed logins. Try again later.' });
    }
    const { username, password } = req.body ?? {};
    const user = typeof username === 'string' && typeof password === 'string' ? await auth.checkLogin(username, password) : null;
    if (!user) {
      const fresh = !entry || now - entry.since >= LOGIN_WINDOW_MS;
      loginFailures.set(req.ip, fresh ? { count: 1, since: now } : { count: entry.count + 1, since: entry.since });
      return reply.code(401).send({ error: 'Wrong username or password' });
    }
    loginFailures.delete(req.ip);
    startSession(reply, user);
    return { user };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) auth.deleteSession(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  await app.register(userRoutes, { auth });

  const sources = new SourceService(db, app.log, deps.fetch);
  const channels = new ChannelService(db);
  app.decorate('sources', sources);
  await app.register(adminRoutes, { sources, channels });
  await app.register(multiviewRoutes, { db, channels });
  const proxy = new StreamProxy(db, deps.fetch);
  await app.register(streamRoutes, { proxy });
  await app.register(transcodeRoutes, { transcoder: new Transcoder(proxy) });
  await app.register(nflRoutes, { nfl: new NflService(db, channels, deps.fetch), sources });

  // Serve the built frontend, falling back to index.html for client-side routes.
  if (fs.existsSync(config.webDir)) {
    await app.register(fastifyStatic, { root: config.webDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Not found' });
    });
  } else {
    app.log.warn(`Frontend not found at ${config.webDir}; serving API only`);
  }

  return app;
}
