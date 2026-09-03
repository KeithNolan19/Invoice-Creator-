import { type Request, Router } from "express";
import { z } from "zod";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "../../auth/password.ts";
import { signAccessToken } from "../../auth/tokens.ts";
import { ensureAccountActive } from "../../auth/access.ts";
import { authenticate, requireAuth } from "../../auth/middleware.ts";
import type { Db } from "../../db/types.ts";
import { ApiError, unauthorized } from "../../http/errors.ts";
import type { LoginRateLimiter } from "../../http/rate-limit.ts";
import { findAuthUserByEmail } from "../users/users.repo.ts";

const loginSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
  })
  .strict();

const clientIp = (req: Request): string => req.ip || req.socket.remoteAddress || "unknown";

export function authRoutes(db: Db, rateLimiter?: LoginRateLimiter): Router {
  const router = Router();

  router.post("/login", async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const ip = clientIp(req);

    if (rateLimiter) {
      const retryAfter = rateLimiter.check(ip, email);
      if (retryAfter !== null) {
        res.set("Retry-After", String(retryAfter));
        throw new ApiError(429, "rate_limited", "Too many login attempts. Try again later.");
      }
    }

    // Pre-authentication lookup uses the narrow BYPASSRLS role (no tenant yet).
    const user = await db.bypassRls((q) => findAuthUserByEmail(q, email));

    // Always run a comparison to keep timing roughly uniform for unknown emails.
    const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!user || !ok) throw unauthorized("Invalid email or password");

    ensureAccountActive(user); // 403 for disabled account / suspended tenant

    rateLimiter?.succeed(ip, email);
    res.json({
      token: signAccessToken(user.id),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: user.tenant_id,
      },
    });
  });

  router.get("/me", authenticate(db), (req, res) => {
    const me = requireAuth(req);
    res.json({
      user: { id: me.userId, email: me.email, name: me.name, role: me.role, tenantId: me.tenantId },
    });
  });

  // Logout = revoke every token this user currently holds. Stateless clients
  // also discard their copy; this makes a stolen/leaked token stop working too.
  router.post("/logout", authenticate(db), async (req, res) => {
    const me = requireAuth(req);
    await db.withContext(me, (q) => q.query("SELECT revoke_tokens_for_current_user()"));
    res.status(204).end();
  });

  return router;
}
