import { defineConfig, InputTransformerFn } from "orval";
import path from "path";

const root = path.resolve(__dirname, "..", "..");
const apiClientReactSrc = path.resolve(root, "lib", "api-client-react", "src");
const apiZodSrc = path.resolve(root, "lib", "api-zod", "src");

// Our exports make assumptions about the title of the API being "Api" (i.e. generated output is `api.ts`).
const titleTransformer: InputTransformerFn = (config) => {
  config.info ??= {};
  config.info.title = "Api";

  return config;
};

export default defineConfig({
  "api-client-react": {
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: titleTransformer,
      },
    },
    output: {
      workspace: apiClientReactSrc,
      target: "generated",
      client: "react-query",
      mode: "split",
      baseUrl: "/api",
      clean: true,
      prettier: true,
      override: {
        fetch: {
          includeHttpResponseReturnType: false,
        },
        mutator: {
          path: path.resolve(apiClientReactSrc, "custom-fetch.ts"),
          name: "customFetch",
        },
      },
    },
  },
  zod: {
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: titleTransformer,
      },
    },
    output: {
      workspace: apiZodSrc,
      client: "zod",
      target: "generated",
      schemas: { path: "generated/types", type: "typescript" },
      mode: "split",
      clean: true,
      prettier: true,
      override: {
        zod: {
          // T-141: pin the output to the zod major this repo actually installs
          // (3.x). Orval's default is `auto`, which fell back to zod 4 output
          // and emitted `zod.uuid()` -- a v4-only top-level form -- the moment
          // the spec first used `format: uuid`. It only surfaced because the
          // codegen script typechecks what it generates.
          version: 3,
          // T-142: `number` only. A URL carries text, so a numeric parameter has
          // to be coerced -- but coercing `string` and `boolean` only ever
          // hides mistakes:
          //   z.coerce.string() on a missing parameter yields the literal
          //     string "undefined" (String(undefined)), which passes .min(1),
          //     so `GET /benchmark/volume` with no accountLabel answered
          //     `No Vapi account configured with label "undefined"` (404)
          //     instead of "you left out a required parameter" (400);
          //   z.coerce.string() on a repeated parameter (?id=a&id=b, which
          //     Express parses as an array) yields "a,b";
          //   z.coerce.boolean() reads ?flag=false as true (Boolean("false")).
          // Without coercion each of those fails validation and answers 400,
          // which is what actually happened.
          coerce: {
            query: ['number'],
            param: ['number'],
            body: ['bigint', 'date'],
            response: ['bigint', 'date'],
          },
        },
        useDates: true,
        useBigInt: true,
      },
    },
  },
});
