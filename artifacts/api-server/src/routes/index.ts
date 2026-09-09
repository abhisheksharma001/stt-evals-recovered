import { Router, type IRouter } from "express";
import disagreementSpansRouter from "./disagreement-spans";
import agentRouter from "./agent";
import agentMarksRouter from "./agent-marks";
import benchmarkRouter from "./benchmark";
import bulksRouter from "./bulks";
import healthRouter from "./health";

const router: IRouter = Router();

router.use(healthRouter);
router.use(benchmarkRouter);
router.use(bulksRouter);
router.use(agentRouter);
router.use(agentMarksRouter);
router.use(disagreementSpansRouter);

export default router;
