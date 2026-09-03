import type { RlsContext } from "../db/types.ts";

/** The authenticated caller, attached to `req.auth` by the auth middleware. */
export interface AuthPrincipal extends RlsContext {
  /** Platform role. `admin` = platform operator (Admin Control Centre). */
  role: "user" | "admin";
  /** Role within the tenant. null for platform admins. Resolved from the DB row. */
  tenantRole: "admin" | "member" | null;
  email: string;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthPrincipal;
    }
  }
}

export {};
