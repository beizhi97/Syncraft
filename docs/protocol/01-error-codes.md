# Error Codes

SFSC uses one HTTP error envelope across the server admin API, runtime API, and client local API:

```json
{
  "ok": false,
  "error": "validation_failed",
  "errorCode": "validation_failed",
  "message": "validation_failed"
}
```

`error` is the legacy alias. New code should read `errorCode`. The full human-readable table remains in `docs/INTERFACE_CONTRACT.md`; the machine-readable mirror is `docs/protocol/schemas/error-codes.json`.

## HTTP Stable Codes

`src/core/errors.js` is the implementation source. `docs/protocol/schemas/error-codes.json` mirrors:

- every `DEFAULT_STATUS_BY_CODE` entry and HTTP status;
- every `CLAIM_REDEEM_ERROR_CODES` entry that the client may pass through from a redeem response.

Release audit compares the JSON mirror with the implementation source exactly. If a code is added, removed, renamed, or moved to another HTTP status, the audit must fail until all sources are updated.

## Runtime-Synthesized Codes

Some stable codes are not emitted by an HTTP JSON error response. They are produced by UI wrappers, heartbeat state, diagnostics, or package inspection:

- `heartbeat_failed`
- `network_error`
- `request_timeout`
- `release_manifest_invalid`

These codes are display and diagnostics contracts. They do not belong in `DEFAULT_STATUS_BY_CODE` unless an HTTP endpoint starts returning them in the common error envelope.

## 2xx `ok:false`

Operation endpoints should not report success with a top-level `ok:false` body. Client page wrappers must reject such responses unless the endpoint is explicitly status-style.

Currently allowed status-style responses:

- `POST /api/binaries/check`: may return HTTP 200 with top-level `ok:false` so the UI can show per-binary details.
- `GET /api/client/status`, `GET /api/sync/history`, and `GET /api/diagnostics/export`: may contain nested failure states while the request itself succeeds.
- selected server admin storage operations may use documented partial-success shapes, such as bucket refresh/create storage request failures.

All other operation endpoints should use non-2xx HTTP status with the common error envelope.
