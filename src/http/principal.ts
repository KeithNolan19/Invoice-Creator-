import type { RlsContext } from "../db/types.ts";

/** The authenticated caller, attached to `req.auth` by the auth middleware. */
export interface AuthPrincipal extends RlsContext {
  role: "user" | "admin";
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
