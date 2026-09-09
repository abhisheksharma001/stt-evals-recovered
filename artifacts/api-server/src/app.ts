import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { jsonErrorHandler, jsonNotFoundHandler } from "./lib/error-handler";
import { allowedOrigins, isOriginAllowed } from "./lib/cors-origins";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// R-31 (ox-alpha B-4): was `cors()`, i.e. Access-Control-Allow-Origin: *, on
// an unauthenticated API that serves transcripts and audio. See
// lib/cors-origins.ts for what that allowed and what this does not fix.
const corsAllowed = allowedOrigins();
app.use(
  cors({
    origin(origin, callback) {
      if (isOriginAllowed(origin, corsAllowed)) {
        callback(null, true);
        return;
      }
      // Refuse by not setting the header, rather than by throwing: an error
      // here becomes a 500, which reads as "the server is broken" instead of
      // "this origin may not read this". The browser blocks it either way.
      callback(null, false);
    },
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// T-149: anything the router did not match is a 404 in JSON, not Express's
// HTML page. This server serves nothing but the API, so every unmatched path
// is an API mistake and every caller of one is parsing JSON.
app.use(jsonNotFoundHandler);

// T-76: after the router, so anything a handler throws or rejects answers
// as JSON with the request id -- never Express's HTML error page.
app.use(jsonErrorHandler);

export default app;
