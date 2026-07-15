# SFSC Protocol Notes

This directory holds the product protocol notes that are stable enough to be read independently from the broad interface contract.

`docs/INTERFACE_CONTRACT.md` remains the canonical full contract for release gates. The files here split high-change areas into smaller documents and add machine-readable mirrors where that reduces drift.

## Files

- `00-http-basics.md`: shared JSON HTTP boundary, write-request guard order, body limit, error envelope, and local browser-origin rules.
- `01-error-codes.md`: stable HTTP error envelope, status mapping, runtime-synthesized codes, and pass-through rules.
- `02-heartbeat-device-sync.md`: heartbeat success contract, compatibility policy, device sync state, last run, and scheduler details.
- `03-diagnostic-bundle.md`: public support diagnostic export shape, fallback rules, and redaction boundary.
- `04-claim-lifecycle.md`: SyncKey token format, create/redeem response keys, replay binding, and recovery boundaries.
- `05-profile-import.md`: client local profile import request envelope, offline profile import codes, and server-issued profile keys.
- `06-runtime-diagnostics.md`: runtime diagnostics fields, protocol versions, compatibility actions, and policy consequences.
- `PROTOCOL_V1_BASELINE.md`: frozen Protocol v1 surface, compatibility policy, evidence gates, and rollback rule.
- `schemas/http-basics.json`: machine-readable mirror of the shared server/client JSON transport boundary.
- `schemas/error-codes.json`: machine-readable mirror of `src/core/errors.js` for HTTP stable codes and claim-redeem pass-through codes.
- `schemas/heartbeat-device-sync.json`: machine-readable mirror of the heartbeat/device sync key contracts enforced by `scripts/lib/runtimeContracts.mjs`.
- `schemas/diagnostic-bundle.json`: machine-readable mirror of the diagnostic bundle key contracts enforced by `scripts/lib/runtimeContracts.mjs`.
- `schemas/claim-lifecycle.json`: machine-readable mirror of SyncKey constants, claim payload keys, and claim create/redeem response keys.
- `schemas/profile-import.json`: machine-readable mirror of profile import response keys and server-issued profile key contracts.
- `schemas/runtime-diagnostics.json`: machine-readable mirror of protocol version constants and compatibility enums.
- `schemas/protocol-v1-baseline.json`: frozen Protocol v1 identifiers, compatibility behavior, and required release evidence.

## Drift Rules

- Stable HTTP error codes must be added first in `src/core/errors.js`.
- `schemas/http-basics.json` must match the server/client request guards, JSON body readers, and common error response contract.
- `schemas/error-codes.json` must match `DEFAULT_STATUS_BY_CODE` and `CLAIM_REDEEM_ERROR_CODES` exactly.
- `schemas/heartbeat-device-sync.json` and `schemas/diagnostic-bundle.json` must keep their exact-key arrays aligned with `scripts/lib/runtimeContracts.mjs`.
- `schemas/claim-lifecycle.json` must match `src/core/claimProtocol.js` constants and the claim response keys enforced by `scripts/lib/runtimeContracts.mjs`.
- `schemas/profile-import.json` must match `src/core/profileProtocol.js` constants and the profile/defaults response keys enforced by `scripts/lib/runtimeContracts.mjs`.
- `schemas/runtime-diagnostics.json` must match `src/core/diagnostics.js`, claim/profile version constants, and compatibility enums enforced by `scripts/lib/runtimeContracts.mjs`.
- `schemas/protocol-v1-baseline.json` must remain aligned with the runtime diagnostic protocol map and the v1 compatibility policy; wire-incompatible changes require a later protocol version.
- `docs/INTERFACE_CONTRACT.md`, `public/app.js`, and `client/public/app.js` must keep the same code list visible to humans and UI copy.
- Release audit fails when these sources drift.
