/**
 * PM2 config. Deploy:
 *   npm ci && npm run build && npm prune --omit=dev
 *   pm2 start ecosystem.config.cjs --env production && pm2 save
 * (Build needs dev dependencies, so prune only after building.)
 */
module.exports = {
  apps: [
    {
      name: 'urbancruise-api',
      script: 'dist/index.js',
      exec_mode: 'cluster',
      instances: 'max',

      node_args: '--enable-source-maps',
      max_memory_restart: '768M',
      autorestart: true,
      restart_delay: 2000,
      max_restarts: 10,
      min_uptime: '10s',

      // Wait for the app's process.send('ready') before routing traffic.
      wait_ready: true,
      listen_timeout: 15000,

      shutdown_with_message: false,
      // Must exceed SHUTDOWN_TIMEOUT_MS + SHUTDOWN_KILL_MARGIN_MS (src/config/constants.ts).
      kill_timeout: 20000,

      out_file: './logs/access.log',
      error_file: './logs/error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',

      // Default when no --env flag is given: production.
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
