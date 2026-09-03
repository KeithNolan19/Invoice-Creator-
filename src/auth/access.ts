import { ApiError } from "../http/errors.ts";
import type { AuthUserRow } from "../modules/users/users.repo.ts";

/**
 * Rejects an otherwise-authenticated identity whose access has been revoked:
 * a disabled user account, or a user whose tenant has been suspended. Admins
 * (tenant_id / tenant_status null) are never blocked here.
 */
export function ensureAccountActive(user: Pick<AuthUserRow, "disabled_at" | "tenant_status">): void {
  if (user.disabled_at) {
    throw new ApiError(403, "account_disabled", "This account has been disabled");
  }
  if (user.tenant_status === "suspended") {
    throw new ApiError(403, "tenant_suspended", "This tenant is currently suspended");
  }
}
