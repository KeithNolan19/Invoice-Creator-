import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string) => new ApiError(400, "bad_request", msg);
export const unauthorized = (msg = "Authentication required") =>
  new ApiError(401, "unauthorized", msg);
export const forbidden = (msg = "Not allowed") => new ApiError(403, "forbidden", msg);
export const notFound = (msg = "Not found") => new ApiError(404, "not_found", msg);
export const conflict = (msg: string) => new ApiError(409, "conflict", msg);

// Postgres SQLSTATE -> safe, generic client response. The raw driver error
// (message / detail / where / internalQuery) is never forwarded to the client.
const PG_STATUS: Record<string, { status: number; code: string; message: string }> = {
  "23505": { status: 409, code: "conflict", message: "Resource already exists" },
  "23503": { status: 409, code: "conflict", message: "Referenced record is missing or still in use" },
  "23514": { status: 400, code: "constraint_violation", message: "Request violates a data constraint" },
  "23502": { status: 400, code: "constraint_violation", message: "A required field is missing" },
  "22P02": { status: 400, code: "bad_request", message: "Invalid input value" },
  "22007": { status: 400, code: "bad_request", message: "Invalid date/time value" },
  "42501": { status: 403, code: "forbidden", message: "Not allowed" },
  "23001": { status: 409, code: "conflict", message: "Operation not permitted on this resource" },
};

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (
    typeof err === "object" &&
    err !== null &&
    (err as { type?: string }).type === "entity.parse.failed"
  ) {
    res.status(400).json({ error: { code: "bad_request", message: "Invalid JSON body" } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "validation_error",
        message: "Request validation failed",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    });
    return;
  }

  const pgCode = typeof err === "object" && err !== null ? (err as { code?: string }).code : undefined;
  if (pgCode && PG_STATUS[pgCode]) {
    const mapped = PG_STATUS[pgCode]!;
    res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
    return;
  }

  // Anything unexpected: log server-side, return an opaque 500.
  console.error("Unhandled error:", err);
  res.status(500).json({ error: { code: "internal", message: "Internal server error" } });
}
