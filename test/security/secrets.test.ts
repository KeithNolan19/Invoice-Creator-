import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Requirement 8 — no committed secrets; frontend carries no privileged config. */

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// Patterns that would indicate a real embedded credential.
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["postgres connection string with password", /postgres(?:ql)?:\/\/[^\s:'"]+:[^\s@'"]{3,}@/i],
  ["aws access key id", /AKIA[0-9A-Z]{16}/],
  ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["generic api key assignment", /(?:api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*['"][A-Za-z0-9/+_-]{16,}['"]/i],
];

describe("source and frontend contain no hard-coded credentials", () => {
  it("src/ and web/ are clean", () => {
    const files = [
      ...walk(path.join(repoRoot, "src")),
      ...walk(path.join(repoRoot, "web")),
    ].filter((f) => /\.(ts|js|json|html|css|sql)$/.test(f));

    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const [label, re] of SECRET_PATTERNS) {
        if (re.test(text)) hits.push(`${path.relative(repoRoot, file)}: ${label}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("the served admin bundle exposes no DB / secret / connection detail", () => {
    for (const f of ["web/admin/index.html", "web/admin/app.js", "web/admin/styles.css"]) {
      const text = read(f);
      expect(text).not.toMatch(/postgres(?:ql)?:\/\//i);
      expect(text).not.toMatch(/DATABASE_URL|DATABASE_ADMIN_URL|JWT_SECRET|password_hash|BYPASSRLS/);
      expect(text).not.toMatch(/invoice_app_login|invoice_owner/);
    }
  });
});

describe("environment configuration", () => {
  it(".gitignore excludes .env files but keeps .env.example", () => {
    const gi = read(".gitignore");
    expect(gi).toMatch(/^\.env$/m);
    expect(gi).toMatch(/^\.env\.\*$/m);
    expect(gi).toMatch(/^!\.env\.example$/m);
  });

  it(".env is not present in the working tree", () => {
    expect(() => statSync(path.join(repoRoot, ".env"))).toThrow();
  });

  it(".env.example holds placeholders only", () => {
    const ex = read(".env.example");
    // JWT secret is a placeholder, not a usable value
    const jwt = ex.match(/^JWT_SECRET=(.+)$/m)?.[1] ?? "";
    expect(jwt).toMatch(/replace|change|placeholder|example/i);
    // DB URLs use CHANGE_ME, never a real password
    for (const line of ex.split("\n").filter((l) => l.startsWith("DATABASE"))) {
      expect(line).toMatch(/CHANGE_ME|localhost/);
      expect(line).not.toMatch(/:\s*[A-Za-z0-9]{12,}@/);
    }
  });

  it("config refuses the insecure default JWT secret in production", async () => {
    // config.ts is evaluated once at import; assert the guard exists in source.
    const src = read("src/config.ts");
    expect(src).toMatch(/isProduction[\s\S]*JWT_SECRET must be set/);
  });
});
