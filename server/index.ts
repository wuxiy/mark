import { resolve } from 'node:path';
import { buildApp } from './app.ts';
import { queueSync } from './sync.ts';
import { dueSourceIds, saveSyncIntervalMinutes } from './settings.ts';

const dataDir = resolve(process.env.MARK_DATA_DIR ?? '.data');
const webDir = resolve('dist');
const { app, db } = await buildApp({
  dataDir,
  webDir,
  initialPasswordFile: process.env.MARK_INITIAL_PASSWORD_FILE,
  secureCookie: process.env.MARK_SECURE_COOKIE === '1',
  model: {
    baseUrl: process.env.MARK_MODEL_BASE_URL,
    model: process.env.MARK_MODEL_NAME,
    apiKey: process.env.MARK_MODEL_API_KEY,
  },
});
const configuredMinutes = Number(process.env.MARK_SYNC_INTERVAL_MINUTES ?? 60);
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'sync_interval_minutes'").get()) {
  saveSyncIntervalMinutes(db, [0, 15, 30, 60, 180, 360, 1440].includes(configuredMinutes) ? configuredMinutes : 60);
}
const port = Number(process.env.PORT ?? 3100);
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
process.stdout.write(`Mark listening on http://127.0.0.1:${port}\n`);
const interval = setInterval(() => {
  for (const id of dueSourceIds(db)) {
    try { queueSync(db, dataDir, id); }
    catch (cause) { process.stderr.write(`定时同步来源 ${id} 未启动：${cause instanceof Error ? cause.message : '未知错误'}\n`); }
  }
}, 60_000);
interval.unref();
