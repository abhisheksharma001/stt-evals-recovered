import type { Response } from "express";
import type { ZodInput, ZodTypeAny } from "@workspace/api-zod";

/**
 * T-152: the one way a route answers with a success payload.
 *
 * Every success response was already `res.json(Schema.parse(value))`, which
 * checks the payload against the contract -- but only at runtime, and only in
 * the one direction that cannot fail the build. `Schema.parse` takes
 * `unknown`, so a hand-built mapping that omits a required field typechecks
 * fine and becomes a 500 in production. That is exactly how T-136 happened:
 * the disagreement-spans mapping lost `majorityText` and the endpoint
 * answered 500 for every call for a day.
 *
 * Here the payload is typed as the schema's own input type, so omitting a
 * required field is a `tsc` error at the call site (or, once serializers are
 * annotated, at the serializer). The runtime parse stays: the compiler holds
 * the shape, the parse still holds the values (enums read out of
 * unconstrained db text columns, ISO date strings, and whatever a cast
 * slipped past the compiler).
 *
 * Error responses do not come through here -- a failed safeParse answers via
 * `respondInvalid` (T-150), a thrown error via `jsonErrorHandler` (T-76), an
 * unmatched path via `jsonNotFoundHandler` (T-149).
 */
export function respondJson<S extends ZodTypeAny>(res: Response, schema: S, value: ZodInput<S>, status = 200): void {
  res.status(status).json(schema.parse(value));
}
