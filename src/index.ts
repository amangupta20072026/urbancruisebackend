/**
 * ==============================================================================
 * Process entry
 * ==============================================================================
 *   1. `import './config/env.js'` — parses & validates process.env; may exit.
 *   2. `buildApp()`               — assemble Express pipeline.
 *   3. `createServer(app)`        — listen + graceful shutdown handlers.
 *
 * NOTHING else belongs in this file. If you're about to add config parsing,
 * DB access, or business logic here — you're in the wrong file. Move it into
 * config/, shared/, or a module.
 * ==============================================================================
 */
import './config/env.js';
import { buildApp } from './app.js';
import { createServer } from './server.js';

const app = buildApp();
createServer(app);
