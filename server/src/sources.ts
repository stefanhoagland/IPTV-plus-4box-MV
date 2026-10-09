import type { FastifyBaseLogger } from 'fastify';
import type { Db } from './db.js';
import { parseM3u, type PlaylistEntry } from './m3u.js';

export type SourceType = 'm3u_url' | 'm3u_file' | 'xtream';

export interface SourceInput {
  name?: string;
  type?: SourceType;
  url?: string | null;
  username?: string | null;
  password?: string | null;
  fileContent?: string | null;
  userAgent?: string | null;
  refreshHours?: number;
  enabled?: boolean;
}

interface SourceRow {
  id: number;
  name: string;
  type: SourceType;
  url: string | null;
  username: string | null;
  password: string | null;
  file_content: string | null;
  user_agent: string | null;
  refresh_hours: number;
  enabled: number;
  last_refreshed_at: string | null;
  last_error: string | null;
  created_at: string;
}

/** What the API returns: secrets and the uploaded file body are never sent back. */
export interface SourceView {
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

export interface ImportedChannel {
  streamKey: string;
  name: string;
  group?: string;
  logo?: string;
  tvgId?: string;
  url: string;
}

export class ValidationError extends Error {}

export const DEFAULT_USER_AGENT = 'VLC/3.0.20 LibVLC/3.0.20';
const FETCH_TIMEOUT_MS = 60_000;

type FetchFn = typeof fetch;

export class SourceService {
  private refreshing = new Set<number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
    private fetchFn: FetchFn = fetch,
  ) {}

  list(): SourceView[] {
    const rows = this.db.prepare('SELECT * FROM sources ORDER BY name COLLATE NOCASE').all() as unknown as SourceRow[];
    return rows.map((r) => this.view(r));
  }

  get(id: number): SourceView | null {
    const row = this.row(id);
    return row ? this.view(row) : null;
  }

  create(input: SourceInput): SourceView {
    const v = this.validate(input, null);
    const res = this.db
      .prepare(
        `INSERT INTO sources (name, type, url, username, password, file_content, user_agent, refresh_hours, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(v.name, v.type, v.url, v.username, v.password, v.file_content, v.user_agent, v.refresh_hours, v.enabled);
    return this.get(Number(res.lastInsertRowid))!;
  }

  update(id: number, input: SourceInput): SourceView | null {
    const existing = this.row(id);
    if (!existing) return null;
    const v = this.validate(input, existing);
    this.db
      .prepare(
        `UPDATE sources SET name = ?, url = ?, username = ?, password = ?, file_content = ?, user_agent = ?,
         refresh_hours = ?, enabled = ? WHERE id = ?`,
      )
      .run(v.name, v.url, v.username, v.password, v.file_content, v.user_agent, v.refresh_hours, v.enabled, id);
    return this.get(id);
  }

  delete(id: number): boolean {
    return Number(this.db.prepare('DELETE FROM sources WHERE id = ?').run(id).changes) > 0;
  }

  /** Download/parse the source and sync its channels, keeping the user's edits. Never throws. */
  async refresh(id: number): Promise<SourceView | null> {
    const row = this.row(id);
    if (!row) return null;
    if (this.refreshing.has(id)) return this.view(row);
    this.refreshing.add(id);
    try {
      const channels = await this.load(row);
      this.sync(id, channels);
      this.db.prepare(`UPDATE sources SET last_refreshed_at = datetime('now'), last_error = NULL WHERE id = ?`).run(id);
      this.log.info(`Refreshed source "${row.name}": ${channels.length} channels`);
    } catch (err) {
      const message = (err as Error).message || String(err);
      this.db.prepare(`UPDATE sources SET last_refreshed_at = datetime('now'), last_error = ? WHERE id = ?`).run(message, id);
      this.log.warn(`Refreshing source "${row.name}" failed: ${message}`);
    } finally {
      this.refreshing.delete(id);
    }
    return this.get(id);
  }

  /** Refresh every enabled source whose refresh interval has elapsed. */
  async refreshDue(): Promise<void> {
    const due = this.db
      .prepare(
        `SELECT id FROM sources WHERE enabled = 1 AND refresh_hours > 0 AND type != 'm3u_file'
         AND (last_refreshed_at IS NULL OR datetime(last_refreshed_at, '+' || refresh_hours || ' hours') <= datetime('now'))`,
      )
      .all() as { id: number }[];
    for (const { id } of due) await this.refresh(id);
  }

  startScheduler(intervalMs = 5 * 60 * 1000): void {
    const tick = () => void this.refreshDue().catch((err) => this.log.error(err));
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stopScheduler(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private row(id: number): SourceRow | undefined {
    return this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as unknown as SourceRow | undefined;
  }

  private view(r: SourceRow): SourceView {
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM channels WHERE source_id = ?').get(r.id) as { n: number };
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      url: r.url,
      username: r.username,
      hasPassword: !!r.password,
      userAgent: r.user_agent,
      refreshHours: r.refresh_hours,
      enabled: !!r.enabled,
      lastRefreshedAt: r.last_refreshed_at,
      lastError: r.last_error,
      channelCount: n,
      refreshing: this.refreshing.has(r.id),
    };
  }

  private validate(input: SourceInput, existing: SourceRow | null) {
    const type = existing?.type ?? input.type;
    if (type !== 'm3u_url' && type !== 'm3u_file' && type !== 'xtream') throw new ValidationError('Choose a source type.');
    const name = (input.name ?? existing?.name ?? '').trim();
    if (!name) throw new ValidationError('Give the source a name.');

    const pick = <T>(value: T | undefined, fallback: T): T => (value === undefined ? fallback : value);
    const clean = (s: string | null | undefined) => (typeof s === 'string' && s.trim() ? s.trim() : null);

    const url = clean(pick(input.url, existing?.url ?? null));
    const username = clean(pick(input.username, existing?.username ?? null));
    // An empty password on edit means "keep the saved one".
    const password = clean(input.password) ?? existing?.password ?? null;
    const file_content = pick(input.fileContent, existing?.file_content ?? null);
    const user_agent = clean(pick(input.userAgent, existing?.user_agent ?? null));
    const refresh_hours = Math.max(0, Math.min(24 * 30, Math.round(Number(pick(input.refreshHours, existing?.refresh_hours ?? 24)))));
    if (!Number.isFinite(refresh_hours)) throw new ValidationError('Refresh interval must be a number of hours.');
    const enabled = pick(input.enabled, existing ? !!existing.enabled : true) ? 1 : 0;

    if (type !== 'm3u_file') {
      if (!url || !/^https?:\/\//i.test(url)) throw new ValidationError('Enter a URL starting with http:// or https://');
    }
    if (type === 'xtream' && (!username || !password)) throw new ValidationError('Xtream sources need a username and password.');
    if (type === 'm3u_file' && !file_content?.trim()) throw new ValidationError('Choose an M3U file to upload.');

    return { name, type, url, username, password, file_content, user_agent, refresh_hours, enabled };
  }

  private async download(url: string, userAgent: string): Promise<Response> {
    const res = await this.fetchFn(url, {
      headers: { 'User-Agent': userAgent },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`Server returned HTTP ${res.status} for ${redact(url)}`);
    return res;
  }

  private async load(row: SourceRow): Promise<ImportedChannel[]> {
    const ua = row.user_agent || DEFAULT_USER_AGENT;
    if (row.type === 'm3u_file') return fromM3u(parseM3u(row.file_content ?? ''));
    if (row.type === 'm3u_url') {
      const text = await (await this.download(row.url!, ua)).text();
      if (!text.includes('#EXTINF')) throw new Error('That URL did not return an M3U playlist.');
      return fromM3u(parseM3u(text));
    }
    return this.loadXtream(row, ua);
  }

  private async loadXtream(row: SourceRow, ua: string): Promise<ImportedChannel[]> {
    const base = row.url!.replace(/\/+$/, '').replace(/\/player_api\.php$/, '');
    const api = (action: string) =>
      `${base}/player_api.php?username=${encodeURIComponent(row.username!)}&password=${encodeURIComponent(row.password!)}&action=${action}`;
    const json = async (action: string) => {
      const res = await this.download(api(action), ua);
      try {
        return await res.json();
      } catch {
        throw new Error('The Xtream server did not return JSON. Check the server URL.');
      }
    };

    const categories = (await json('get_live_categories')) as { category_id: string | number; category_name: string }[];
    const streams = (await json('get_live_streams')) as {
      stream_id: number | string;
      name: string;
      stream_icon?: string;
      epg_channel_id?: string | null;
      category_id?: string | number | null;
    }[];
    if (!Array.isArray(streams)) throw new Error('Xtream login failed. Check the username and password.');

    const catNames = new Map((Array.isArray(categories) ? categories : []).map((c) => [String(c.category_id), c.category_name]));
    const user = encodeURIComponent(row.username!);
    const pass = encodeURIComponent(row.password!);
    return streams.map((s) => ({
      streamKey: `xt:${s.stream_id}`,
      name: (s.name ?? '').trim() || `Stream ${s.stream_id}`,
      group: s.category_id != null ? catNames.get(String(s.category_id)) : undefined,
      logo: s.stream_icon || undefined,
      tvgId: s.epg_channel_id || undefined,
      url: `${base}/live/${user}/${pass}/${s.stream_id}.m3u8`,
    }));
  }

  /** Upsert by stable key so renames, numbers and hidden flags survive a refresh; drop channels the source no longer has. */
  private sync(sourceId: number, channels: ImportedChannel[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO channels (source_id, stream_key, position, name, group_title, logo, tvg_id, stream_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id, stream_key) DO UPDATE SET
         position = excluded.position, name = excluded.name, group_title = excluded.group_title,
         logo = excluded.logo, tvg_id = excluded.tvg_id, stream_url = excluded.stream_url`,
    );
    this.db.exec('BEGIN');
    try {
      this.db.exec('CREATE TEMP TABLE IF NOT EXISTS seen_keys (k TEXT PRIMARY KEY); DELETE FROM seen_keys;');
      const seen = this.db.prepare('INSERT OR IGNORE INTO seen_keys (k) VALUES (?)');
      channels.forEach((c, i) => {
        upsert.run(sourceId, c.streamKey, i, c.name, c.group ?? null, c.logo ?? null, c.tvgId ?? null, c.url);
        seen.run(c.streamKey);
      });
      this.db.prepare('DELETE FROM channels WHERE source_id = ? AND stream_key NOT IN (SELECT k FROM seen_keys)').run(sourceId);
      this.db.exec('DELETE FROM seen_keys; COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

/**
 * M3U entries have no stable id, and stream URLs often carry rotating tokens,
 * so key on tvg-id + name, numbering duplicates in playlist order.
 */
function fromM3u(entries: PlaylistEntry[]): ImportedChannel[] {
  const counts = new Map<string, number>();
  return entries.map((e) => {
    const base = `m3u:${e.tvgId ?? ''}|${e.name}`;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    return {
      streamKey: n === 1 ? base : `${base}#${n}`,
      name: e.name,
      group: e.group,
      logo: e.logo,
      tvgId: e.tvgId,
      url: e.url,
    };
  });
}

/** Hide credentials in URLs before they end up in error messages or logs. */
function redact(url: string): string {
  return url.replace(/(username|password)=[^&]*/gi, '$1=***').replace(/\/\/[^/@]+@/, '//***@');
}
