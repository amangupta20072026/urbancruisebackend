/**
 * ==============================================================================
 * PM2 ecosystem config
 * ==============================================================================
 * Usage on the server — build WITH dev dependencies, then prune them:
 *
 *     npm ci && npm run build && npm prune --omit=dev
 *
 *   `npm ci --omit=dev` alone cannot be used: `npm run build` needs `tsc`
 *   and the @types/* packages, which are dev dependencies. Pruning after
 *   the build leaves only runtime packages in node_modules. The `prepare`
 *   script is `husky || true`, so a dev-less install never fails on husky.
 *
 * Then start / persist:
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
 *   - `kill_timeout` (finding M8) is how long PM2 waits after its stop signal
 *     before it sends SIGKILL. It MUST be LONGER than SHUTDOWN_TIMEOUT_MS in
 *     src/config/constants.ts (15 s): the app's own deadline has to fire
 *     first so it can log "shutdown timed out" and exit by itself. When both
 *     were 15 s, PM2's SIGKILL won the race and the final log lines were
 *     lost (reproduced with PM2 7.0.4). 20 s = 15 s drain + 5 s margin.
 *     PM2 passes this value to the app as process.env.kill_timeout, and
 *     src/server.ts logs `alarm: 'shutdown_deadline_misconfigured'` at boot
 *     if it is not at least SHUTDOWN_TIMEOUT_MS + SHUTDOWN_KILL_MARGIN_MS.
 *     If you change one value, change the other.
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
      kill_timeout: 20000, // > SHUTDOWN_TIMEOUT_MS (15000) — see M8 note above

      // Logs
      out_file: './logs/access.log',
      error_file: './logs/error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',

      // Base env — applies to EVERY start, including a plain `pm2 start
      // ecosystem.config.cjs` or `pm2 restart` without --env. Production is
      // the safe default on a server (fix N4); use --env development to
      // override locally.
      env: {
        NODE_ENV: 'production',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      env_development: {
        NODE_ENV: 'development',
      },
    },
  ],
};
