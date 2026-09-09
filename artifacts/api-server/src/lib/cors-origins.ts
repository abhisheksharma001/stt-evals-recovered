// R-31 (ox-alpha B-4): `app.use(cors())` answered every request with
// `Access-Control-Allow-Origin: *`. This API has no auth (B-1), listens on
// localhost (M-3), and serves goldTranscript, draftTranscript and an audio
// redirect off `/benchmark/calls`. With `*`, any page the operator happens to
// visit can `fetch("http://localhost:8177/api/benchmark/calls")`, read every
// caller transcript, and post them somewhere else. No click, no auth prompt.
// The origin allowlist is the only thing standing between a browser tab and
// the corpus, and until now it allowed everything.
//
// This is not auth. B-1 is still open and this does not close it -- a request
// with no Origin header (curl, another server) is untouched, because CORS is
// a browser rule and pretending otherwise would be security theatre.

/** Dev and preview origins this repo actually serves the UI from. */
const DEFAULT_ALLOWED = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

/** Split hosting: WEB_ORIGINS is a comma-separated list of extra origins,
 *  e.g. "https://stt.example.com". Blank entries are ignored so a trailing
 *  comma cannot allowlist "". */
export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.WEB_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter((o) => o.length > 0);
  return [...new Set([...DEFAULT_ALLOWED, ...extra])];
}

/** True when this Origin may read a response.
 *
 *  `undefined` means the request carried no Origin header: curl, a
 *  server-to-server call, or a same-origin navigation. Those were never
 *  restricted by CORS and are not restricted now -- refusing them would
 *  break the deploy script's healthz check and every operator using curl,
 *  while stopping no attacker, since a non-browser client sets whatever
 *  Origin it likes. */
export function isOriginAllowed(
  origin: string | undefined,
  allowed: readonly string[],
): boolean {
  if (origin === undefined) return true;
  // Compared exactly, after trimming a trailing slash. No prefix or suffix
  // matching: "https://evil-stt.example.com" must not pass a check written
  // for "https://stt.example.com".
  return allowed.includes(origin.replace(/\/+$/, ""));
}
