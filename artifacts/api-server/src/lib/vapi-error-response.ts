// One way to answer a failed Vapi read. Extracted from routes/benchmark.ts
// (unchanged behaviour) when U-2's preview route needed the same three
// branches: a misconfigured account is the caller's problem (400), a refusal
// or an unreachable Vapi is the upstream's (502).
import type { Response } from "express";
import { VapiConfigError, VapiRequestError } from "./vapi";

export function respondVapiError(res: Response, err: unknown): void {
  if (err instanceof VapiConfigError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof VapiRequestError) {
    res.status(502).json({ error: err.message, vapiStatus: err.httpStatus });
    return;
  }
  res.status(502).json({
    error: err instanceof Error ? err.message : "Vapi request failed.",
  });
}
