import type { Queryable } from "../../db/types.ts";

/**
 * The SAFE projection of a tenant's payment-integration row — never includes any
 * `*_ciphertext` column. This is the only shape any repository method in this
 * module returns.
 *
 * A future server-side Fire.com client (Stage 8+) will add a separate, clearly
 * named method that decrypts the credential columns in memory for the duration
 * of an API call. That method does not exist yet, and nothing decrypts anything
 * in this stage.
 */
export interface PaymentIntegrationSafeRow {
  id: string;
  tenant_id: string;
  provider: "fire";
  status: "not_connected" | "pending" | "connected" | "error";
  fire_business_id: string | null;
  collection_ican: string | null;
  collection_account_alias: string | null;
  webhook_kid: string | null;
  last_verified_at: string | Date | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// Explicitly enumerated — the ciphertext columns are omitted on purpose.
const SAFE_COLUMNS =
  "id, tenant_id, provider, status, fire_business_id, collection_ican, collection_account_alias, " +
  "webhook_kid, last_verified_at, last_error, created_at, updated_at";

/**
 * Reads the tenant's payment-integration row (safe fields only). RLS restricts
 * this to a tenant admin of the caller's own tenant (policy
 * `tenant_payment_integrations_admin`) — a member or another tenant sees
 * nothing.
 */
export async function getPaymentIntegrationSafe(
  q: Queryable,
  tenantId: string,
): Promise<PaymentIntegrationSafeRow | null> {
  const { rows } = await q.query<PaymentIntegrationSafeRow>(
    `SELECT ${SAFE_COLUMNS} FROM tenant_payment_integrations WHERE tenant_id = $1 AND provider = 'fire'`,
    [tenantId],
  );
  return rows[0] ?? null;
}

export function serializePaymentIntegration(row: PaymentIntegrationSafeRow | null) {
  if (!row) return { provider: "fire" as const, status: "not_connected" as const };
  return {
    provider: row.provider,
    status: row.status,
    fireBusinessId: row.fire_business_id,
    collectionAccountAlias: row.collection_account_alias,
    webhookKid: row.webhook_kid,
    lastVerifiedAt: row.last_verified_at,
    lastError: row.last_error,
  };
}
