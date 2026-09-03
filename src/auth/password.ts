import bcrypt from "bcryptjs";
import { ApiError } from "../http/errors.ts";

const ROUNDS = 10;
const MIN_LENGTH = 12;
const MAX_LENGTH = 200;

// A tiny stop-list; a real deployment would use a large breached-password set.
const TOO_COMMON = new Set([
  "password1234",
  "passwordpassword",
  "123456789012",
  "qwertyuiop12",
  "letmein12345",
  "administrator",
  "welcome123456",
  "changemenow12",
  "invoicecreator",
]);

/** Enforced wherever a password is set through the API (e.g. admin-created users). */
export function assertPasswordAllowed(plain: string): void {
  if (typeof plain !== "string" || plain.length < MIN_LENGTH) {
    throw new ApiError(400, "weak_password", `Password must be at least ${MIN_LENGTH} characters`);
  }
  if (plain.length > MAX_LENGTH) {
    throw new ApiError(400, "weak_password", `Password must be at most ${MAX_LENGTH} characters`);
  }
  if (TOO_COMMON.has(plain.toLowerCase()) || /^(.)\1+$/.test(plain)) {
    throw new ApiError(400, "weak_password", "Password is too common");
  }
}

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * A valid bcrypt hash to compare against when the account does not exist, so an
 * unknown email costs roughly the same time as a known one.
 */
export const DUMMY_PASSWORD_HASH = bcrypt.hashSync("account-does-not-exist", ROUNDS);
