# Integration Strategy — Vapi STT Benchmark

This is the implementation decision record for external dependencies.

## Runtime separation

| Layer | Can use MCP? | Can use direct API / connector? |
|---|---:|---:|
| Chat-side engineering research | Yes | Yes |
| Deployed React browser | No | No credentials in browser |
| Deployed API server / worker | No | Yes |

MCP must never be included in a benchmark-run code path. It is not an application-runtime transport.

## Integration choices

| Service | Preferred runtime route | Fallback | Build-time decision |
|---|---|---|---|
| Vapi recording history | Direct REST adapter | Manual private-file upload | Verify API resource, pagination, recording download semantics, and retention behavior |
| Deepgram STT | Direct REST/WebSocket adapter | None | Pin endpoint/model and streaming replay behavior |
| Cartesia STT | Direct REST/WebSocket adapter | None | Pin endpoint/model and support for historical-audio replay |
| ElevenLabs STT | Native connector if it supports the exact transcription flow; otherwise direct API adapter | Direct API adapter | Connector implementation must fit the adapter interface without changing persisted result format |
| Private audio | Platform object storage via pre-signed upload/download | Approved equivalent private object store | Enforce short-lived URL, checksum, and audit requirements |
| Benchmark metadata/results | PostgreSQL | None for initial build | Preserve immutable run and result records |

## Connector review policy

1. Review an existing native connector before asking for a raw API key.
2. Use the connector only from server code and only when it covers the required action.
3. Do not embed connector plumbing into scoring or ranking logic.
4. If no native connector meets the need, implement a direct adapter and store the credential through the secret manager.
5. A missing connector is not a reason to use MCP in the running application.

## Required secret references

```text
VAPI_API_KEY
DEEPGRAM_API_KEY
CARTESIA_API_KEY
ELEVENLABS_API_KEY          # only when the ElevenLabs native connector is not selected
```

These names are design placeholders. The implementation must request/attach them through the platform’s secure secrets or connector flow, never through a database field, browser form, log line, or source file.

## Provider adapter non-goals

- No single “universal” request payload that erases provider-specific settings.
- No browser-to-provider requests.
- No automatic custom vocabulary across all providers.
- No silent model fallback.

Every adapter must fail explicitly when the requested model or required benchmark mode is unsupported.