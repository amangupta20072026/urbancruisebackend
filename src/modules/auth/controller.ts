/** auth controller. Passes authDeps to each service call; no business logic. */
import type { Request, Response } from 'express';
import { ok, created, noContent, getIdentity } from '../../shared/http/responses.js';
import { HEADER_IDEMPOTENCY_KEY } from '../../config/constants.js';
import { authDeps } from './infrastructure/AuthContainer.js';
import * as service from './service/index.js';
import type {
  RequestOtpBody,
  VerifyOtpBody,
  RefreshBody,
  LogoutBody,
  CustomerOnboardBody,
} from './schemas.js';

export async function postRequestOtp(req: Request, res: Response): Promise<Response> {
  const body = req.body as RequestOtpBody;
  const idem = req.header(HEADER_IDEMPOTENCY_KEY) ?? null;

  const out = await service.sendOtp(authDeps, {
    phone: body.phone,
    countryCode: body.countryCode,
    role: body.role,
    idempotencyKey: idem,
    ip: clientIp(req),
    ...(body.captchaToken ? { captchaToken: body.captchaToken } : {}),
  });
  return ok(res, out);
}

export async function postVerifyOtp(req: Request, res: Response): Promise<Response> {
  const body = req.body as VerifyOtpBody;

  const out = await service.verifyOtp(authDeps, {
    phone: body.phone,
    countryCode: body.countryCode,
    role: body.role,
    otp: body.otp,
    ...(body.requestId ? { requestId: body.requestId } : {}),
    device: body.device,
    ip: clientIp(req),
    userAgent: req.header('user-agent') ?? null,
  });
  res.setHeader('Cache-Control', 'no-store');
  // 201 when a session was created; 200 when the client must onboard first.
  return out.status === 'authenticated' ? created(res, out) : ok(res, out);
}

export async function postCustomerOnboard(req: Request, res: Response): Promise<Response> {
  const body = req.body as CustomerOnboardBody;

  const out = await service.completeCustomerOnboarding(authDeps, {
    onboardingToken: body.onboardingToken,
    details: {
      firstName: body.firstName,
      lastName: body.lastName ?? null,
      email: body.email ?? null,
    },
    device: body.device,
    ip: clientIp(req),
    userAgent: req.header('user-agent') ?? null,
  });
  res.setHeader('Cache-Control', 'no-store');
  return created(res, out);
}

export async function postRefresh(req: Request, res: Response): Promise<Response> {
  const body = req.body as RefreshBody;

  // Without a device, the service reuses the previous session's.
  const out = await service.refreshSession(
    authDeps,
    body.refreshToken,
    body.device ?? null,
    clientIp(req),
    req.header('user-agent') ?? null,
  );
  res.setHeader('Cache-Control', 'no-store');
  return ok(res, out);
}

export async function postLogout(req: Request, res: Response): Promise<Response> {
  const body = (req.body ?? {}) as LogoutBody;
  const identity = getIdentity(req);

  await service.logout(authDeps, {
    identityRole: identity.role,
    identityEntityId: identity.entityId,
    identitySessionId: identity.sessionId,
    scope: body.scope ?? 'current',
  });
  return noContent(res);
}

export async function getMe(req: Request, res: Response): Promise<Response> {
  const identity = getIdentity(req);

  const out = await service.getMe(authDeps, {
    identityUserId: identity.userId,
    identityRole: identity.role,
    identityEntityId: identity.entityId,
    identitySessionId: identity.sessionId,
  });

  res.setHeader('Cache-Control', 'no-store');
  return ok(res, out);
}

function clientIp(req: Request): string | null {
  return req.ip ?? null;
}
