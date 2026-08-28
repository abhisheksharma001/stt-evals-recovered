import { Router, type IRouter } from "express";
import adjudicationsRouter from "./adjudications";
import agentRouter from "./agent";
import benchmarkRouter from "./benchmark";
import bulksRouter from "./bulks";
import healthRouter from "./health";
import judgeAccuracyRouter from "./judge-accuracy";

const router: IRouter = Router();

router.use(healthRouter);
router.use(benchmarkRouter);
router.use(bulksRouter);
router.use(agentRouter);
router.use(adjudicationsRouter);
router.use(judgeAccuracyRouter);

export default router;
