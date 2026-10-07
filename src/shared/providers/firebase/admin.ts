/**
 * ==============================================================================
 * Firebase Admin SDK — singleton initializer (firebase-admin v14)
 * ==============================================================================
 * Uses the modular sub-package API that firebase-admin v14 exports:
 *   import { initializeApp, getApps, getApp } from 'firebase-admin/app';
 *   import { getMessaging }                   from 'firebase-admin/messaging';
 *
 * The old namespace-style imports (admin.messaging(), admin.apps, etc.)
 * were removed in firebase-admin v12+. The sub-package pattern is the
 * officially documented approach for v12–v14:
 *   https://firebase.google.com/docs/admin/setup#initialize_the_sdk_in_non-google_environments
 *
 * CONFIG (fix B2):
 *   The service-account path comes from the validated ENV object, never from
 *   process.env directly. config/env.ts has already confirmed at boot that
 *   FIREBASE_SERVICE_ACCOUNT_PATH is set and that the file exists, is
 *   readable, is valid JSON and contains project_id / client_email /
 *   private_key — so a misconfiguration stops the process there with a clear
 *   message, before this module is ever loaded.
 *
 *   The checks below remain as a safety net (e.g. the file is deleted or
 *   replaced between boot and this import) and always throw an Error with a
 *   readable message and the original cause attached.
 * ==============================================================================
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { initializeApp, getApps, getApp, cert } from 'firebase-admin/app';
import { getMessaging as _getMessaging } from 'firebase-admin/messaging';
import type { App, ServiceAccount } from 'firebase-admin/app';
import type { Messaging } from 'firebase-admin/messaging';

import { ENV } from '../../../config/env.js';
import { logger } from '../../logger/index.js';

/* --------------------------------------------------------------------------
 * One-time initialization
 * -------------------------------------------------------------------------- */

function initAdmin(): App {
  // Guard: if already initialized (e.g. in dev hot-reload), return the
  // default app rather than throwing "app already exists".
  if (getApps().length > 0) {
    return getApp();
  }

  const accountPath = resolve(ENV.FIREBASE_SERVICE_ACCOUNT_PATH);

  let raw: string;
  try {
    raw = readFileSync(accountPath, 'utf8');
  } catch (err) {
    throw new Error(`[firebase/admin] Failed to read service account at "${accountPath}".`, {
      cause: err,
    });
  }

  let serviceAccount: ServiceAccount;
  try {
    serviceAccount = JSON.parse(raw) as ServiceAccount;
  } catch (err) {
    throw new Error(`[firebase/admin] Service account at "${accountPath}" is not valid JSON.`, {
      cause: err,
    });
  }

  let app: App;
  try {
    app = initializeApp({ credential: cert(serviceAccount) });
  } catch (err) {
    // cert() rejects a malformed private key or missing fields. The error
    // message from firebase-admin never contains the key itself.
    throw new Error(
      `[firebase/admin] Service account at "${accountPath}" was rejected by firebase-admin: ${
        (err as Error).message
      }`,
      { cause: err },
    );
  }

  logger.info('firebase-admin initialized');
  return app;
}

export const firebaseApp: App = initAdmin();

/**
 * Returns the Messaging instance for the initialized app.
 * Callers import this instead of calling getMessaging() directly so they
 * always use the same app instance without coupling to initAdmin().
 */
export function getMessaging(): Messaging {
  return _getMessaging(firebaseApp);
}
