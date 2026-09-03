import { KEY_VERSION, decryptSecret, encryptSecret } from "../../crypto/secretbox.ts";
import type { Queryable } from "../../db/types.ts";
import type { FireCredentials } from "../../integrations/fire/index.ts";

/**
 * Read/write access to the single `platform_billing_config` row.
 *
 * The "safe" projection never selects a `*_ciphertext` column — the browser only
 * ever learns whether a secret is *set*, never its value. `getFirePlatformConfig`
 * is the one function that decrypts, and only the server-side FireClient calls it.
 */

export interface BillingConfigSafe {
  businessName: string | null;
  businessAddress: string | null;
  businessTaxNumber: string | null;
  businessContactEmail: string | null;
  defaultCurrency: string;
  invoiceNumberPrefix: string;
  renewalReminderDays: number;
  overdueGraceDays: number;
  fireWebhookKid: string | null;
  fireCollectionIcan: string | null;
  fireBusinessId: string | null;
  fireLastVerifiedAt: string | null;
  fireLastError: string | null;
  updatedAt: string;
  fire: {
    hasClientId: boolean;
    hasClientKey: boolean;
    hasRefreshToken: boolean;
    hasWebhookPrivate: boolean;
    configured: boolean; // all four present + an ICAN
  };
}

interface SafeRow {
  business_name: string | null;
  business_address: string | null;
  business_tax_number: string | null;
  business_contact_email: string | null;
  default_currency: string;
  invoice_number_prefix: string;
  renewal_reminder_days: number;
  overdue_grace_days: number;
  fire_webhook_kid: string | null;
  fire_collection_ican: string | null;
  fire_business_id: string | null;
  fire_last_verified_at: string | null;
  fire_last_error: string | null;
  updated_at: string;
  has_client_id: boolean;
  has_client_key: boolean;
  has_refresh_token: boolean;
  has_webhook_private: boolean;
}

const SAFE_SELECT = `
  SELECT business_name, business_address, business_tax_number, business_contact_email,
         default_currency, invoice_number_prefix, renewal_reminder_days, overdue_grace_days,
         fire_webhook_kid, fire_collection_ican::text AS fire_collection_ican,
         fire_business_id, fire_last_verified_at, fire_last_error, updated_at,
         (fire_client_id_ciphertext      IS NOT NULL) AS has_client_id,
         (fire_client_key_ciphertext     IS NOT NULL) AS has_client_key,
         (fire_refresh_token_ciphertext  IS NOT NULL) AS has_refresh_token,
         (fire_webhook_private_ciphertext IS NOT NULL) AS has_webhook_private
    FROM platform_billing_config WHERE id = 1
`;

/** The config is a singleton (id = 1). Self-heal if it was ever removed. */
async function ensureRow(q: Queryable): Promise<void> {
  await q.query("INSERT INTO platform_billing_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
}

export async function getBillingConfigSafe(q: Queryable): Promise<BillingConfigSafe> {
  await ensureRow(q);
  const { rows } = await q.query<SafeRow>(SAFE_SELECT);
  const r = rows[0]!;
  const configured =
    r.has_client_id && r.has_client_key && r.has_refresh_token && r.has_webhook_private &&
    r.fire_collection_ican != null;
  return {
    businessName: r.business_name,
    businessAddress: r.business_address,
    businessTaxNumber: r.business_tax_number,
    businessContactEmail: r.business_contact_email,
    defaultCurrency: r.default_currency,
    invoiceNumberPrefix: r.invoice_number_prefix,
    renewalReminderDays: r.renewal_reminder_days,
    overdueGraceDays: r.overdue_grace_days,
    fireWebhookKid: r.fire_webhook_kid,
    fireCollectionIcan: r.fire_collection_ican,
    fireBusinessId: r.fire_business_id,
    fireLastVerifiedAt: r.fire_last_verified_at,
    fireLastError: r.fire_last_error,
    updatedAt: r.updated_at,
    fire: {
      hasClientId: r.has_client_id,
      hasClientKey: r.has_client_key,
      hasRefreshToken: r.has_refresh_token,
      hasWebhookPrivate: r.has_webhook_private,
      configured,
    },
  };
}

export interface BillingConfigPatch {
  businessName?: string | null;
  businessAddress?: string | null;
  businessTaxNumber?: string | null;
  businessContactEmail?: string | null;
  defaultCurrency?: string;
  invoiceNumberPrefix?: string;
  renewalReminderDays?: number;
  overdueGraceDays?: number;
}

export async function updateBillingConfigSafe(
  q: Queryable,
  patch: BillingConfigPatch,
  updatedBy: string,
): Promise<void> {
  await ensureRow(q);
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  const cols: Record<string, unknown> = {
    business_name: patch.businessName,
    business_address: patch.businessAddress,
    business_tax_number: patch.businessTaxNumber,
    business_contact_email: patch.businessContactEmail,
    default_currency: patch.defaultCurrency,
    invoice_number_prefix: patch.invoiceNumberPrefix,
    renewal_reminder_days: patch.renewalReminderDays,
    overdue_grace_days: patch.overdueGraceDays,
  };
  for (const [col, val] of Object.entries(cols)) if (val !== undefined) add(col, val);
  if (sets.length === 0) return;
  add("updated_by", updatedBy);
  sets.push("updated_at = now()");
  await q.query(`UPDATE platform_billing_config SET ${sets.join(", ")} WHERE id = 1`, params);
}

export interface FireCredentialsPatch {
  clientId?: string;
  clientKey?: string;
  refreshToken?: string;
  webhookPrivateToken?: string;
  webhookKid?: string | null;
  collectionIcan?: number | null;
}

/** Encrypts and stores whichever Fire fields are provided. */
export async function setFireCredentials(
  q: Queryable,
  patch: FireCredentialsPatch,
  updatedBy: string,
): Promise<void> {
  await ensureRow(q);
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.clientId !== undefined) add("fire_client_id_ciphertext", encryptSecret(patch.clientId));
  if (patch.clientKey !== undefined) add("fire_client_key_ciphertext", encryptSecret(patch.clientKey));
  if (patch.refreshToken !== undefined) add("fire_refresh_token_ciphertext", encryptSecret(patch.refreshToken));
  if (patch.webhookPrivateToken !== undefined) {
    add("fire_webhook_private_ciphertext", encryptSecret(patch.webhookPrivateToken));
  }
  if (patch.webhookKid !== undefined) add("fire_webhook_kid", patch.webhookKid);
  if (patch.collectionIcan !== undefined) add("fire_collection_ican", patch.collectionIcan);
  if (sets.length === 0) return;
  add("key_version", KEY_VERSION);
  add("updated_by", updatedBy);
  sets.push("updated_at = now()");
  await q.query(`UPDATE platform_billing_config SET ${sets.join(", ")} WHERE id = 1`, params);
}

export async function recordFireVerification(
  q: Queryable,
  result: { businessId?: string | null; error?: string | null },
): Promise<void> {
  await q.query(
    `UPDATE platform_billing_config
        SET fire_business_id = COALESCE($1, fire_business_id),
            fire_last_verified_at = CASE WHEN $2::text IS NULL THEN now() ELSE fire_last_verified_at END,
            fire_last_error = $2,
            updated_at = now()
      WHERE id = 1`,
    [result.businessId ?? null, result.error ?? null],
  );
}

export interface FirePlatformConfig extends FireCredentials {
  webhookPrivateToken: string;
  webhookKid: string | null;
  collectionIcan: number;
}

/** Decrypts the Fire credentials. Returns null unless fully configured. */
export async function getFirePlatformConfig(q: Queryable): Promise<FirePlatformConfig | null> {
  const { rows } = await q.query<{
    fire_client_id_ciphertext: Buffer | null;
    fire_client_key_ciphertext: Buffer | null;
    fire_refresh_token_ciphertext: Buffer | null;
    fire_webhook_private_ciphertext: Buffer | null;
    fire_webhook_kid: string | null;
    fire_collection_ican: string | null;
  }>(
    `SELECT fire_client_id_ciphertext, fire_client_key_ciphertext, fire_refresh_token_ciphertext,
            fire_webhook_private_ciphertext, fire_webhook_kid, fire_collection_ican::text AS fire_collection_ican
       FROM platform_billing_config WHERE id = 1`,
  );
  const r = rows[0];
  if (
    !r ||
    !r.fire_client_id_ciphertext ||
    !r.fire_client_key_ciphertext ||
    !r.fire_refresh_token_ciphertext ||
    !r.fire_webhook_private_ciphertext ||
    r.fire_collection_ican == null
  ) {
    return null;
  }
  return {
    clientId: decryptSecret(toBuffer(r.fire_client_id_ciphertext)),
    clientKey: decryptSecret(toBuffer(r.fire_client_key_ciphertext)),
    refreshToken: decryptSecret(toBuffer(r.fire_refresh_token_ciphertext)),
    webhookPrivateToken: decryptSecret(toBuffer(r.fire_webhook_private_ciphertext)),
    webhookKid: r.fire_webhook_kid,
    collectionIcan: Number(r.fire_collection_ican),
  };
}

// pg returns bytea as Buffer; PGlite may return Uint8Array.
function toBuffer(v: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}
