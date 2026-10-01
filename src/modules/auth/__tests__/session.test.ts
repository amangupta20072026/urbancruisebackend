/**
 * auth.service — session lifecycle unit tests (refresh, logout, getMe)
 *
 * Fakes: InMemoryOtpSessionStore, InMemoryAuthRepository, NoopAuditSink
 * No Redis, no MySQL, no network.
 *
 * JWT signing/verification DOES run — it uses the test secrets from setup.ts
 * which are real strings, so tokens are properly signed and verifiable.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { refreshSession, logout, getMe } from '../service/session.js';
import { buildAuthDeps } from '../infrastructure/AuthContainer.js';
import {
  InMemoryOtpSessionStore,
  InMemoryAuthRepository,
  NoopAuditSink,
} from '../infrastructure/testing/index.js';
import { signRefreshToken } from '../../../shared/auth/jwt.js';
import { hashForStorage } from '../../../shared/auth/tokens.js';
import { AuthError } from '../../../shared/errors/index.js';
import type { AuthSessionRow } from '../types.js';

/* --------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */

function baseSessionRow(overrides: Partial<AuthSessionRow> = {}): AuthSessionRow {
  return {
    id: 1,
    jti: 'jti-old',
    role: 'customer',
    entity_id: '42',
    sub_role: null,
    refresh_token_hash: '', // overridden per test
    previous_jti: null,
    device_id: 'dev-1',
    device_name: 'iPhone',
    platform: 'ios',
    app_version: '1.0.0',
    ip: null,
    user_agent: null,
    issued_at: new Date(),
    last_used_at: null,
    expires_at: new Date(Date.now() + 30 * 24 * 3_600_000),
    revoked_at: null,
    revoked_reason: null,
    ...overrides,
  };
}

const DEVICE = { id: 'dev-1', name: 'iPhone', platform: 'ios' as const, appVersion: '1.0.0' };

/* --------------------------------------------------------------------------
 * refreshSession
 * -------------------------------------------------------------------------- */

describe('refreshSession', () => {
  let store: InMemoryOtpSessionStore;
  let repo: InMemoryAuthRepository;

  beforeEach(() => {
    store = new InMemoryOtpSessionStore();
    repo = new InMemoryAuthRepository();
  });

  it('returns new access and refresh tokens', async () => {
    const oldRefreshToken = signRefreshToken({ sub: '42', jti: 'jti-old' });
    repo.seedSession(baseSessionRow({ refresh_token_hash: hashForStorage(oldRefreshToken) }));

    const deps = buildAuthDeps({ store, repo, audit: new NoopAuditSink() });
    const result = await refreshSession(deps, oldRefreshToken, DEVICE, null, null);

    expect(result.accessToken).toBeTypeOf('string');
    expect(result.refreshToken).toBeTypeOf('string');
    expect(result.refreshToken).not.toBe(oldRefreshToken);
  });

  it('revokes the old session and creates a new one', async () => {
    const oldRefreshToken = signRefreshToken({ sub: '42', jti: 'jti-old' });
    repo.seedSession(baseSessionRow({ refresh_token_hash: hashForStorage(oldRefreshToken) }));

    const deps = buildAuthDeps({ store, repo, audit: new NoopAuditSink() });
    await refreshSession(deps, oldRefreshToken, DEVICE, null, null);

    // old jti should now be revoked
    expect(repo.revokedSessions.some(r => r.jti === 'jti-old')).toBe(true);
    // a new session should have been created
    expect(repo.createdSessions.some(s => s.jti !== 'jti-old')).toBe(true);
  });

  it('deny-lists the old sid so its access token is immediately invalid', async () => {
    const oldRefreshToken = signRefreshToken({ sub: '42', jti: 'jti-old' });
    repo.seedSession(baseSessionRow({ refresh_token_hash: hashForStorage(oldRefreshToken) }));

    const deps = buildAuthDeps({ store, repo, audit: new NoopAuditSink() });
    await refreshSession(deps, oldRefreshToken, DEVICE, null, null);

    expect(store.isDenied('jti-old')).toBe(true);
  });

  it('updates the active-session index', async () => {
    const oldRefreshToken = signRefreshToken({ sub: '42', jti: 'jti-old' });
    repo.seedSession(baseSessionRow({ refresh_token_hash: hashForStorage(oldRefreshToken) }));
    await store.addActiveSession('customer', '42', 'jti-old');

    const deps = buildAuthDeps({ store, repo, audit: new NoopAuditSink() });
    await refreshSession(deps, oldRefreshToken, DEVICE, null, null);

    const activeSessions = store.getActiveSessions('customer', '42');
    expect(activeSessions.has('jti-old')).toBe(false);
    expect(activeSessions.size).toBe(1); // the new jti
  });

  it('throws SESSION_REVOKED when session is not found', async () => {
    const orphanToken = signRefreshToken({ sub: '42', jti: 'jti-nonexistent' });
    const deps = buildAuthDeps({ store, repo, audit: new NoopAuditSink() });
    await expect(refreshSession(deps, orphanToken, DEVICE, null, null)).rejects.toMatchObject({
      code: 'session_revoked',
    });
  });

  it('throws SESSION_REVOKED and revokes ALL sessions on reuse detection', async () => {
    const oldRefreshToken = signRefreshToken({ sub: '42', jti: 'jti-old' });
    // Seed the session as ALREADY revoked (reuse scenario)
    repo.seedSession(
      baseSessionRow({
        refresh_token_hash: hashForStorage(oldRefreshToken),
        revoked_at: new Date(Date.now() - 60_000),
        revoked_reason: 'rotation',
      }),
    );
    // Also seed another active session for the same entity
    repo.seedSession(
      baseSessionRow({
        jti: 'jti-other',
        entity_id: '42',
        revoked_at: null,
        refresh_token_hash: 'h2',
      }),
    );

    const deps = buildAuthDeps({ store, repo, audit: new NoopAuditSink() });
    await expect(refreshSession(deps, oldRefreshToken, DEVICE, null, null)).rejects.toMatchObject({
      code: 'session_revoked',
    });

    // All sessions for entity '42' should be revoked
    expect(repo.revokedSessions.some(r => r.reason === 'reuse_detected')).toBe(true);
  });

  it('throws REFRESH_INVALID when token hash does not match', async () => {
    const realToken = signRefreshToken({ sub: '42', jti: 'jti-old' });
    repo.seedSession(baseSessionRow({ refresh_token_hash: 'wrong-hash' }));

    const deps = buildAuthDeps({ store, repo, audit: new NoopAuditSink() });
    await expect(refreshSession(deps, realToken, DEVICE, null, null)).rejects.toMatchObject({
      code: 'refresh_invalid',
    });
  });

  it('throws AuthError on a cryptographically invalid refresh token', async () => {
    const deps = buildAuthDeps({ store, repo, audit: new NoopAuditSink() });
    await expect(refreshSession(deps, 'not.a.jwt', DEVICE, null, null)).rejects.toBeInstanceOf(
      AuthError,
    );
  });
});

/* --------------------------------------------------------------------------
 * logout
 * -------------------------------------------------------------------------- */

describe('logout — scope=current', () => {
  let store: InMemoryOtpSessionStore;
  let repo: InMemoryAuthRepository;

  beforeEach(() => {
    store = new InMemoryOtpSessionStore();
    repo = new InMemoryAuthRepository();
  });

  it('marks the current session revoked and deny-lists its sid', async () => {
    repo.seedSession(baseSessionRow({ jti: 'jti-current' }));
    await store.addActiveSession('customer', '42', 'jti-current');

    const deps = buildAuthDeps({ store, repo, audit: new NoopAuditSink() });
    await logout(deps, {
      identityRole: 'customer',
      identityEntityId: '42',
      identitySessionId: 'jti-current',
      scope: 'current',
    });

    expect(repo.revokedSessions.some(r => r.jti === 'jti-current' && r.reason === 'logout')).toBe(
      true,
    );
    expect(store.isDenied('jti-current')).toBe(true);
    expect(store.getActiveSessions('customer', '42').has('jti-current')).toBe(false);
  });
});

describe('logout — scope=all', () => {
  let store: InMemoryOtpSessionStore;
  let repo: InMemoryAuthRepository;

  beforeEach(() => {
    store = new InMemoryOtpSessionStore();
    repo = new InMemoryAuthRepository();
  });

  it('revokes every active session and deny-lists all their sids', async () => {
    repo.seedSession(baseSessionRow({ jti: 'jti-A' }));
    repo.seedSession(baseSessionRow({ jti: 'jti-B', id: 2 }));
    await store.addActiveSession('customer', '42', 'jti-A');
    await store.addActiveSession('customer', '42', 'jti-B');

    const deps = buildAuthDeps({ store, repo, audit: new NoopAuditSink() });
    await logout(deps, {
      identityRole: 'customer',
      identityEntityId: '42',
      identitySessionId: 'jti-A',
      scope: 'all',
    });

    expect(store.isDenied('jti-A')).toBe(true);
    expect(store.isDenied('jti-B')).toBe(true);
    // active-session set is fully cleared
    expect(store.getActiveSessions('customer', '42').size).toBe(0);
    // both sessions revoked in DB
    expect(repo.revokedSessions.some(r => r.jti === 'jti-A')).toBe(true);
    expect(repo.revokedSessions.some(r => r.jti === 'jti-B')).toBe(true);
  });
});

/* --------------------------------------------------------------------------
 * getMe
 * -------------------------------------------------------------------------- */

describe('getMe', () => {
  let store: InMemoryOtpSessionStore;
  let repo: InMemoryAuthRepository;

  beforeEach(() => {
    store = new InMemoryOtpSessionStore();
    repo = new InMemoryAuthRepository();
    repo.seedUser({
      mobile: '919812345678',
      role: 'customer',
      entityId: '42',
      userId: '42',
      subRole: null,
      status: 'active',
      requiresProfileSetup: false,
    });
  });

  it('returns authoritative identity data on happy path', async () => {
    const deps = buildAuthDeps({ store, repo, audit: new NoopAuditSink() });
    const result = await getMe(deps, {
      identityUserId: '42',
      identityRole: 'customer',
      identitySubRole: null,
      identityEntityId: '42',
      identitySessionId: 'jti-live',
    });

    expect(result.userId).toBe('42');
    expect(result.role).toBe('customer');
    expect(result.requiresProfileSetup).toBe(false);
    expect(result.profile).toBeDefined();
  });

  it('throws SESSION_ORPHANED when entity row no longer exists', async () => {
    repo.reset(); // remove all users — entity is gone

    const deps = buildAuthDeps({ store, repo, audit: new NoopAuditSink() });
    await expect(
      getMe(deps, {
        identityUserId: '42',
        identityRole: 'customer',
        identitySubRole: null,
        identityEntityId: '42',
        identitySessionId: 'jti-live',
      }),
    ).rejects.toMatchObject({ code: 'session_orphaned' });
  });

  it('deny-lists the session sid when entity is gone (orphan protection)', async () => {
    repo.reset();

    const deps = buildAuthDeps({ store, repo, audit: new NoopAuditSink() });
    await getMe(deps, {
      identityUserId: '42',
      identityRole: 'customer',
      identitySubRole: null,
      identityEntityId: '42',
      identitySessionId: 'jti-orphan',
    }).catch(() => null);

    expect(store.isDenied('jti-orphan')).toBe(true);
  });
});
