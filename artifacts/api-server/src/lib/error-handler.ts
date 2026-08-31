import type { ErrorRequestHandler, RequestHandler } from "express";

/**
 * T-76 (PRD-v4-technical J.1): one JSON error handler for every route.
 *
 * Before this, a handler that threw (or rejected, with express@5's async
 * support) fell through to Express's default handler, which answers with an
 * HTML page -- the UI's fetch layer then failed to parse it and showed a
 * useless "Unexpected token <" message. Now every unhandled error answers
 * `{ error, requestId }` as JSON, with the thrown status when the error
 * carries one (`status` / `statusCode`, as http-errors and body-parser set)
 * and 500 otherwise, and is logged once through pino with the request id so
 * the log line and the response can be matched.
 *
 * Zod parse failures already answer 400 inside their handlers; those never
 * reach here. Nothing about the error's internals (stack, cause) is sent to
 * the client -- only its message, and for 5xx only a generic one, since a
 * raw message from a provider SDK or the database can carry a key or a
 * connection string.
 */
export function errorStatus(err: unknown): number {
  const raw =
    typeof err === "object" && err !== null
      ? ((err as { status?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode)
      : undefined;
  return typeof raw === "number" && raw >= 400 && raw <= 599 ? raw : 500;
}

export function errorBody(err: unknown, requestId: string | undefined): { error: string; requestId?: string } {
  const status = errorStatus(err);
  const message =
    status < 500 && err instanceof Error && err.message ? err.message : "Internal server error";
  return requestId ? { error: message, requestId } : { error: message };
}

export const jsonErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // Headers already sent: Express must close the connection; delegating to
  // its default handler is the documented way to do that.
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = errorStatus(err);
  const requestId = typeof req.id === "string" || typeof req.id === "number" ? String(req.id) : undefined;
  const log = req.log ?? undefined;
  if (log) {
    if (status >= 500) log.error({ err, requestId, status }, "unhandled route error");
    else log.warn({ err: err instanceof Error ? err.message : err, requestId, status }, "route error");
  }
  res.status(status).json(errorBody(err, requestId));
};

/**
 * T-149: unmatched paths answer JSON, like every other failure.
 *
 * T-76 covered what a handler throws. It did not cover a request that
 * reaches no handler at all -- that fell through to Express's built-in
 * finalhandler, which answers `<!DOCTYPE html>...Cannot POST /api/...` with
 * `Content-Type: text/html`. The generated client parses an error body as
 * JSON, so a caller got a parse failure instead of a 404: exactly what
 * `POST /benchmark/agent/scans` (T-147) did for four days.
 *
 * The path is echoed back because "which URL did the server not find" is the
 * whole content of a 404 -- but it is echoed sanitised: control characters
 * and angle brackets removed, 200 characters maximum. A JSON response is not
 * an HTML one, but a body that reflects caller input unfiltered is a habit
 * worth not having.
 */
export function describeUnmatched(method: string, path: string): string {
  const safe = path.replace(/[\u0000-\u001f<>]/g, "").slice(0, 200);
  return `No such endpoint: ${method} ${safe}`;
}

export const jsonNotFoundHandler: RequestHandler = (req, res) => {
  const requestId = typeof req.id === "string" || typeof req.id === "number" ? String(req.id) : undefined;
  const body: { error: string; requestId?: string } = {
    error: describeUnmatched(req.method, req.originalUrl.split("?")[0] ?? ""),
  };
  if (requestId) body.requestId = requestId;
  res.status(404).json(body);
};
