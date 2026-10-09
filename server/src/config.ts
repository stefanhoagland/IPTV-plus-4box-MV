import path from 'node:path';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  webDir: string;
  /** Optional: create/reset the admin account from the environment on boot. */
  adminUsername?: string;
  adminPassword?: string;
  /** Set when the app is served over HTTPS (e.g. behind a reverse proxy). */
  secureCookies: boolean;
  logLevel: string;
}

export function loadConfig(env = process.env): Config {
  return {
    port: Number(env.PORT ?? 9292),
    host: env.HOST ?? '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR ?? '/config'),
    webDir: path.resolve(env.WEB_DIR ?? path.join(import.meta.dirname, '../../web/dist')),
    adminUsername: env.ADMIN_USERNAME || undefined,
    adminPassword: env.ADMIN_PASSWORD || undefined,
    secureCookies: env.SECURE_COOKIES === 'true',
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
