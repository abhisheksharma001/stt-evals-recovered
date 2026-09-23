// W-6b: Layer 1's data, read from the ledger alone.
//
// The fixtures write ledger rows directly (settled days carry a W-5e
// `production` entry) and never a bulk: the whole point of the overview is
// that it reads the same whether the bulks still exist or not. The schedule
// stays `enabled: false` so no other suite's tick can act on it; the overview
// lists disabled schedules too, and says so.
//
// Written to hold whether or not a VAPI key is in this environment (T-168):
// the account id carries the fixture suffix, so it matches no configured
// account either way and `accountLabel` is null.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool, type WatchRunProduction } from "@workspace/db";
import { server } from "./server";
import { Fixtures } from "./fixtures";
import { localDay } from "../../lib/watch-scheduler";

const fx = new Fixtures();

let scheduleId: string;
let accountId: string;
let assistantId: string;
const today = localDay(new Date());

/** `today` minus n local days, the way the ledger writes them. */
const daysAgo = (n: number): string => {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  return localDay(new Date(y, m - 1, d - n));
};

const settled = (mismatch: number, compared: number, calls: number): WatchRunProduction[] => [
  {
    assistantId,
    calls,
    totalCalls: calls,
    mismatchWords: mismatch,
    comparedWords: compared,
    leaderProviderId: `fx-leader-${fx.suffix}`,
    leaderMismatchWords: 1,
    leaderComparedWords: compared,
  },
];

beforeAll(async () => {
  assistantId = `fx-asst-overview-${fx.suffix}`;
  const schedule = await fx.schedule();
  scheduleId = schedule.id;
  accountId = schedule.accountId;

  // The production transcriber comes from the corpus rows, offline.
  await fx.call({ sourceAssistantId: assistantId, sourceTranscriberProvider: "deepgram", sourceTranscriberModel: "flux-general-en" });
  await fx.call({ sourceAssistantId: assistantId, sourceTranscriberProvider: "deepgram", sourceTranscriberModel: "flux-general-en" });
  await fx.call({ sourceAssistantId: assistantId, sourceTranscriberProvider: "deepgram", sourceTranscriberModel: "nova-3" });

  // Seven settled prior days at 2 per 100, one refused day with no rate, and
  // today at 20 per 100 on ten calls: forming becomes a band, and today is
  // outside it.
  for (let n = 8; n >= 2; n -= 1) {
    await fx.watchRun(scheduleId, daysAgo(n), {
      outcome: "settled",
      totals: [],
      production: settled(2, 100, 10),
      detail: { estimatedCents: 7 },
    });
  }
  await fx.watchRun(scheduleId, daysAgo(1), { outcome: "refused:daily_cap", detail: { estimatedCents: 900 } });
  await fx.watchRun(scheduleId, today, {
    outcome: "settled",
    totals: [],
    production: settled(20, 100, 10),
    detail: { estimatedCents: 7 },
  });
  // Outside the 30-day window: must not be listed.
  await fx.watchRun(scheduleId, daysAgo(40), { outcome: "settled", totals: [], production: settled(50, 100, 10) });
});

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

const overview = async () => {
  const res = await request(server).get("/api/benchmark/watch/overview");
  expect(res.status).toBe(200);
  return res.body as {
    today: string;
    windowStart: string;
    accounts: {
      accountId: string;
      accountLabel: string | null;
      agents: {
        scheduleId: string;
        enabled: boolean;
        assistantId: string | null;
        production: { vendor: string; model: string | null } | null;
        baseline: { state: string; priorDays: number; low: number | null; high: number | null };
        monthEstimatedCents: number;
        days: { day: string; outcome: string; bulkId: string | null; rate?: number; calls?: number; leaderRate?: number | null }[];
      }[];
    }[];
  };
};

const agentRow = async () => {
  const body = await overview();
  const account = body.accounts.find((a) => a.accountId === accountId);
  expect(account).toBeDefined();
  const agent = account!.agents.find((g) => g.scheduleId === scheduleId && g.assistantId === assistantId);
  expect(agent).toBeDefined();
  return { body, account: account!, agent: agent! };
};

describe("GET /api/benchmark/watch/overview (W-6b)", () => {
  it("lists the schedule's agent with its ledger days, newest first, inside the 30-day window", async () => {
    const { body, agent } = await agentRow();
    expect(body.today).toBe(today);
    expect(agent.enabled).toBe(false);
    expect(agent.days.map((d) => d.day)).toEqual([today, daysAgo(1), ...Array.from({ length: 7 }, (_, i) => daysAgo(i + 2))]);
    expect(agent.days.some((d) => d.day === daysAgo(40))).toBe(false);
  });

  it("carries a band and reads moved when today lies outside seven settled days", async () => {
    const { agent } = await agentRow();
    expect(agent.baseline.priorDays).toBe(7);
    expect(agent.baseline.low).toBe(2);
    expect(agent.baseline.high).toBe(2);
    expect(agent.baseline.state).toBe("moved");
    const todayRow = agent.days.find((d) => d.day === today)!;
    expect(todayRow.rate).toBe(20);
    expect(todayRow.calls).toBe(10);
    expect(todayRow.leaderRate).toBe(1);
  });

  it("gives a refused day its outcome verbatim and no rate field at all, never 0", async () => {
    const { agent } = await agentRow();
    const refused = agent.days.find((d) => d.day === daysAgo(1))!;
    expect(refused.outcome).toBe("refused:daily_cap");
    expect("rate" in refused).toBe(false);
    expect("calls" in refused).toBe(false);
  });

  it("resolves the production transcriber offline from the corpus, and leaves the account label null with no key (T-168)", async () => {
    const { account, agent } = await agentRow();
    expect(agent.production).toEqual({ vendor: "deepgram", model: "flux-general-en" });
    expect(account.accountLabel).toBeNull();
  });

  it("sums this month's estimated cents over launched and settled days only", async () => {
    const { agent } = await agentRow();
    // Eight settled rows this month at 7 cents each at most; the refused
    // 900 must not be in it. Rows may straddle a month boundary, so the
    // bound is what the fixture allows, not a fixed number.
    expect(agent.monthEstimatedCents % 7).toBe(0);
    expect(agent.monthEstimatedCents).toBeLessThanOrEqual(56);
    expect(agent.monthEstimatedCents).toBeGreaterThan(0);
  });
});
