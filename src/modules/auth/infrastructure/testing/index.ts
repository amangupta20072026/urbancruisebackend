/**
 * auth module — test doubles barrel
 *
 * Single import for all in-memory fakes:
 *
 *   import {
 *     InMemoryOtpSessionStore,
 *     InMemoryAuthRepository,
 *     SpyAuditSink,
 *     NoopAuditSink,
 *   } from '.../infrastructure/testing/index.js';
 */
export { InMemoryOtpSessionStore } from './InMemoryOtpSessionStore.js';
export { InMemoryAuthRepository } from './InMemoryAuthRepository.js';
export { SpyAuditSink, NoopAuditSink } from './AuditSinkFakes.js';
