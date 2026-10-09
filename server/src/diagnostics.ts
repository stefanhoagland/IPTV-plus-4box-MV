/**
 * Recent per-channel stream events (upstream answers, ffmpeg output), kept in memory so a viewer
 * can copy "what happened" from the box's Details panel without digging through container logs.
 */
const MAX_EVENTS = 80;

export class Diagnostics {
  private events = new Map<number, string[]>();

  note(channelId: number, message: string) {
    const list = this.events.get(channelId) ?? [];
    list.push(`${new Date().toISOString().slice(11, 19)} ${message}`);
    if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
    this.events.delete(channelId);
    this.events.set(channelId, list);
    // Forget the least recently used channels.
    if (this.events.size > 200) this.events.delete(this.events.keys().next().value!);
  }

  get(channelId: number): string[] {
    return [...(this.events.get(channelId) ?? [])];
  }
}

/** Host and file name only: provider URLs often carry the account's username and password. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const file = u.pathname.split('/').filter(Boolean).pop() ?? '';
    return `${u.protocol}//${u.host}/…/${file}`;
  } catch {
    return '(invalid URL)';
  }
}

/** One-line summary of a playlist: master (with codecs) or media (segment count and type). */
export function describePlaylist(text: string): string {
  const variants = [...text.matchAll(/#EXT-X-STREAM-INF:([^\n]*)/g)].map((m) => {
    const res = /RESOLUTION=(\d+x\d+)/.exec(m[1])?.[1];
    const codecs = /CODECS="([^"]+)"/.exec(m[1])?.[1];
    return [res, codecs].filter(Boolean).join(' ') || 'variant';
  });
  if (variants.length) return `master playlist, ${variants.length} variant(s): ${variants.slice(0, 4).join('; ')}`;
  const segments = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  const ext = /\.([a-z0-9]{2,4})(?:$|\?)/i.exec(segments[0] ?? '')?.[1] ?? '?';
  const fmp4 = text.includes('#EXT-X-MAP') ? ', fMP4' : '';
  const enc = /#EXT-X-KEY:METHOD=([A-Z0-9-]+)/.exec(text)?.[1];
  return `media playlist, ${segments.length} segment(s) .${ext}${fmp4}${enc && enc !== 'NONE' ? `, encrypted ${enc}` : ''}${text.includes('#EXT-X-ENDLIST') ? ', ended' : ''}`;
}
