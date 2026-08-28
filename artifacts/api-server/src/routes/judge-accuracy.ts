// T-09: judge accuracy. GET is free (arithmetic over stored rows); POST
// spends OpenAI money, at most REPLAY_BATCH_LIMIT judge calls per request.
import { Router, type IRouter } from "express";
import { GetJudgeAccuracyResponse, ReplayJudgeAccuracyBody, ReplayJudgeAccuracyResponse } from "@workspace/api-zod";
import { actorFromRequest } from "../lib/audit";
import { judgeAccuracyReport, replayPendingAdjudications } from "../lib/judge-accuracy";

const router: IRouter = Router();

router.get("/benchmark/judge-accuracy", async (_req, res): Promise<void> => {
  res.json(GetJudgeAccuracyResponse.parse(await judgeAccuracyReport()));
});

router.post("/benchmark/judge-accuracy/replay", async (req, res): Promise<void> => {
  const body = ReplayJudgeAccuracyBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const outcome = await replayPendingAdjudications({ actorLabel: actorFromRequest(req), limit: body.data.limit ?? undefined });
  res.json(ReplayJudgeAccuracyResponse.parse(outcome));
});

export default router;
