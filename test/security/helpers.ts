import jwt from "jsonwebtoken";
import { config } from "../../src/config.ts";

const b64url = (obj: unknown) =>
  Buffer.from(JSON.stringify(obj)).toString("base64url");

/**
 * A fully valid token (signed with the server's real secret) whose payload has
 * been stuffed with attacker-chosen claims — role, tenant, admin flags, etc.
 * The server must ignore all of them and trust only the DB row for `sub`.
 */
export function forgedClaimsToken(sub: string, extraClaims: Record<string, unknown>): string {
  return jwt.sign({ ...extraClaims }, config.jwt.secret, { subject: sub, expiresIn: "1h" });
}

/** `{"alg":"none"}` unsigned token — the classic algorithm-confusion attack. */
export function algNoneToken(claims: Record<string, unknown>): string {
  const header = b64url({ alg: "none", typ: "JWT" });
  const payload = b64url({ ...claims, iat: Math.floor(Date.now() / 1000) });
  return `${header}.${payload}.`;
}

/** Correctly structured HS256 token signed with the wrong key. */
export function wrongKeyToken(sub: string, claims: Record<string, unknown> = {}): string {
  return jwt.sign(claims, "attacker-controlled-secret", { subject: sub, expiresIn: "1h" });
}

/** Flip one character in the payload segment of an otherwise valid token. */
export function tamperPayload(token: string): string {
  const [h, p, s] = token.split(".");
  const flipped = p!.slice(0, -2) + (p!.at(-2) === "A" ? "B" : "A") + p!.at(-1);
  return `${h}.${flipped}.${s}`;
}

export function expiredToken(sub: string): string {
  return jwt.sign({}, config.jwt.secret, { subject: sub, expiresIn: -3600 });
}

/** A well-formed uuid that does not belong to any seeded row. */
export const UNKNOWN_UUID = "99999999-9999-4999-8999-999999999999";
