import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, KEY_VERSION, secretsEqual } from "../../src/crypto/secretbox.ts";

describe("secretbox — AES-256-GCM", () => {
  it("round-trips arbitrary strings", () => {
    for (const s of ["", "hello", "a".repeat(5000), "🔐 unicode — ok", JSON.stringify({ a: 1 })]) {
      expect(decryptSecret(encryptSecret(s))).toBe(s);
    }
  });

  it("produces a fresh nonce each time (ciphertext differs for the same input)", () => {
    const a = encryptSecret("same");
    const b = encryptSecret("same");
    expect(a.equals(b)).toBe(false);
    expect(decryptSecret(a)).toBe("same");
    expect(decryptSecret(b)).toBe("same");
  });

  it("stamps the current key version in byte 0", () => {
    expect(encryptSecret("x")[0]).toBe(KEY_VERSION);
  });

  const flip = (b: Buffer, i: number) => b.writeUInt8(b.readUInt8(i) ^ 0x01, i);

  it("rejects a tampered ciphertext (auth tag mismatch)", () => {
    const blob = encryptSecret("secret-value");
    flip(blob, blob.length - 1); // flip a bit in the body
    expect(() => decryptSecret(blob)).toThrow();
  });

  it("rejects a tampered auth tag", () => {
    const blob = encryptSecret("secret-value");
    flip(blob, 14); // inside the tag region
    expect(() => decryptSecret(blob)).toThrow();
  });

  it("rejects an unknown key version", () => {
    const blob = encryptSecret("secret-value");
    blob[0] = 99;
    expect(() => decryptSecret(blob)).toThrow(/key version/i);
  });

  it("rejects a truncated blob", () => {
    expect(() => decryptSecret(Buffer.alloc(4))).toThrow(/too short/i);
  });

  it("secretsEqual is length-safe and correct", () => {
    expect(secretsEqual("abc", "abc")).toBe(true);
    expect(secretsEqual("abc", "abd")).toBe(false);
    expect(secretsEqual("abc", "abcd")).toBe(false);
    expect(secretsEqual("", "")).toBe(true);
  });
});
