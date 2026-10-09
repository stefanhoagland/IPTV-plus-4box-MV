import type { Db } from './db.js';
import { ValidationError } from './sources.js';

export interface ChannelView {
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

export interface ChannelQuery {
  search?: string;
  group?: string;
  sourceId?: number;
  enabled?: boolean;
  offset?: number;
  limit?: number;
}

export interface ChannelPatch {
  customName?: string | null;
  customGroup?: string | null;
  customLogo?: string | null;
  number?: number | null;
  enabled?: boolean;
}

const SELECT = `
  SELECT c.*, s.name AS source_name,
    COALESCE(c.custom_name, c.name) AS display_name,
    COALESCE(c.custom_group, c.group_title) AS display_group,
    COALESCE(c.custom_logo, c.logo) AS display_logo
  FROM channels c JOIN sources s ON s.id = c.source_id`;
const ORDER = `ORDER BY c.number IS NULL, c.number, s.name COLLATE NOCASE, c.position`;

interface Row {
  id: number;
  source_id: number;
  source_name: string;
  number: number | null;
  name: string;
  group_title: string | null;
  logo: string | null;
  tvg_id: string | null;
  enabled: number;
  custom_name: string | null;
  custom_group: string | null;
  custom_logo: string | null;
  display_name: string;
  display_group: string | null;
  display_logo: string | null;
  stream_url: string;
}

function toView(r: Row): ChannelView {
  return {
    id: r.id,
    sourceId: r.source_id,
    sourceName: r.source_name,
    number: r.number,
    name: r.display_name,
    group: r.display_group,
    logo: r.display_logo,
    originalName: r.name,
    originalGroup: r.group_title,
    originalLogo: r.logo,
    tvgId: r.tvg_id,
    enabled: !!r.enabled,
    customName: r.custom_name,
    customGroup: r.custom_group,
    customLogo: r.custom_logo,
  };
}

function where(q: ChannelQuery): { sql: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (q.search?.trim()) {
    clauses.push(`(COALESCE(c.custom_name, c.name) LIKE ? ESCAPE '\\' OR CAST(c.number AS TEXT) = ?)`);
    params.push(`%${q.search.trim().replace(/[\\%_]/g, (m) => '\\' + m)}%`, q.search.trim());
  }
  if (q.group !== undefined) {
    if (q.group === '') clauses.push('COALESCE(c.custom_group, c.group_title) IS NULL');
    else {
      clauses.push('COALESCE(c.custom_group, c.group_title) = ?');
      params.push(q.group);
    }
  }
  if (q.sourceId !== undefined) {
    clauses.push('c.source_id = ?');
    params.push(q.sourceId);
  }
  if (q.enabled !== undefined) {
    clauses.push('c.enabled = ?');
    params.push(q.enabled ? 1 : 0);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export class ChannelService {
  constructor(private db: Db) {}

  list(q: ChannelQuery): { total: number; items: ChannelView[] } {
    const w = where(q);
    const { n } = this.db.prepare(`SELECT COUNT(*) AS n FROM channels c JOIN sources s ON s.id = c.source_id ${w.sql}`).get(...w.params) as { n: number };
    const limit = Math.max(1, Math.min(500, q.limit ?? 100));
    const offset = Math.max(0, q.offset ?? 0);
    const rows = this.db.prepare(`${SELECT} ${w.sql} ${ORDER} LIMIT ? OFFSET ?`).all(...w.params, limit, offset) as unknown as Row[];
    return { total: n, items: rows.map(toView) };
  }

  get(id: number): ChannelView | null {
    const row = this.db.prepare(`${SELECT} WHERE c.id = ?`).get(id) as unknown as Row | undefined;
    return row ? toView(row) : null;
  }

  /** Stream URL for playback (step 3); kept out of list responses because it usually embeds credentials. */
  streamUrl(id: number): string | null {
    const row = this.db.prepare('SELECT stream_url FROM channels WHERE id = ?').get(id) as { stream_url: string } | undefined;
    return row?.stream_url ?? null;
  }

  groups(sourceId?: number): { name: string | null; total: number; enabled: number }[] {
    const filter = sourceId !== undefined ? 'WHERE source_id = ?' : '';
    const params = sourceId !== undefined ? [sourceId] : [];
    return this.db
      .prepare(
        `SELECT COALESCE(custom_group, group_title) AS grp, COUNT(*) AS total, SUM(enabled) AS enabled
         FROM channels ${filter} GROUP BY 1 ORDER BY grp IS NULL, grp COLLATE NOCASE`,
      )
      .all(...params)
      .map((r) => ({ name: r.grp as string | null, total: r.total as number, enabled: r.enabled as number }));
  }

  update(id: number, patch: ChannelPatch): ChannelView | null {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const text = (key: keyof ChannelPatch, column: string, max: number) => {
      if (patch[key] === undefined) return;
      const v = patch[key];
      if (v !== null && typeof v !== 'string') throw new ValidationError(`${key} must be text`);
      const trimmed = v?.trim() || null;
      if (trimmed && trimmed.length > max) throw new ValidationError(`${key} is too long`);
      sets.push(`${column} = ?`);
      params.push(trimmed);
    };
    text('customName', 'custom_name', 200);
    text('customGroup', 'custom_group', 200);
    text('customLogo', 'custom_logo', 2000);
    if (patch.customLogo && !/^https?:\/\//i.test(patch.customLogo.trim())) throw new ValidationError('Logo must be an http(s) URL');
    if (patch.number !== undefined) {
      if (patch.number !== null && (!Number.isInteger(patch.number) || patch.number < 0 || patch.number > 999999)) {
        throw new ValidationError('Channel number must be a whole number');
      }
      sets.push('number = ?');
      params.push(patch.number);
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(patch.enabled ? 1 : 0);
    }
    if (sets.length) this.db.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    return this.get(id);
  }

  /** Show/hide many channels at once: explicit ids, or everything matching a filter (e.g. a whole group). */
  setEnabled(enabled: boolean, target: { ids?: number[]; filter?: ChannelQuery }): number {
    if (target.ids) {
      const ids = target.ids.filter((n) => Number.isInteger(n));
      if (!ids.length) return 0;
      const res = this.db.prepare(`UPDATE channels SET enabled = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(enabled ? 1 : 0, ...ids);
      return Number(res.changes);
    }
    const w = where({ ...target.filter, enabled: undefined, offset: undefined, limit: undefined });
    const res = this.db
      .prepare(`UPDATE channels SET enabled = ? WHERE id IN (SELECT c.id FROM channels c JOIN sources s ON s.id = c.source_id ${w.sql})`)
      .run(enabled ? 1 : 0, ...w.params);
    return Number(res.changes);
  }
}
