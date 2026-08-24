import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';

import { loadConfig } from './config.js';
import { getPool } from './db/pool.js';
import { runMigrations, migrationsDir } from './db/migrate.js';
import { createApp } from './app.js';
import { runTick } from './services/tick.js';
import { makeSendEmail } from './lib/mailer.js';
import { makeGoogleCal } from './lib/googleCalendar.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDistPath = path.resolve(__dirname, '../../client/dist');

async function main() {
  const config = loadConfig(process.env);
  const pool = getPool(config);
  await runMigrations(pool, migrationsDir);

  const app = createApp({
    config,
    pool,
    sendEmail: undefined,
    cal: process.env.GOOGLE_REFRESH_TOKEN ? makeGoogleCal(config) : undefined,
    clientDist: existsSync(clientDistPath) ? clientDistPath : undefined,
  });

  const server = http.createServer(app);

  if (config.cronEnabled) {
    cron.schedule('* * * * *', async () => {
      try {
        const result = await runTick({
          query: pool.query.bind(pool),
          pool,
          now: () => new Date(),
          sendEmail: makeSendEmail(config),
          cal: process.env.GOOGLE_REFRESH_TOKEN ? makeGoogleCal(config) : {
            createEvent: async () => { throw new Error('calendar provider not configured'); },
            deleteEvent: async () => { throw new Error('calendar provider not configured'); },
          },
          llmDeps: { fetchImpl: globalThis.fetch, cfg: config },
        });
        console.log(JSON.stringify({ level: 'info', kind: 'tick', ...result }));
      } catch (err) {
        console.error(JSON.stringify({ level: 'error', kind: 'tick_failed', message: err.message }));
      }
    });
  }

  server.listen(config.port, () => {
    console.log(JSON.stringify({ level: 'info', kind: 'listening', port: config.port }));
  });

  const shutdown = async () => {
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'fatal', message: err.message }));
  process.exit(1);
});
