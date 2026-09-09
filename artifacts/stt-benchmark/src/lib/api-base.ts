import { getBaseUrl } from "@workspace/api-client-react";

/**
 * Base URL for hand-built API URLs (audio element src, downloads) that don't
 * go through the generated client's customFetch. Mirrors whatever
 * VITE_API_BASE_URL was set at bootstrap; "" means same-origin.
 * Bug-register B-30: a hardcoded "/api/..." audio src was dead under the
 * supported split-hosting deploy.
 */
export function apiBase(): string {
  return getBaseUrl() ?? "";
}

/** R-29 (ox-alpha B-18): every generated operation path already begins with
 *  `/api` -- orval bakes the spec's `servers: [{url: /api}]` into each one --
 *  so VITE_API_BASE_URL is an ORIGIN and nothing else. A value ending in
 *  `/api` produces `https://host/api/api/benchmark/...` and every request
 *  404s, which is what `.github/workflows/deploy-web.yml` documented.
 *
 *  The trailing `/api` is NOT stripped. Stripping would silently rewrite a
 *  value the operator chose, and there is no way from here to tell a mistake
 *  apart from an API genuinely mounted under a path. It is reported instead,
 *  and the value is used exactly as given. */
export function checkApiBaseUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const path = value.replace(/\/+$/, "");
  if (/\/api$/i.test(path)) {
    return (
      `VITE_API_BASE_URL is "${value}", which ends in /api. Every generated ` +
      `request path already starts with /api, so requests will go to ` +
      `${path}/api/... and 404. Set it to the API origin only.`
    );
  }
  return null;
}
