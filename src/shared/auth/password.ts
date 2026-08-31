/**
 * ==============================================================================
 * Password hashing — bcrypt
 * ==============================================================================
 * Cost from env (12 minimum in 2026). Any hash under cost=10 is a security
 * red flag; env.ts refuses to start below 10.
 * ==============================================================================
 */
import bcrypt from 'bcrypt';
import { ENV } from '../../config/env.js';

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, ENV.BCRYPT_COST);

export const verifyPassword = (plain: string, hash: string): Promise<boolean> =>
  bcrypt.compare(plain, hash);
