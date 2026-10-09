import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { buildApp } from './app.js';

const config = loadConfig();
const db = openDb(config.dataDir);
const app = await buildApp(config, db);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    db.close();
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: config.host });
