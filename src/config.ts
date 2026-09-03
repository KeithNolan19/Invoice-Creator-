import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
const env = process.env.NODE_ENV ?? "development";
const isProduction = env === "production";

const DEV_JWT_SECRET = "dev-only-insecure-secret-change-me";
const jwtSecret = required("JWT_SECRET", isProduction ? undefined : DEV_JWT_SECRET);

// Fail fast rather than ship a guessable signing key.
if (isProduction && (jwtSecret === DEV_JWT_SECRET || jwtSecret.length < 32)) {
  throw new Error("JWT_SECRET must be set to a strong value (>= 32 chars) in production");
}

// AES-256-GCM key for secrets stored in the DB (Fire.com credentials, webhook
// signing keys). Base64 of exactly 32 bytes. Required in production.
const DEV_ENCRYPTION_KEY_B64 = Buffer.from("dev-encryption-key-not-for-prod!").toString("base64"); // 32 bytes
function loadEncryptionKey(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY || (isProduction ? "" : DEV_ENCRYPTION_KEY_B64);
  if (!raw) {
    throw new Error(
      "APP_ENCRYPTION_KEY is required in production. Generate: " +
        `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(`APP_ENCRYPTION_KEY must be base64 of exactly 32 bytes (decoded ${key.length})`);
  }
  if (isProduction && raw === DEV_ENCRYPTION_KEY_B64) {
    throw new Error("APP_ENCRYPTION_KEY must not be the development default in production");
  }
  return key;
}
const encryptionKey = isTest ? Buffer.from(DEV_ENCRYPTION_KEY_B64, "base64") : loadEncryptionKey();

export const config = {
  env,
  isTest,
  isProduction,
  port: Number(process.env.PORT ?? 3000),

  /** The running app connects here as `invoice_app_login` (never a superuser). */
  databaseUrl: isTest ? "" : required("DATABASE_URL"),
  /** Optional separate admin/owner connection for `npm run migrate` / `seed`. */
  adminDatabaseUrl: process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL || "",

  jwt: {
    secret: jwtSecret,
    // Short-lived access token. There is no refresh token yet, so logout / disable
    // rely on the `tokens_invalid_before` watermark for immediate revocation.
    expiresIn: process.env.JWT_EXPIRES_IN ?? "30m",
  },

  /** AES-256-GCM key (32 bytes) for DB-stored secrets. See src/crypto/secretbox.ts. */
  encryptionKey,

  /** Fire.com (platform-level Open Banking). Credentials live encrypted in the DB. */
  fire: {
    apiBaseUrl: process.env.FIRE_API_BASE_URL ?? "https://api.fire.com",
    paymentsBaseUrl: process.env.FIRE_PAYMENTS_BASE_URL ?? "https://payments.fire.com",
  },

  login: {
    // Per (ip + email) and per-ip failed-attempt ceilings within the window.
    maxAttemptsPerIdentity: Number(process.env.LOGIN_MAX_PER_IDENTITY ?? 8),
    maxAttemptsPerIp: Number(process.env.LOGIN_MAX_PER_IP ?? 30),
    windowMs: Number(process.env.LOGIN_WINDOW_MS ?? 15 * 60 * 1000),
  },

  /** DB role that request-scoped queries switch to; it is subject to RLS. */
  appDbRole: "invoice_app",
  /** BYPASSRLS role used only for the pre-authentication identity lookup. */
  authDbRole: "invoice_auth",
} as const;

export type Config = typeof config;
