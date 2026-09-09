// 2026-08-27, per Abhishek: gold-transcript-free hybrid quality flagging --
// see hybrid.ts's own header for the full rationale.
export * from "./hybrid";
export * from "./rank-agreement";
export * from "./core";
export * from "./spans";
export * from "./provider-correlation";
export * from "./verdict";
export * from "./trend";

// T-101: the comparison form (equivalences folded in). See equivalence.ts.
export { canonicalTranscript, sameOnceCanonical, markConventionOps } from "./equivalence";
