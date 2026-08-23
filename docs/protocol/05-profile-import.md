# Profile Import

Profile import is the client-local boundary that turns an import code into local profile, jobs, scheduler, and secret-vault state.

`src/core/profileProtocol.js` is the offline profile format source of truth. `scripts/lib/runtimeContracts.mjs` enforces the response shapes. The machine-readable mirror is `docs/protocol/schemas/profile-import.json`.

## Import Request

`POST /api/profile/import` accepts a JSON object with string import fields:

`code`, `tKey`, `tkey`, `claimCode`, `token`, `uri`, `clientName`, `server`.

It does not accept a raw `{ "profile": { ... } }` object. Complete offline profiles must be encoded as an import code with `SFSC1-...` or `sfsc://import/v1#...`.

`code`, `tKey`, `tkey`, `claimCode`, and `token` are aliases for a full SyncKey or an offline full profile import code. `uri` is retained for legacy VLESS URI import compatibility. Legacy VLESS import may also use `clientName` and `options.localProxyPort`.

`/api/claims/create.code` is an `AAAA-AAAA` human short code. Client-local `/api/profile/import` accepts it only together with the corresponding HTTP(S) `server` address, normalizes both values, creates the same pending recovery binding as a full SyncKey, and redeems it through that server. A short code without a valid `server` returns `import_code_invalid` and must not consume the claim.

## Offline Profile Codes

Current profile constants:

- `PROFILE_VERSION`: `1`;
- `PROFILE_CODE_PREFIX`: `SFSC1-`;
- `PROFILE_URI_PREFIX`: `sfsc://import/v1#`.

An offline profile import code carries a full normalized profile payload. Server-issued offline profiles must include `source.type: "profile"` and `source.server`.

## Server-Issued Profile

A server-issued profile has exact top-level keys:

`clientName`, `defaults`, `expiresAt`, `heartbeat`, `issuedAt`, `profileId`, `storage`, `tunnel`, `version`.

`source` is required for server-issued offline profile codes produced by `POST /api/profile/encode`. It is not present in raw `POST /api/claims/redeem` success responses.

`heartbeat` has exact keys `scheme`, `secret`.

`storage` has exact keys:

`accessKeyId`, `bucket`, `endpoint`, `prefix`, `remoteName`, `secretAccessKey`, `type`.

`defaults` has exact keys:

`bandwidthLimit`, `checkers`, `chunkSize`, `localProxyPort`, `lowLevelRetries`, `retries`, `schedule`, `streams`, `transfers`.

## Import Success Response

`POST /api/profile/import` returns the client profile import response contract with exact top-level keys:

`profile`.

The returned `profile` is a display-safe summary shape. It must not expose the raw tunnel URI, storage access key, storage secret key, heartbeat secret, full SyncKey, claim short code, token, or complete server-issued profile object.

After a claim redeem import succeeds, the client adds `source.type: "claim"`, `source.server`, `importMode: "claim-redeem"`, and `importedAt`. After an offline profile code import succeeds, `importMode` is `offline-profile`.

## Validation And Commit Boundary

Server-issued claim profiles and server-issued offline profiles must include heartbeat credentials, storage credentials, and tunnel material. Missing heartbeat material returns `profile_heartbeat_required`; missing storage material returns `profile_storage_required`; missing tunnel material returns `profile_tunnel_required`. These material errors clear pending claim recovery because replaying the same SyncKey can only return the same unusable profile.

The import commit is all-or-nothing. Profile, jobs, scheduler, secrets, and claim recovery state must move together. Local persistence failure rolls back profile/jobs/secrets to the pre-import snapshot and retains recovery for retryable claim imports.
