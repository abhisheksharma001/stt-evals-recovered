export * from "./generated/api";
export * from "./generated/types";

// T-150: the schemas live here, so the type of what they reject lives here
// too -- api-server reads a failed safeParse to describe it in a sentence,
// and does that without taking its own direct dependency on zod (which would
// let the two drift onto different majors, the exact hazard T-141 hit).
export type { ZodError, ZodIssue } from "zod";
