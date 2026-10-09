/** SQLite datetime('now') strings are UTC without a zone marker. */
export function timeAgo(sqliteUtc: string | null): string {
  if (!sqliteUtc) return 'never';
  const then = new Date(sqliteUtc.replace(' ', 'T') + 'Z').getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
