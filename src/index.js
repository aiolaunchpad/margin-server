/** Entry point: load config (+ optional env file), open the store, start node:http. */
import http from 'node:http';
import path from 'node:path';
import { loadEnvFile } from './env-file.js';
import { loadConfig } from './config.js';
import { createStore } from './store.js';
import { createApp } from './app.js';

// Optional secrets file for local runs (never committed). Hosts should set real env vars instead.
if (process.env.OPENAI_ENV_FILE) loadEnvFile(path.resolve(process.env.OPENAI_ENV_FILE));
if (process.env.ENV_FILE) loadEnvFile(path.resolve(process.env.ENV_FILE));

const config = loadConfig();
const store = await createStore(config);
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
const app = createApp({ config, store, log });
const server = http.createServer(app);
server.requestTimeout = 90_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

server.listen(config.port, config.host, () => {
  log({ evt: 'listening', port: config.port, model: config.model, escalation: config.escalationModel || null, store: config.store, aiConfigured: !!config.openaiApiKey });
  if (!config.openaiApiKey) log({ evt: 'warn', message: 'OPENAI_API_KEY is not set — /v1/complete will return 503.' });
  if (config.ephemeralSecret) log({ evt: 'warn', message: 'TOKEN_SECRET not set — using a random one; tokens reset on restart (fine for local dev only).' });
});

const shutdown = (sig) => {
  log({ evt: 'shutdown', sig });
  server.close(() => store.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
