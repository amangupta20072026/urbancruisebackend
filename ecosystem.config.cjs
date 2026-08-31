/**
 * ==========================================================================
 * PM2 ecosystem — Urban Cruise Backend
 * --------------------------------------------------------------------------
 * Deploy with:
 *   npm ci --omit=dev
 *   npm run build
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 save                    # persist across reboots
 *   pm2 startup                 # generate init script (one-time)
 *
 * Reload with zero downtime:
 *   pm2 reload urbancruise-api
 *
 * Logs:
 *   pm2 logs urbancruise-api            # tail
 *   pm2 flush urbancruise-api           # clear
 *
 * NOTE on cluster mode:
 *   `instances: 'max'` forks one worker per CPU core. This makes the app
 *   horizontally scalable across cores of a single box. The catch is that
 *   express-rate-limit's default MemoryStore is per-process — so N workers
 *   means N independent rate-limit buckets per IP. Once you're serious
 *   about rate limiting under cluster, add ioredis + rate-limit-redis.
 *   Until then, either run `instances: 1` OR accept the fan-out.
 * ==========================================================================
 */
module.exports = {
  apps: [
    {
      name: 'urbancruise-api',
      script: './dist/index.js',
      instances: 'max',
      exec_mode: 'cluster',

      // Reload behaviour
      wait_ready: false,          // set true once index.ts calls process.send('ready')
      listen_timeout: 10000,
      kill_timeout: 15000,        // ms to wait for graceful shutdown before SIGKILL

      // Restart policy
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 2000,
      exp_backoff_restart_delay: 100,

      // Memory watchdog
      max_memory_restart: '512M',

      // Logs (files) — Pino also writes JSON to stdout; PM2 collects it here
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-err.log',
      merge_logs: true,
      time: true,

      // Watch is for dev only; production reloads via `pm2 reload`
      watch: false,

      // Env: dev defaults live in .env; PM2 env is only for the two below.
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
