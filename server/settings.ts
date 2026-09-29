import type { DatabaseSync } from 'node:sqlite';

const defaultMinutes = 60;
const allowedMinutes = new Set([0, 15, 30, 60, 180, 360, 1440]);

export function syncIntervalMinutes(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'sync_interval_minutes'").get() as { value: string } | undefined;
  const value = Number(row?.value ?? defaultMinutes);
  return allowedMinutes.has(value) ? value : defaultMinutes;
}

export function saveSyncIntervalMinutes(db: DatabaseSync, minutes: number): void {
  if (!allowedMinutes.has(minutes)) throw new Error('无效的同步频率');
  db.prepare("INSERT INTO settings(key, value) VALUES ('sync_interval_minutes', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(minutes));
}

export function dueSourceIds(db: DatabaseSync, now = Date.now()): number[] {
  const minutes = syncIntervalMinutes(db);
  if (minutes === 0) return [];
  const rows = db.prepare(`SELECT s.id,
    (SELECT MAX(started_at) FROM sync_runs r WHERE r.source_id = s.id) AS lastAttempt
    FROM sources s WHERE s.enabled = 1 AND s.sync_enabled = 1`).all() as Array<{ id: number; lastAttempt: string | null }>;
  return rows.filter((source) => !source.lastAttempt || now - Date.parse(`${source.lastAttempt.replace(' ', 'T')}Z`) >= minutes * 60_000)
    .map((source) => source.id);
}
