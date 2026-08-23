# Claim Lifecycle

The claim lifecycle is the product SyncKey protocol. It connects the server console create flow, the client import flow, and the server redeem endpoint.

`src/core/claimProtocol.js` is the token-format source of truth. The machine-readable mirror is `docs/protocol/schemas/claim-lifecycle.json`.

## Token Format

Current constants:

- `CLAIM_VERSION`: `1`;
- `CLAIM_CODE_PREFIX`: `SFSC1-`;
- `CLAIM_URI_PREFIX`: `sfsc://import/v1#`;
- `CLAIM_CODE_ALPHABET`: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`.

The encoded claim payload has exact keys:

`version`, `type`, `server`, `code`.

`type` must be `claim`. `server` is an HTTP(S) origin without a trailing slash. `code` is the one-time short code used by `POST /api/claims/redeem`.

The current short-code alphabet intentionally removes ambiguous characters. Decode accepts legacy `AAAA-AAAA` style uppercase alphanumeric short codes only for existing data compatibility; new tokens must use the current alphabet.

## Create Response

`POST /api/claims/create` returns the claim create response contract with exact keys:

`claim`, `claimCode`, `code`, `compatibility`, `profile`, `state`, `tKey`, `tKeyUri`, `uri`.

`code` is the human short code for the server redeem endpoint. A client may import it when the request also supplies the corresponding normalized HTTP(S) `server` address; the short code is not self-routing and must never be guessed against an implicit server.

`tKey` and legacy alias `claimCode` are the full `SFSC1-...` SyncKey. `tKeyUri` and legacy alias `uri` are the full `sfsc://import/v1#...` URI. The `claim` object is a redacted admin summary and must not contain a SyncKey, full profile, storage secret, heartbeat secret, or VLESS URI.

SyncKey creation is considered published only after the server has persisted the claim/device state and the sing-box config write timestamp is present in the returned admin state.

## Redeem Response

`POST /api/claims/redeem` returns the claim redeem response contract. Success is a bare server-issued profile, not an `{ ok: true, profile }` operation envelope. The client local import resolver tolerates a legacy `{ profile: ... }` wrapper only as an inbound compatibility path; that wrapper is not the server contract.

The server-issued profile keys are documented in `05-profile-import.md`. The server redeem success must not include `source`, `importMode`, or `importedAt`; those are added by the client local runtime only after import succeeds.

## Replay Binding

Redeem is one-time with a short recovery window for lost client-side commits.

- A repeated redeem from the same client binding is accepted within `claim.replayUntil`.
- A repeated redeem from a different binding returns `claim_already_used`.
- A repeated redeem with missing binding also returns `claim_already_used`.
- After `claim.replayUntil`, all duplicate redeem attempts return `claim_already_used`.

The client binding is represented by `clientRedeemId` and `clientInstallId`. Client recovery storage keeps only server plus a code hash, never the short code or full SyncKey.

## Recovery Boundary

Terminal errors clear recovery because the same SyncKey cannot complete later:

`claim_not_found`, `claim_already_used`, `claim_expired`, `validation_failed`.

Server-issued profile material errors also clear recovery because replaying the same SyncKey can only return the same unusable profile:

`profile_heartbeat_required`, `profile_storage_required`, `profile_tunnel_required`.

Retryable or unknown outcomes retain recovery:

`claim_redeem_rate_limited`, `server_state_write_failed`, local persistence errors, network failures, request timeouts, unstructured remote failures, unregistered remote errors, and malformed HTTP 2xx success bodies.

If redeem-time revalidation finds the target device, bucket, tunnel material, storage material, heartbeat material, or profile expiry invalid, the server returns a structured failure and must not consume the claim.
