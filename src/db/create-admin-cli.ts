import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { config } from "../config.ts";
import { assertPasswordAllowed, hashPassword } from "../auth/password.ts";
import { PgDb } from "./pg.ts";

/**
 * Creates the first platform administrator on a fresh production database.
 *
 * There is no public sign-up: the platform admin is created here, once, and then
 * provisions tenants and their users through the Admin Control Centre.
 *
 * Usage (env or interactive):
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='<>=12 chars' npm run create-admin
 *   npm run create-admin            # prompts for email, name, password
 *
 * Connects with the owner/admin credentials (DATABASE_ADMIN_URL), like the
 * migrate and seed scripts — never the running app's role.
 */

function fail(message: string): never {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

async function ask(question: string, { mask = false } = {}): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  if (mask) {
    // Suppress echo of the typed characters, but still show the prompt itself.
    const internal = rl as unknown as { _writeToOutput: (s: string) => void };
    let promptWritten = false;
    internal._writeToOutput = (s: string) => {
      if (!promptWritten) {
        stdout.write(s);
        promptWritten = true;
      } else if (s === "\n" || s === "\r\n" || s === "\r") {
        stdout.write("\n");
      }
    };
  }
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

const interactive = Boolean(stdin.isTTY);

async function resolveInputs(): Promise<{ email: string; name: string; password: string }> {
  let email = process.env.ADMIN_EMAIL?.trim().toLowerCase() ?? "";
  if (!email) {
    if (!interactive) fail("set ADMIN_EMAIL (no terminal to prompt on)");
    email = (await ask("Admin email: ")).toLowerCase();
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(`"${email}" does not look like an email address`);

  const fallbackName = email.split("@")[0]!;
  let name = process.env.ADMIN_NAME?.trim() ?? "";
  if (!name && interactive) name = await ask(`Full name [${fallbackName}]: `);
  if (!name) name = fallbackName;

  let password = process.env.ADMIN_PASSWORD ?? "";
  if (!password) {
    if (!interactive) fail("set ADMIN_PASSWORD (no terminal to prompt on)");
    password = await ask("Password (min 12 chars): ", { mask: true });
    const again = await ask("Confirm password: ", { mask: true });
    if (password !== again) fail("passwords did not match");
  }
  try {
    assertPasswordAllowed(password);
  } catch (err) {
    fail(err instanceof Error ? err.message : "password rejected");
  }

  return { email, name, password };
}

const { email, name, password } = await resolveInputs();
const passwordHash = await hashPassword(password);

const db = new PgDb(config.adminDatabaseUrl || config.databaseUrl);
try {
  const created = await db.privileged(async (q) => {
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, role, tenant_id, tenant_role)
       VALUES ($1, $2, $3, 'admin', NULL, NULL)
       RETURNING id`,
      [email, passwordHash, name],
    );
    return rows[0]!;
  });
  console.log(`\n✔ Created platform admin ${email} (id ${created.id}).`);
  console.log("  Sign in at /admin on the deployed host.");
} catch (err) {
  const code = (err as { code?: string }).code;
  if (code === "23505") fail(`an account with the email ${email} already exists`);
  throw err;
} finally {
  await db.close();
}
