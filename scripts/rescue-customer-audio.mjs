#!/usr/bin/env node
// Save each call's customer-channel and assistant-channel recordings plus the Vapi
// artifact (messages with timings, tool calls, performanceMetrics) into the gitignored
// audio cache before Vapi's 14-day retention expires. First run 2026-09-04 (PRD v6 Part B):
// 99/99 Land And Apartment calls saved; the 22 Default-account calls answer 400 (expired).
//
//   cd artifacts/api-server && node --env-file=.env ../../scripts/rescue-customer-audio.mjs
//
// Free: Vapi downloads only, no STT provider. Idempotent: existing files are skipped.
// Needs the API on :8177 for the call list. Prints counts and call-id prefixes only --
// never env values, never transcript text. Superseded for NEW calls by the import path
// (M-6, 2026-09-05: cacheCallSidecars in artifacts/api-server/src/lib/audio-cache.ts
// writes the same three files); still the recovery tool for anything imported before it,
// including a call whose mono file was already cached, which the rescue endpoint skips.
import fs from "node:fs";
import path from "node:path";
const CACHE = path.resolve("audio-cache");
const API = "http://127.0.0.1:8177/api/benchmark";
const keyFor = (label) => {
  if (!label || label === "Default") return process.env.VAPI_API_KEY;
  const name = "VAPI_API_KEY_" + label.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return process.env[name];
};
const calls = (await (await fetch(`${API}/calls`)).json()).filter((c) => c.sourceCallId);
const stats = { total: calls.length, customerSaved: 0, assistantSaved: 0, artifactSaved: 0, skipped: 0, noKey: 0, noCustomerUrl: 0, httpErr: 0 };
const failed = [];
async function one(c) {
  const key = keyFor(c.sourceAccountLabel);
  if (!key) { stats.noKey++; return; }
  const cust = path.join(CACHE, `${c.id}.customer.audio`);
  const asst = path.join(CACHE, `${c.id}.assistant.audio`);
  const art = path.join(CACHE, `${c.id}.artifact.json`);
  if (fs.existsSync(cust) && fs.existsSync(art)) { stats.skipped++; return; }
  const res = await fetch(`https://api.vapi.ai/call/${c.sourceCallId}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) { stats.httpErr++; failed.push(`${c.id.slice(0, 8)} GET ${res.status}`); return; }
  const call = await res.json();
  const a = call.artifact ?? {};
  if (!fs.existsSync(art)) {
    fs.writeFileSync(art, JSON.stringify({ savedAt: new Date().toISOString(), messages: a.messages ?? null, performanceMetrics: a.performanceMetrics ?? null, transcript: a.transcript ?? null, endedReason: call.endedReason ?? null, analysis: call.analysis ?? null, costs: call.costs ?? null, startedAt: call.startedAt ?? null, endedAt: call.endedAt ?? null }, null, 0), { mode: 0o600 });
    stats.artifactSaved++;
  }
  const dl = async (url, file, counter) => {
    if (!url || fs.existsSync(file)) return;
    const r = await fetch(url);
    if (!r.ok) { failed.push(`${c.id.slice(0, 8)} ${path.extname(file)} ${r.status}`); return; }
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()), { mode: 0o600 });
    stats[counter]++;
  };
  if (!a.presignedCustomerUrl) stats.noCustomerUrl++;
  await dl(a.presignedCustomerUrl, cust, "customerSaved");
  await dl(a.presignedAssistantUrl, asst, "assistantSaved");
}
const queue = [...calls];
await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) { const c = queue.shift(); try { await one(c); } catch (e) { stats.httpErr++; failed.push(`${c.id.slice(0, 8)} ${String(e.message).slice(0, 60)}`); } } }));
console.log(JSON.stringify(stats));
if (failed.length) console.log("failed:", failed.slice(0, 20).join(" | "), failed.length > 20 ? `(+${failed.length - 20})` : "");
