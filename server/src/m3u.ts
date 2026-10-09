export interface PlaylistEntry {
  name: string;
  url: string;
  tvgId?: string;
  tvgName?: string;
  logo?: string;
  group?: string;
}

/** Split an #EXTINF line into its attribute section and the display name after the first unquoted comma. */
function splitExtinf(line: string): { attrs: string; name: string } {
  const body = line.slice('#EXTINF:'.length);
  let inQuotes = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) return { attrs: body.slice(0, i), name: body.slice(i + 1).trim() };
  }
  return { attrs: body, name: '' };
}

function parseAttrs(attrs: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of attrs.matchAll(/([A-Za-z0-9_-]+)="([^"]*)"/g)) out[m[1].toLowerCase()] = m[2].trim();
  return out;
}

/** Parse an M3U / M3U8 playlist (the IPTV flavour with #EXTINF attributes). */
export function parseM3u(text: string): PlaylistEntry[] {
  const entries: PlaylistEntry[] = [];
  let pending: Omit<PlaylistEntry, 'url'> | null = null;
  let pendingGroup: string | undefined;

  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const { attrs, name } = splitExtinf(line);
      const a = parseAttrs(attrs);
      pending = {
        name: name || a['tvg-name'] || 'Unnamed',
        tvgId: a['tvg-id'] || undefined,
        tvgName: a['tvg-name'] || undefined,
        logo: a['tvg-logo'] || undefined,
        group: a['group-title'] || undefined,
      };
      pendingGroup = undefined;
    } else if (line.startsWith('#EXTGRP:')) {
      pendingGroup = line.slice('#EXTGRP:'.length).trim() || undefined;
    } else if (line.startsWith('#')) {
      continue;
    } else if (pending) {
      entries.push({ ...pending, group: pending.group ?? pendingGroup, url: line });
      pending = null;
      pendingGroup = undefined;
    }
  }
  return entries;
}
