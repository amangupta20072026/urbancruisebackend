/**
 * ==============================================================================
 * auth.repository — barrel
 * ==============================================================================
 * Consumers still write:
 *
 *   import * as repo from '../repository/index.js';
 *   await repo.findCustomerByPhone(mobile);
 *   await repo.createSession(...);
 *
 * The split into per-table files is an implementation detail; the barrel
 * keeps the outward-facing API stable so nothing else in the module has
 * to know how the persistence layer is organised.
 *
 * If you find yourself adding a re-export here for a function that only ONE
 * file consumes, prefer importing that file directly at the call site — the
 * barrel is for shared surface, not everything-goes.
 * ==============================================================================
 */
export * from './mobile-registry.js';
export * from './users.js';
export * from './sessions.js';
export * from './audit.js';
