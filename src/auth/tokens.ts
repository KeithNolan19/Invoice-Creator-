import jwt from "jsonwebtoken";
import { config } from "../config.ts";

export interface AccessTokenClaims {
  sub: string; // user id
  /** Millisecond issued-at, so revocation can be finer than `iat`'s 1-second resolution. */
  ims?: number;
  iat: number;
  exp: number;
}

export function signAccessToken(userId: string): string {
  return jwt.sign({ ims: Date.now() }, config.jwt.secret, {
    subject: userId,
    expiresIn: config.jwt.expiresIn as jwt.SignOptions["expiresIn"],
  });
}

export class InvalidTokenError extends Error {}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    if (typeof decoded === "string" || typeof decoded.sub !== "string") {
      throw new InvalidTokenError("Malformed token");
    }
    return decoded as AccessTokenClaims;
  } catch (err) {
    if (err instanceof InvalidTokenError) throw err;
    throw new InvalidTokenError("Invalid or expired token");
  }
}

/** Issued-at in milliseconds, falling back to the second-resolution `iat`. */
export function tokenIssuedAtMs(claims: AccessTokenClaims): number {
  return typeof claims.ims === "number" ? claims.ims : claims.iat * 1000;
}
