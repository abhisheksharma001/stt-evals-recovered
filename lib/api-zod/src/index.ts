export * from "./generated/api";
export * from "./generated/types";

// T-150: the schemas live here, so the type of what they reject lives here
// too -- api-server reads a failed safeParse to describe it in a sentence,
// and does that without taking its own direct dependency on zod (which would
// let the two drift onto different majors, the exact hazard T-141 hit).
export type { ZodError, ZodIssue } from "zod";

// T-152: same rule, response direction. `respondJson` in api-server types a
// handler's payload as the schema's own input type, so a field the contract
// requires cannot be omitted without failing `tsc` -- the T-136 class of bug
// (a hand-built mapping missing one required field, discovered only at
// runtime as a 500) becomes a compile error instead. Re-exported here for
// the same reason as ZodError above: api-server must not grow its own,
// independently versioned zod.
export type { input as ZodInput, ZodTypeAny } from "zod";
