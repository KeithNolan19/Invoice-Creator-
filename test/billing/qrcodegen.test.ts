import { describe, expect, it } from "vitest";
import { QrCode, qrSvg, qrSvgDataUri } from "../../src/lib/qrcodegen.ts";

/** Read the 3x3 dark-count of a finder pattern's inner square at (cx,cy). */
function finderInnerAllDark(qr: QrCode, cx: number, cy: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!qr.getModule(cx + dx, cy + dy)) return false;
    }
  }
  return true;
}

describe("QR code generator", () => {
  it("produces the right symbol size for the data length", () => {
    // A ~34-char URL in byte mode + ECC M lands at version 3 → 29 modules.
    const qr = QrCode.encodeText("https://payments.fire.com/ucli3krk", "MEDIUM");
    expect(qr.size).toBe(29);
    expect(qr.version).toBe(3);
  });

  it("places the three finder patterns", () => {
    const qr = QrCode.encodeText("https://payments.fire.com/ucli3krk", "MEDIUM");
    const n = qr.size;
    expect(finderInnerAllDark(qr, 3, 3)).toBe(true); // top-left
    expect(finderInnerAllDark(qr, n - 4, 3)).toBe(true); // top-right
    expect(finderInnerAllDark(qr, 3, n - 4)).toBe(true); // bottom-left
    // separator: the module just inside the bottom-right of the top-left finder
    // ring is light
    expect(qr.getModule(5, 5)).toBe(false);
  });

  it("keeps the timing patterns alternating", () => {
    const qr = QrCode.encodeText("PAY", "MEDIUM");
    for (let i = 8; i < qr.size - 8; i++) {
      expect(qr.getModule(i, 6)).toBe(i % 2 === 0);
      expect(qr.getModule(6, i)).toBe(i % 2 === 0);
    }
  });

  it("scales the version up as the payload grows", () => {
    const small = QrCode.encodeText("A", "MEDIUM");
    const big = QrCode.encodeText("x".repeat(400), "MEDIUM");
    expect(small.version).toBeLessThan(big.version);
    expect(big.size).toBe(big.version * 4 + 17);
  });

  it("is deterministic", () => {
    const a = qrSvg("https://payments.fire.com/abcd1234");
    const b = qrSvg("https://payments.fire.com/abcd1234");
    expect(a).toBe(b);
    expect(a).not.toBe(qrSvg("https://payments.fire.com/abcd1235"));
  });

  it("emits a self-contained SVG data URI", () => {
    const uri = qrSvgDataUri("https://payments.fire.com/ucli3krk");
    expect(uri.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const svg = Buffer.from(uri.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
    expect(svg).toContain("<svg");
    expect(svg).toContain("viewBox");
    expect(svg).not.toContain("<script");
  });

  it("rejects data that cannot fit any version", () => {
    expect(() => QrCode.encodeText("z".repeat(5000), "HIGH")).toThrow();
  });
});
