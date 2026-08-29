// T-39: which commit THIS UI bundle was built from (Vite `define`, see
// vite.config.ts). "dev" under the dev server. The API reports its own via
// /api/healthz; the badge shows both when they differ.
declare const __UI_BUILD_COMMIT_SHA__: string | undefined

export const uiBuildCommitSha: string = typeof __UI_BUILD_COMMIT_SHA__ === "string" ? __UI_BUILD_COMMIT_SHA__ : "dev"
