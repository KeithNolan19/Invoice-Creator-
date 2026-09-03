import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";

/**
 * Authenticated symmetric encryption for secrets stored in the database
 * (Fire.com credentials, webhook signing keys). AES-256-GCM with the key from
 * `APP_ENCRYPTION_KEY`.
 *
 * Stored blob layout (bytea):
 *   [0]      version   (1 byte)   — selects the key; enables rotation
 *   [1..13)  iv        (12 bytes) — random per message
 *   [13..29) authTag   (16 bytes)
 *   [29..)   ciphertext
 *
 * A tampered blob fails `decipher.final()` and throws — ciphertext is never
 * returned unauthenticated.
 */

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = 1 + IV_LEN + TAG_LEN;

/** The key version new ciphertext is written with. */
export const KEY_VERSION = VERSION;

function keyForVersion(version: number): Buffer {
  if (version !== VERSION) {
    throw new Error(`secretbox: unknown key version ${version}`);
  }
  return config.encryptionKey;
}

export function encryptSecret(plaintext: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", keyForVersion(VERSION), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

export function decryptSecret(blob: Buffer): string {
  if (blob.length < HEADER_LEN) throw new Error("secretbox: ciphertext too short");
  const version = blob[0]!;
  const iv = blob.subarray(1, 1 + IV_LEN);
  const tag = blob.subarray(1 + IV_LEN, HEADER_LEN);
  const body = blob.subarray(HEADER_LEN);
  const decipher = createDecipheriv("aes-256-gcm", keyForVersion(version), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

/** Constant-time compare for verifying provided secrets (e.g. webhook tokens). */
export function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
