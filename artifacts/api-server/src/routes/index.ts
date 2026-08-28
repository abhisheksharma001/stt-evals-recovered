import { Router, type IRouter } from "express";
import adjudicationsRouter from "./adjudications";
import agentRouter from "./agent";
import benchmarkRouter from "./benchmark";
import bulksRouter from "./bulks";
import healthRouter from "./health";

const router: IRouter = Router();

router.use(healthRouter);
router.use(benchmarkRouter);
router.use(bulksRouter);
router.use(agentRouter);
router.use(adjudicationsRouter);

export default router;
