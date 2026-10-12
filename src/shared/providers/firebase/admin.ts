/**
 * Initializes firebase-admin once from FIREBASE_SERVICE_ACCOUNT_PATH.
 * env.ts already checks the file at startup; the checks here only catch it
 * changing afterwards, and throw a readable error.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { initializeApp, getApps, getApp, cert } from 'firebase-admin/app';
import { getMessaging as _getMessaging } from 'firebase-admin/messaging';
import type { App, ServiceAccount } from 'firebase-admin/app';
import type { Messaging } from 'firebase-admin/messaging';

import { ENV } from '../../../config/env.js';
import { logger } from '../../logger/index.js';

function initAdmin(): App {
  // Reuse the existing app (e.g. after a dev reload) instead of failing.
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
    // cert() rejects bad keys or missing fields; its message has no key data.
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

/** FCM Messaging bound to this app. Use this instead of firebase's getMessaging(). */
export function getMessaging(): Messaging {
  return _getMessaging(firebaseApp);
}
