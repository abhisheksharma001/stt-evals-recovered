export type BenchmarkPlanTask = {
  id: string;
  phase: string;
  title: string;
  description: string;
  status: string;
  dependencies: string[];
  logicNotes: string[];
};

export const benchmarkPlan: BenchmarkPlanTask[] = [
  {
    id: "GOV-01",
    phase: "0 · Governance",
    title: "Approve benchmark data policy",
    description:
      "Define who can select, review, upload, retain, and delete de-identified production-call samples.",
    status: "in_review",
    dependencies: [],
    logicNotes: [
      "Confirm retention period before any production-derived audio is uploaded.",
      "Define the approver role and evidence recorded for every file.",
    ],
  },
  {
    id: "COR-01",
    phase: "1 · Corpus",
    title: "Select 10–15-call starter corpus",
    description:
      "Choose a balanced manual starter set spanning all verticals and required hard cases.",
    status: "blocked",
    dependencies: ["GOV-01"],
    logicNotes: [
      "Use stratified selection; do not optimize the set around any provider.",
      "Set minimum coverage for accents, noise, crosstalk, DTMF, and alphanumerics.",
    ],
  },
  {
    id: "COR-02",
    phase: "1 · Corpus",
    title: "Manually de-identify and approve audio",
    description:
      "Create benchmark copies, perform two-person privacy review, and record approval evidence.",
    status: "blocked",
    dependencies: ["COR-01"],
    logicNotes: [
      "Operational identifiers used for scoring may need synthetic replacements rather than deletion.",
      "Reject any file whose de-identification cannot be confidently verified.",
    ],
  },
  {
    id: "GOLD-01",
    phase: "2 · Gold references",
    title: "Draft gold transcripts",
    description:
      "Transcribe speech verbatim with timestamps, speaker labels, and explicit inaudible markers.",
    status: "blocked",
    dependencies: ["COR-02"],
    logicNotes: [
      "Freeze transcription conventions before the second call is labeled.",
      "Do not silently normalize identifiers in the human reference.",
    ],
  },
  {
    id: "GOLD-02",
    phase: "2 · Gold references",
    title: "Adjudicate gold transcripts",
    description:
      "Run independent review and resolve disagreements before references are benchmark eligible.",
    status: "blocked",
    dependencies: ["GOLD-01"],
    logicNotes: [
      "Track disagreement rate to estimate gold-label uncertainty.",
      "Require explicit adjudication for every scored entity.",
    ],
  },
  {
    id: "MET-01",
    phase: "3 · Scoring",
    title: "Freeze transcript normalization",
    description:
      "Version casing, punctuation, fillers, number expansion, and Unicode rules used before WER.",
    status: "specified",
    dependencies: [],
    logicNotes: [
      "Score both human-readable and strict identifier-sensitive variants.",
      "Normalization must never erase entity mistakes.",
    ],
  },
  {
    id: "MET-02",
    phase: "3 · Scoring",
    title: "Implement WER scoring",
    description:
      "Calculate substitutions, insertions, deletions, aggregate WER, and per-call diagnostics.",
    status: "specified",
    dependencies: ["MET-01"],
    logicNotes: [
      "Use micro-average as primary and report macro-average as a stability check.",
      "Retain alignment operations for error review.",
    ],
  },
  {
    id: "MET-03",
    phase: "3 · Scoring",
    title: "Implement entity scoring",
    description:
      "Score exact-match VIN, RO, unit, phone, name, address, load, and city entities.",
    status: "specified",
    dependencies: ["MET-01", "GOLD-02"],
    logicNotes: [
      "Entity spans should be human-verified in gold data.",
      "Report strict exact match separately from a normalized diagnostic match.",
    ],
  },
  {
    id: "MET-04",
    phase: "3 · Scoring",
    title: "Implement number and alphanumeric scoring",
    description:
      "Measure token and full-sequence accuracy for spoken digits and mixed identifiers.",
    status: "specified",
    dependencies: ["MET-01", "GOLD-02"],
    logicNotes: [
      "Define whether NATO phonetic expansions are equivalent.",
      "Keep sequence-level accuracy primary because one wrong character can invalidate an ID.",
    ],
  },
  {
    id: "PRO-01",
    phase: "4 · Providers",
    title: "Verify provider and VAPI capability matrix",
    description:
      "Confirm supported models, streaming, diarization, vocabulary controls, data policy, and pricing.",
    status: "in_review",
    dependencies: [],
    logicNotes: [
      "Use primary vendor documentation and record retrieval date.",
      "Treat all planning prices as unverified until this task closes.",
    ],
  },
  {
    id: "PRO-02",
    phase: "4 · Providers",
    title: "Implement provider adapter contract",
    description:
      "Define one normalized interface for batch, streaming events, raw responses, and usage.",
    status: "specified",
    dependencies: ["PRO-01"],
    logicNotes: [
      "Persist raw vendor responses before normalization.",
      "Mark unsupported capabilities as not applicable, never as zero quality.",
    ],
  },
  {
    id: "PRO-03",
    phase: "4 · Providers",
    title: "Build six provider adapters",
    description:
      "Implement and validate Deepgram, AssemblyAI, OpenAI, ElevenLabs, Gladia, and Speechmatics.",
    status: "blocked",
    dependencies: ["PRO-02"],
    logicNotes: [
      "Use identical audio bytes and explicit, versioned settings for every provider.",
      "Fail the run loudly if any selected provider silently falls back to another model.",
    ],
  },
  {
    id: "RUN-01",
    phase: "5 · Runner",
    title: "Create immutable run manifest",
    description:
      "Snapshot corpus version, provider/model config, scoring version, timestamp, and pricing inputs.",
    status: "specified",
    dependencies: ["PRO-02", "MET-01"],
    logicNotes: [
      "A rerun creates a new manifest; completed manifests are never mutated.",
      "Hash audio and gold files to detect corpus drift.",
    ],
  },
  {
    id: "RUN-02",
    phase: "5 · Runner",
    title: "Instrument streaming latency",
    description:
      "Capture audio-send start, first meaningful partial, final transcript, and disconnect times.",
    status: "specified",
    dependencies: ["PRO-03", "RUN-01"],
    logicNotes: [
      "Define first partial as the first non-empty, non-control transcript event.",
      "Separate network/setup overhead from model processing when the API exposes both.",
    ],
  },
  {
    id: "RUN-03",
    phase: "5 · Runner",
    title: "Execute baseline run",
    description:
      "Run all candidates against the same frozen starter corpus without custom vocabulary.",
    status: "blocked",
    dependencies: ["COR-02", "GOLD-02", "PRO-03", "RUN-02"],
    logicNotes: [
      "Use controlled concurrency to avoid provider throttling bias.",
      "Retry transport failures but never hide model failures.",
    ],
  },
  {
    id: "EXP-01",
    phase: "6 · Experiments",
    title: "Run keyword/custom-vocabulary experiment",
    description:
      "Compare supported boosting configurations against each provider’s unboosted baseline.",
    status: "blocked",
    dependencies: ["RUN-03"],
    logicNotes: [
      "Measure false-positive regressions, not only boosted-entity gains.",
      "Keep the vocabulary list fixed by vertical and version it with the run.",
    ],
  },
  {
    id: "RANK-01",
    phase: "7 · Decision",
    title: "Compute per-vertical rankings",
    description:
      "Rank providers using accuracy, entity, latency, cost, and diarization evidence.",
    status: "blocked",
    dependencies: ["RUN-03", "MET-02", "MET-03", "MET-04"],
    logicNotes: [
      "Entity and alphanumeric accuracy should outweigh raw WER for agent workflows.",
      "Publish raw metrics beside any composite score so weights cannot hide tradeoffs.",
    ],
  },
  {
    id: "RANK-02",
    phase: "7 · Decision",
    title: "Write recommendation and confidence note",
    description:
      "Recommend keep, switch, or per-vertical defaults with uncertainty and operational caveats.",
    status: "blocked",
    dependencies: ["RANK-01", "EXP-01"],
    logicNotes: [
      "Require a practical effect-size threshold before switching the Rush default.",
      "Call out low-sample verticals and hard-case strata explicitly.",
    ],
  },
  {
    id: "SCALE-01",
    phase: "8 · Scale",
    title: "Scale the corpus to 50–100 calls",
    description:
      "Expand only after scoring reproducibility and privacy review pass on the starter corpus.",
    status: "blocked",
    dependencies: ["RANK-02"],
    logicNotes: [
      "Allocate new calls to the strata with the widest confidence intervals.",
      "Preserve the starter set as a fixed regression subset.",
    ],
  },
];