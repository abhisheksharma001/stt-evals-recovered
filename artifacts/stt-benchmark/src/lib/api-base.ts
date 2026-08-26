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
