/**
 * ==============================================================================
 * PM2 ecosystem config
 * ==============================================================================
 * Usage on the server (after `npm ci --omit=dev && npm run build`):
 *
 *     pm2 start ecosystem.config.cjs --env production
 *     pm2 save
 *     pm2 startup           # generate systemd bootstrap
 *
 * Notes:
 *   - `exec_mode: 'cluster'` + `instances: 'max'` runs one worker per CPU core.
 *     Node's event loop is single-threaded — cluster is how you use the box.
 *   - `wait_ready: true` + `listen_timeout` require the app to call
 *     `process.send('ready')` after the HTTP server has bound. Prevents PM2
 *     from routing traffic to a not-yet-ready worker. See src/server.ts.
 *   - `kill_timeout` is a hard-cap on graceful shutdown. src/server.ts drains
 *     within this window; anything longer means requests get force-killed.
 *   - Logs go to ./logs, which is gitignored. In prod, ship stdout via a log
 *     agent (Loki / CloudWatch / Datadog) — PM2 files are the fallback.
 * ==============================================================================
 */
module.exports = {
  apps: [
    {
      name: 'urbancruise-api',
      script: 'dist/index.js',
      exec_mode: 'cluster',
      instances: 'max',

      // Prod defaults; per-env overrides below.
      node_args: '--enable-source-maps',
      max_memory_restart: '768M',
      autorestart: true,
      restart_delay: 2000,
      max_restarts: 10,
      min_uptime: '10s',

      // Coordinated startup — PM2 waits for `process.send('ready')`.
      wait_ready: true,
      listen_timeout: 15000,

      // Coordinated shutdown — PM2 sends SIGINT, expects clean exit inside window.
      shutdown_with_message: false,
      kill_timeout: 15000,

      // Logs
      out_file: './logs/access.log',
      error_file: './logs/error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',

      env_production: {
        NODE_ENV: 'production',
      },
      env_development: {
        NODE_ENV: 'development',
      },
    },
  ],
};
