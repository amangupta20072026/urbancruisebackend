/**
 * Shared axios instance for MSG91. Auth is the plain `authkey` header (not
 * Bearer). 'authkey' is not in the log redact list, so never log these
 * request headers.
 */
import axios, { type AxiosInstance } from 'axios';
import { ENV } from '../../../config/env.js';

const MSG91_BASE = 'https://control.msg91.com/api';

export const msg91Client: AxiosInstance = axios.create({
  baseURL: MSG91_BASE,
  timeout: 8_000,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    authkey: ENV.MSG91_AUTH_KEY,
  },
});
