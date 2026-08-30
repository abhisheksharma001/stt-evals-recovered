// T-103 (2026-08-30, per Abhishek): the judge model list comes from OpenAI
// live (GET /v1/models), so a new model shows up without anyone editing a
// constant -- with his five pinned on top. Read-only, key from the
// environment at call time, never stored, 10-minute cache.
//
// "5.5 sol" in his message: the live list has both `gpt-5.5` and
// `gpt-5.6-sol` (2026-08-30). Both are pinned until he says which he meant.
export const PINNED_AGENT_MODELS = ["gpt-4.1", "gpt-5.2", "gpt-5.5", "gpt-5.6-sol", "gpt-4o", "gpt-4.1-mini"] as const;

/** Not a chat/judge model, whatever the id says. */
const NOT_A_JUDGE = /realtime|audio|tts|transcribe|whisper|search|image|embed|moderation|instruct|codex|dall-e|davinci|babbage|computer-use|chat-latest/;

const TTL_MS = 10 * 60 * 1000;
let cache: { at: number; ids: string[] } | null = null;

export class OpenAiModelsError extends Error {
  constructor(message: string, readonly httpStatus: number | null) {
    super(message);
    this.name = "OpenAiModelsError";
  }
}

export async function listOpenAiJudgeModels(): Promise<{ ids: string[]; fetchedAt: string }> {
  if (cache && Date.now() - cache.at < TTL_MS) return { ids: cache.ids, fetchedAt: new Date(cache.at).toISOString() };
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new OpenAiModelsError("OPENAI_API_KEY is not configured.", null);
  const res = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new OpenAiModelsError(`OpenAI /v1/models returned HTTP ${res.status}.`, res.status);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = (body.data ?? [])
    .map((m) => m.id ?? "")
    .filter((id) => /^(gpt-|o\d)/.test(id) && !NOT_A_JUDGE.test(id))
    // Dated snapshots ("gpt-4o-2024-08-06") are the same model as their alias.
    .filter((id) => !/-\d{4}(-\d{2}-\d{2})?$/.test(id))
    .sort();
  cache = { at: Date.now(), ids };
  return { ids, fetchedAt: new Date(cache.at).toISOString() };
}
