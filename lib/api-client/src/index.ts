// W-8: the plain SDK. Everything under generated/ is orval output from
// lib/api-spec/openapi.yaml (client: "fetch"); nothing here imports React.
// Point it at a server with setBaseUrl("http://host:8177") -- generated paths
// already carry the /api prefix -- and name the caller with setActorLabel.
export * from "./generated/api";
export * from "./generated/api.schemas";
export {
  customFetch,
  setBaseUrl,
  getBaseUrl,
  setAuthTokenGetter,
  setActorLabel,
  ApiError,
  ResponseParseError,
} from "./custom-fetch";
export type { AuthTokenGetter, CustomFetchOptions } from "./custom-fetch";
