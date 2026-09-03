import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Db } from "../db/types.ts";
import { forbidden, unauthorized } from "../http/errors.ts";
import type { AuthPrincipal } from "../http/principal.ts";
import { findAuthUserById } from "../modules/users/users.repo.ts";
import { ensureAccountActive } from "./access.ts";
import { InvalidTokenError, tokenIssuedAtMs, verifyAccessToken } from "./tokens.ts";

function bearerToken(req: Request): string | null {
  const header = req.get("authorization");
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !value) return null;
  return value.trim();
}

function tokenIsRevoked(issuedAtMs: number, invalidBefore: string | Date | null): boolean {
  if (!invalidBefore) return false;
  const cutoff = invalidBefore instanceof Date ? invalidBefore.getTime() : Date.parse(invalidBefore);
  return Number.isFinite(cutoff) && issuedAtMs < cutoff;
}

/**
 * Verifies the access token and loads the current user (via the narrow
 * `bypassRls` role, so it works before any tenant context exists). Rejects
 * revoked tokens, disabled accounts and suspended tenants. Populates `req.auth`.
 *
 * `role`, `tenant_id` and admin status come exclusively from the freshly-read
 * database row — never from the token payload.
 */
export function authenticate(db: Db): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = bearerToken(req);
      if (!token) throw unauthorized();

      let claims;
      try {
        claims = verifyAccessToken(token);
      } catch (err) {
        if (err instanceof InvalidTokenError) throw unauthorized(err.message);
        throw err;
      }

      const user = await db.bypassRls((q) => findAuthUserById(q, claims.sub));
      if (!user) throw unauthorized("Account no longer exists");
      // Disabled account / suspended tenant first — a specific 403 is more useful
      // to the client than the generic "session expired".
      ensureAccountActive(user);
      if (tokenIsRevoked(tokenIssuedAtMs(claims), user.tokens_invalid_before)) {
        throw unauthorized("Session expired");
      }

      const principal: AuthPrincipal = {
        userId: user.id,
        tenantId: user.tenant_id,
        isAdmin: user.role === "admin",
        role: user.role,
        tenantRole: user.tenant_role,
        email: user.email,
        name: user.name,
      };
      req.auth = principal;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireAuth(req: Request): AuthPrincipal {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.auth) return next(unauthorized());
  if (!req.auth.isAdmin) return next(forbidden("Admin access required"));
  next();
};

/**
 * Gate for tenant-admin-only actions (business settings, the Fire.com
 * integration, team management, voiding invoices). Resolved from `req.auth`,
 * which the DB row populates — never from the token or request body. Platform
 * admins operate through the Admin Control Centre, not the customer app, so they
 * do not pass this gate.
 */
export const requireTenantAdmin: RequestHandler = (req, _res, next) => {
  if (!req.auth) return next(unauthorized());
  if (req.auth.tenantRole !== "admin") return next(forbidden("Tenant admin access required"));
  next();
};
