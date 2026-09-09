/**
 * ==============================================================================
 * auth — controller (HTTP glue only)
 * ==============================================================================
 * NO business logic. Reads validated req.body / req.headers, calls the service,
 * writes the response envelope. Errors bubble up to shared errorHandler.
 * ==============================================================================
 */
import type { Request, Response } from 'express';
import { ok, created, noContent, getIdentity } from '../../shared/http/responses.js';
import { HEADER_IDEMPOTENCY_KEY } from '../../config/constants.js';
import * as service from './service.js';
import type { RequestOtpBody, VerifyOtpBody, RefreshBody, LogoutBody } from './schemas.js';

export async function postRequestOtp(req: Request, res: Response): Promise<Response> {
  const body = req.body as RequestOtpBody;
  const idem = req.header(HEADER_IDEMPOTENCY_KEY) ?? null;

  const out = await service.sendOtp({
    phone: body.phone,
    countryCode: body.countryCode,
    role: body.role,
    idempotencyKey: idem,
    ip: clientIp(req),
  });
  return ok(res, out);
}

export async function postVerifyOtp(req: Request, res: Response): Promise<Response> {
  const body = req.body as VerifyOtpBody;

  const out = await service.verifyOtp({
    phone: body.phone,
    countryCode: body.countryCode,
    role: body.role,
    otp: body.otp,
    ...(body.requestId ? { requestId: body.requestId } : {}),
    device: body.device,
    ip: clientIp(req),
    userAgent: req.header('user-agent') ?? null,
  });
  // 201 semantically — a new session was created.
  return created(res, out);
}

export async function postRefresh(req: Request, res: Response): Promise<Response> {
  const body = req.body as RefreshBody;

  // Refresh doesn't require a valid access token — the refresh token IS the
  // authentication. Device metadata is best-effort (client may not send it).
  const device = extractDevice(req) ?? {
    id: 'unknown-device',
    name: 'Unknown device',
    platform: 'ios' as const,
    appVersion: '0.0.0 (0)',
  };

  const out = await service.refreshSession(
    body.refreshToken,
    device,
    clientIp(req),
    req.header('user-agent') ?? null,
  );
  return ok(res, out);
}

export async function postLogout(req: Request, res: Response): Promise<Response> {
  const body = (req.body ?? {}) as LogoutBody;
  const identity = getIdentity(req);

  await service.logout({
    identityRole: identity.role,
    identityEntityId: identity.entityId,
    identitySessionId: identity.sessionId,
    scope: body.scope ?? 'current',
  });
  return noContent(res);
}

/* -----------------------------------------------------------------
 * Helpers
 * ----------------------------------------------------------------- */

function clientIp(req: Request): string | null {
  // Express with `trust proxy` populates req.ip correctly from
  // X-Forwarded-For — set in security.ts / applySecurity.
  return req.ip ?? null;
}

function extractDevice(
  req: Request,
): { id: string; name: string; platform: 'ios' | 'android' | 'web'; appVersion: string } | null {
  type MaybeDevice = { id?: unknown; name?: unknown; platform?: unknown; appVersion?: unknown };
  const b = req.body as { device?: MaybeDevice };
  const d = b?.device;
  if (!d || typeof d !== 'object') return null;
  if (
    typeof d.id !== 'string' ||
    typeof d.name !== 'string' ||
    typeof d.platform !== 'string' ||
    typeof d.appVersion !== 'string'
  ) {
    return null;
  }
  if (d.platform !== 'ios' && d.platform !== 'android' && d.platform !== 'web') return null;
  return { id: d.id, name: d.name, platform: d.platform, appVersion: d.appVersion };
}
