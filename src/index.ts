/**
 * Process entry point: validate env, check the database, then start the server.
 * Keep this file minimal — config, DB access and business logic live elsewhere.
 */
import './config/env.js'; // Imported first: exits on invalid config before anything else loads.
import { verifyConnection } from './shared/db/pool.js';
import { buildApp } from './app.js';
import { createServer } from './server.js';

// verifyConnection() already logs the failure; just stop the process.
try {
  await verifyConnection();
} catch {
  process.exit(1);
}

const app = buildApp();
createServer(app);
