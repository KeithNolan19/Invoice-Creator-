import type { Queryable } from "../../db/types.ts";

export interface TenantSettingsRow {
  tenant_id: string;
  business_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  tax_number: string | null;
  tax_scheme: string | null;
  default_currency: string;
  default_due_days: number;
  default_notes: string | null;
  default_payment_terms: string | null;
  invoice_number_prefix: string;
  next_invoice_number: string; // bigint arrives as string
  created_at: string;
  updated_at: string;
}

const COLUMNS = `
  tenant_id, business_name, address_line1, address_line2, city, region, postal_code, country,
  contact_email, contact_phone, tax_number, tax_scheme, default_currency, default_due_days,
  default_notes, default_payment_terms, invoice_number_prefix, next_invoice_number,
  created_at, updated_at`;

/** Read is available to any tenant member (RLS: tenant_settings_read). */
export async function getTenantSettings(
  q: Queryable,
  tenantId: string,
): Promise<TenantSettingsRow | null> {
  const { rows } = await q.query<TenantSettingsRow>(
    `SELECT ${COLUMNS} FROM tenant_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows[0] ?? null;
}

export interface BusinessSettingsPatch {
  businessName?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  taxNumber?: string | null;
  taxScheme?: string | null;
  defaultCurrency?: string;
  defaultDueDays?: number;
  defaultNotes?: string | null;
  defaultPaymentTerms?: string | null;
  invoiceNumberPrefix?: string;
}

/** Write requires tenant admin (RLS: tenant_settings_admin_write). */
export async function updateBusinessSettings(
  q: Queryable,
  tenantId: string,
  patch: BusinessSettingsPatch,
): Promise<TenantSettingsRow | null> {
  const map: Record<keyof BusinessSettingsPatch, string> = {
    businessName: "business_name",
    addressLine1: "address_line1",
    addressLine2: "address_line2",
    city: "city",
    region: "region",
    postalCode: "postal_code",
    country: "country",
    contactEmail: "contact_email",
    contactPhone: "contact_phone",
    taxNumber: "tax_number",
    taxScheme: "tax_scheme",
    defaultCurrency: "default_currency",
    defaultDueDays: "default_due_days",
    defaultNotes: "default_notes",
    defaultPaymentTerms: "default_payment_terms",
    invoiceNumberPrefix: "invoice_number_prefix",
  };
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, col] of Object.entries(map) as [keyof BusinessSettingsPatch, string][]) {
    if (key in patch) {
      params.push(patch[key] ?? null);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (sets.length === 0) return getTenantSettings(q, tenantId);
  sets.push("updated_at = now()");
  params.push(tenantId);
  const { rows } = await q.query<TenantSettingsRow>(
    `UPDATE tenant_settings SET ${sets.join(", ")} WHERE tenant_id = $${params.length} RETURNING ${COLUMNS}`,
    params,
  );
  return rows[0] ?? null;
}

/**
 * Atomically allocates the next invoice number for a tenant. Delegates to the
 * SECURITY DEFINER function so a member (who cannot write tenant_settings) can
 * still bump the counter for their own tenant. Not wired into any route yet.
 */
export async function allocateInvoiceNumber(q: Queryable, tenantId: string): Promise<string> {
  const { rows } = await q.query<{ n: string }>(
    "SELECT allocate_invoice_number($1) AS n",
    [tenantId],
  );
  return rows[0]!.n;
}

export function serializeTenantSettings(row: TenantSettingsRow) {
  return {
    tenantId: row.tenant_id,
    businessName: row.business_name,
    address: {
      line1: row.address_line1,
      line2: row.address_line2,
      city: row.city,
      region: row.region,
      postalCode: row.postal_code,
      country: row.country,
    },
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    taxNumber: row.tax_number,
    taxScheme: row.tax_scheme,
    invoiceDefaults: {
      currency: row.default_currency,
      dueDays: row.default_due_days,
      notes: row.default_notes,
      paymentTerms: row.default_payment_terms,
      numberPrefix: row.invoice_number_prefix,
      nextNumber: Number(row.next_invoice_number),
    },
    updatedAt: row.updated_at,
  };
}
