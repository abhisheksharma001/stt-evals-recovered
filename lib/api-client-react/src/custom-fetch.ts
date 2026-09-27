// W-8: the mutator itself lives in @workspace/api-client (the plain SDK) so
// there is one copy of the fetch logic. This file is what orval points the
// React target at, and orval reads it two ways: it greps the text for
// `export type ErrorType` / `export type BodyType`, and it parses the AST to
// count customFetch's parameters. A bare re-export would parse as a
// one-parameter mutator and change the generated hooks, so this stays a real
// two-parameter function.
import { customFetch as baseFetch } from "@workspace/api-client";
import type { ApiError, CustomFetchOptions } from "@workspace/api-client";

export type ErrorType<T = unknown> = ApiError<T>;

export type BodyType<T> = T;

export async function customFetch<T = unknown>(
  input: RequestInfo | URL,
  options: CustomFetchOptions = {},
): Promise<T> {
  return await baseFetch<T>(input, options);
}

export {
  setBaseUrl,
  getBaseUrl,
  setAuthTokenGetter,
  setActorLabel,
  ApiError,
} from "@workspace/api-client";
export type { AuthTokenGetter } from "@workspace/api-client";
