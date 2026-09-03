import type { Queryable } from "../../db/types.ts";

export type TicketStatus = "open" | "closed";
export type AuthorKind = "tenant" | "admin";

export interface TicketRow {
  id: string;
  tenant_id: string;
  tenant_name: string | null;
  subject: string;
  status: TicketStatus;
  opened_by: string | null;
  opened_by_email: string | null;
  closed_by: string | null;
  closed_at: string | null;
  tenant_last_read_at: string | null;
  admin_last_read_at: string | null;
  last_message_at: string;
  created_at: string;
  unread_for_tenant: number;
  unread_for_admin: number;
  last_preview: string | null;
}

export interface MessageRow {
  id: string;
  ticket_id: string;
  author_user_id: string | null;
  author_email: string | null;
  author_kind: AuthorKind;
  body: string;
  created_at: string;
}

const TICKET_SELECT = `
  SELECT t.id, t.tenant_id, ten.name AS tenant_name, t.subject, t.status,
         t.opened_by, ob.email AS opened_by_email, t.closed_by, t.closed_at,
         t.tenant_last_read_at, t.admin_last_read_at, t.last_message_at, t.created_at,
         (SELECT count(*) FROM support_messages m
            WHERE m.ticket_id = t.id AND m.author_kind = 'admin'
              AND m.created_at > COALESCE(t.tenant_last_read_at, '-infinity'::timestamptz))::int AS unread_for_tenant,
         (SELECT count(*) FROM support_messages m
            WHERE m.ticket_id = t.id AND m.author_kind = 'tenant'
              AND m.created_at > COALESCE(t.admin_last_read_at, '-infinity'::timestamptz))::int AS unread_for_admin,
         (SELECT m.body FROM support_messages m WHERE m.ticket_id = t.id
            ORDER BY m.created_at DESC LIMIT 1) AS last_preview
    FROM support_tickets t
    JOIN tenants ten ON ten.id = t.tenant_id
    LEFT JOIN users ob ON ob.id = t.opened_by
`;

export async function listTicketsForTenant(q: Queryable): Promise<TicketRow[]> {
  const { rows } = await q.query<TicketRow>(
    `${TICKET_SELECT} ORDER BY (t.status = 'open') DESC, t.last_message_at DESC`,
  );
  return rows;
}

export async function listAllTickets(
  q: Queryable,
  filter: { status?: TicketStatus } = {},
): Promise<TicketRow[]> {
  const params: unknown[] = [];
  let where = "";
  if (filter.status) {
    params.push(filter.status);
    where = `WHERE t.status = $${params.length}`;
  }
  const { rows } = await q.query<TicketRow>(
    `${TICKET_SELECT} ${where} ORDER BY (t.status = 'open') DESC, t.last_message_at DESC`,
    params,
  );
  return rows;
}

export async function getTicket(q: Queryable, id: string): Promise<TicketRow | null> {
  const { rows } = await q.query<TicketRow>(`${TICKET_SELECT} WHERE t.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function getTicketMessages(q: Queryable, ticketId: string): Promise<MessageRow[]> {
  const { rows } = await q.query<MessageRow>(
    `SELECT m.id, m.ticket_id, m.author_user_id, u.email AS author_email,
            m.author_kind, m.body, m.created_at
       FROM support_messages m
       LEFT JOIN users u ON u.id = m.author_user_id
      WHERE m.ticket_id = $1
      ORDER BY m.created_at ASC`,
    [ticketId],
  );
  return rows;
}

/** Opens a ticket with its first message. Tenant context only. */
export async function createTicket(
  q: Queryable,
  input: { tenantId: string; subject: string; openedBy: string; firstMessage: string },
): Promise<TicketRow> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO support_tickets (tenant_id, subject, opened_by, tenant_last_read_at, last_message_at)
     VALUES ($1, $2, $3, now(), now())
     RETURNING id`,
    [input.tenantId, input.subject.trim(), input.openedBy],
  );
  const id = rows[0]!.id;
  await q.query(
    `INSERT INTO support_messages (ticket_id, tenant_id, author_user_id, author_kind, body)
     VALUES ($1, $2, $3, 'tenant', $4)`,
    [id, input.tenantId, input.openedBy, input.firstMessage.trim()],
  );
  return (await getTicket(q, id))!;
}

/** Appends a message; derives tenant_id from the (RLS-visible) ticket. Returns null if the ticket is not visible or is closed. */
export async function addMessage(
  q: Queryable,
  input: { ticketId: string; authorUserId: string; authorKind: AuthorKind; body: string; allowClosed?: boolean },
): Promise<MessageRow | null> {
  const cond = input.allowClosed ? "" : "AND status = 'open'";
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO support_messages (ticket_id, tenant_id, author_user_id, author_kind, body)
     SELECT t.id, t.tenant_id, $2, $3, $4
       FROM support_tickets t
      WHERE t.id = $1 ${cond}
     RETURNING id`,
    [input.ticketId, input.authorUserId, input.authorKind, input.body.trim()],
  );
  if (!rows[0]) return null;
  await q.query(
    `UPDATE support_tickets SET last_message_at = now()
       ${input.authorKind === "tenant" ? ", tenant_last_read_at = now()" : ", admin_last_read_at = now()"}
     WHERE id = $1`,
    [input.ticketId],
  );
  const { rows: msg } = await q.query<MessageRow>(
    `SELECT m.id, m.ticket_id, m.author_user_id, u.email AS author_email, m.author_kind, m.body, m.created_at
       FROM support_messages m LEFT JOIN users u ON u.id = m.author_user_id
      WHERE m.id = $1`,
    [rows[0].id],
  );
  return msg[0] ?? null;
}

export async function markRead(q: Queryable, ticketId: string, side: "tenant" | "admin"): Promise<void> {
  const col = side === "tenant" ? "tenant_last_read_at" : "admin_last_read_at";
  await q.query(`UPDATE support_tickets SET ${col} = now() WHERE id = $1`, [ticketId]);
}

/** Admin close / reopen. Returns null if the ticket is not visible or already in that state. */
export async function setTicketStatus(
  q: Queryable,
  ticketId: string,
  status: TicketStatus,
  actorUserId: string,
): Promise<TicketRow | null> {
  // Two explicit statements — avoids a CASE over bind params, which PGlite's
  // type inference stumbles on.
  const { rows } =
    status === "closed"
      ? await q.query<{ id: string }>(
          `UPDATE support_tickets SET status = 'closed', closed_by = $2, closed_at = now()
            WHERE id = $1 AND status = 'open' RETURNING id`,
          [ticketId, actorUserId],
        )
      : await q.query<{ id: string }>(
          `UPDATE support_tickets SET status = 'open', closed_by = NULL, closed_at = NULL
            WHERE id = $1 AND status = 'closed' RETURNING id`,
          [ticketId],
        );
  if (!rows[0]) return null;
  return getTicket(q, ticketId);
}

export async function supportSummaryTenant(q: Queryable): Promise<{ openCount: number; unreadCount: number }> {
  const { rows } = await q.query<{ open_count: number; unread_count: number }>(
    `SELECT
        count(*) FILTER (WHERE t.status = 'open')::int AS open_count,
        COALESCE(sum(
          (SELECT count(*) FROM support_messages m
             WHERE m.ticket_id = t.id AND m.author_kind = 'admin'
               AND m.created_at > COALESCE(t.tenant_last_read_at, '-infinity'::timestamptz))
        ), 0)::int AS unread_count
       FROM support_tickets t`,
  );
  return { openCount: rows[0]!.open_count, unreadCount: rows[0]!.unread_count };
}

export async function supportSummaryAdmin(q: Queryable): Promise<{
  openCount: number;
  unreadCount: number;
  ticketsWithUnread: number;
}> {
  const { rows } = await q.query<{ open_count: number; unread_count: number; tickets_with_unread: number }>(
    `WITH per_ticket AS (
       SELECT t.id, t.status,
         (SELECT count(*) FROM support_messages m
            WHERE m.ticket_id = t.id AND m.author_kind = 'tenant'
              AND m.created_at > COALESCE(t.admin_last_read_at, '-infinity'::timestamptz))::int AS unread
       FROM support_tickets t
     )
     SELECT count(*) FILTER (WHERE status = 'open')::int AS open_count,
            COALESCE(sum(unread), 0)::int AS unread_count,
            count(*) FILTER (WHERE unread > 0)::int AS tickets_with_unread
       FROM per_ticket`,
  );
  return {
    openCount: rows[0]!.open_count,
    unreadCount: rows[0]!.unread_count,
    ticketsWithUnread: rows[0]!.tickets_with_unread,
  };
}

export function serializeTicket(t: TicketRow) {
  return {
    id: t.id,
    tenantId: t.tenant_id,
    tenantName: t.tenant_name,
    subject: t.subject,
    status: t.status,
    openedBy: t.opened_by ? { id: t.opened_by, email: t.opened_by_email } : null,
    closedAt: t.closed_at,
    lastMessageAt: t.last_message_at,
    createdAt: t.created_at,
    unreadForTenant: t.unread_for_tenant,
    unreadForAdmin: t.unread_for_admin,
    lastPreview: t.last_preview,
  };
}

export function serializeMessage(m: MessageRow) {
  return {
    id: m.id,
    authorKind: m.author_kind,
    authorEmail: m.author_email,
    body: m.body,
    createdAt: m.created_at,
  };
}
