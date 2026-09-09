/**
 * ==============================================================================
 * MSG91 HTTP client — shared axios instance
 * ==============================================================================
 * ONE axios instance for every MSG91 call — WhatsApp send, SMS send, template
 * lookup, wallet balance. Centralising means:
 *   • one place to swap the base URL when they move to control.msg91.eu
 *   • one place to add mTLS / signing headers
 *   • one interceptor block to normalise timeouts + errors
 *
 * `authkey` is a plain header on every request. MSG91 does NOT use Bearer.
 * Never log the header — pino redaction handles it via the shared redact list.
 * ==============================================================================
 */
import axios, { type AxiosInstance } from 'axios';
import { ENV } from '../../../config/env.js';

const MSG91_BASE = 'https://control.msg91.com/api';

export const msg91Client: AxiosInstance = axios.create({
  baseURL: MSG91_BASE,
  timeout: 8_000, // 8s — matches the "network timeout to MSG91" row in the failure matrix
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    authkey: ENV.MSG91_AUTH_KEY,
  },
});
