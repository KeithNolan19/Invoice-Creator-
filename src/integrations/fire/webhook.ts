import jwt from "jsonwebtoken";
import { secretsEqual } from "../../crypto/secretbox.ts";
import { type FireWebhookEvent, FireWebhookError } from "./types.ts";

/**
 * Verifies an inbound Fire.com webhook and returns its events.
 *
 * Fire signs webhooks as an HS256 JWT. The `kid` in the JWT header is the
 * webhook *public* token; the secret is the corresponding *private* token from
 * Fire for Business → Profile → Webhooks. The JWT payload carries the event(s)
 * — Fire says "events are sent as an array; in general one event per message".
 *
 * Expiration is intentionally ignored: Fire retries a webhook several times over
 * a few minutes and the JWT's own `exp` can be shorter than that. Replay is
 * prevented downstream by a unique `event_key` in `platform_payment_events`;
 * the signature still proves authenticity.
 *
 * @param rawBody   the exact request body bytes/string (never re-serialised JSON)
 * @param privateToken  the stored webhook private token (decrypted)
 * @param expectedKid   optional — the configured public token, checked against the header `kid`
 */
export function verifyFireWebhook(
  rawBody: string,
  privateToken: string,
  expectedKid?: string,
): FireWebhookEvent[] {
  const token = extractJwt(rawBody);
  if (!token) throw new FireWebhookError("no JWT found in webhook body");

  const decodedHeader = jwt.decode(token, { complete: true });
  if (!decodedHeader || typeof decodedHeader === "string") {
    throw new FireWebhookError("malformed JWT");
  }
  const kid = decodedHeader.header.kid;
  if (expectedKid && (!kid || !secretsEqual(String(kid), expectedKid))) {
    throw new FireWebhookError("webhook kid does not match the configured public token");
  }

  let payload: unknown;
  try {
    payload = jwt.verify(token, privateToken, {
      algorithms: ["HS256"],
      ignoreExpiration: true,
    });
  } catch (err) {
    throw new FireWebhookError(`signature verification failed: ${(err as Error).message}`);
  }

  return normaliseEvents(payload);
}

function extractJwt(body: string): string | null {
  const trimmed = body.trim();
  const jwtLike = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
  if (jwtLike.test(trimmed)) return trimmed;
  // Some deliveries wrap it, e.g. {"payload":"<jwt>"} — accept a single string field.
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    for (const v of Object.values(obj)) {
      if (typeof v === "string" && jwtLike.test(v)) return v;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

function normaliseEvents(payload: unknown): FireWebhookEvent[] {
  if (Array.isArray(payload)) return payload as FireWebhookEvent[];
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.events)) return obj.events as FireWebhookEvent[];
    if (Array.isArray(obj.data)) return obj.data as FireWebhookEvent[];
    // A single event object.
    if (typeof obj.type === "string") return [obj as FireWebhookEvent];
  }
  throw new FireWebhookError("could not locate events in the webhook payload");
}
