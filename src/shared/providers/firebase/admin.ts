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
 * ==============================================================================
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { initializeApp, getApps, getApp, cert } from 'firebase-admin/app';
import { getMessaging as _getMessaging } from 'firebase-admin/messaging';
import type { App } from 'firebase-admin/app';
import type { Messaging } from 'firebase-admin/messaging';

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

  // noPropertyAccessFromIndexSignature is on — must use bracket notation
  const accountPath = process.env['FIREBASE_SERVICE_ACCOUNT_PATH'];
  if (!accountPath) {
    throw new Error(
      '[firebase/admin] FIREBASE_SERVICE_ACCOUNT_PATH is not set. ' +
        'Point it to your service-account.json file path.',
    );
  }

  let raw: string;
  try {
    raw = readFileSync(resolve(accountPath), 'utf8');
  } catch (err) {
    throw new Error(
      `[firebase/admin] Failed to read service account at "${accountPath}": ${String(err)}`,
      { cause: err },
    );
  }

  const serviceAccount = JSON.parse(raw) as {
    projectId?: string;
    clientEmail?: string;
    privateKey?: string;
  };

  const app = initializeApp({ credential: cert(serviceAccount) });
  logger.info({ path: accountPath }, 'firebase-admin initialized');
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
