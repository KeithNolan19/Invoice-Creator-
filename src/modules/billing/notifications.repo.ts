import type { Queryable } from "../../db/types.ts";

export type NotificationType =
  | "client_paid"
  | "renewal_upcoming"
  | "renewal_invoice_generated"
  | "payment_overdue"
  | "account_suspended"
  | "account_reactivated_auto"
  | "payment_failed"
  | "payment_requires_attention"
  | "provider_error"
  | "plan_outgrown";

export interface NotificationRow {
  id: string;
  type: NotificationType;
  tenant_id: string | null;
  tenant_name: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  payment_id: string | null;
  title: string;
  body: string | null;
  severity: "info" | "attention";
  read_at: string | null;
  created_at: string;
}

const SELECT = `
  SELECT n.id, n.type, n.tenant_id, t.name AS tenant_name, n.invoice_id,
         i.number AS invoice_number, n.payment_id, n.title, n.body, n.severity,
         n.read_at, n.created_at
    FROM admin_notifications n
    LEFT JOIN tenants t ON t.id = n.tenant_id
    LEFT JOIN platform_invoices i ON i.id = n.invoice_id
`;

export interface NewNotification {
  type: NotificationType;
  tenantId?: string | null;
  invoiceId?: string | null;
  paymentId?: string | null;
  title: string;
  body?: string;
  severity?: "info" | "attention";
  /** When set, a repeat with the same key is silently ignored. */
  dedupeKey?: string;
}

/** Insert a notification. With `dedupeKey`, a duplicate is a no-op. Admin context. */
export async function createNotification(q: Queryable, n: NewNotification): Promise<void> {
  await q.query(
    `INSERT INTO admin_notifications (type, tenant_id, invoice_id, payment_id, title, body, severity, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [
      n.type,
      n.tenantId ?? null,
      n.invoiceId ?? null,
      n.paymentId ?? null,
      n.title,
      n.body ?? null,
      n.severity ?? "info",
      n.dedupeKey ?? null,
    ],
  );
}

export async function listNotifications(
  q: Queryable,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<NotificationRow[]> {
  const where = opts.unreadOnly ? "WHERE n.read_at IS NULL" : "";
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const { rows } = await q.query<NotificationRow>(
    `${SELECT} ${where} ORDER BY n.created_at DESC LIMIT ${limit}`,
  );
  return rows;
}

export async function unreadCount(q: Queryable): Promise<number> {
  const { rows } = await q.query<{ c: number }>(
    "SELECT count(*)::int c FROM admin_notifications WHERE read_at IS NULL",
  );
  return rows[0]!.c;
}

export async function markNotificationRead(q: Queryable, id: string): Promise<boolean> {
  const { rowCount } = await q.query(
    "UPDATE admin_notifications SET read_at = now() WHERE id = $1 AND read_at IS NULL",
    [id],
  );
  return rowCount > 0;
}

export async function markAllNotificationsRead(q: Queryable): Promise<number> {
  const { rowCount } = await q.query("UPDATE admin_notifications SET read_at = now() WHERE read_at IS NULL");
  return rowCount;
}

export function serializeNotification(n: NotificationRow) {
  return {
    id: n.id,
    type: n.type,
    tenant: n.tenant_id ? { id: n.tenant_id, name: n.tenant_name } : null,
    invoice: n.invoice_id ? { id: n.invoice_id, number: n.invoice_number } : null,
    paymentId: n.payment_id,
    title: n.title,
    body: n.body,
    severity: n.severity,
    read: n.read_at != null,
    createdAt: n.created_at,
  };
}
