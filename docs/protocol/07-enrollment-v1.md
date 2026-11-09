# Enrollment Protocol v1 Boundary

Status: enrollment request, issue, consume, bootstrap channel code, first-root
registration, data-authorization, paired-device channel-renewal, and administrator
revocation HTTP slices are wired locally. Data
authorization remains contingent on successful SFTP relation materialization
and an actual sing-box supervisor restart; it does not by itself prove a
client-side round-trip sync or N1 acceptance.

The old `SFSC1-` / `sfsc://import/v1#` profile format remains unchanged.
Enrollment identities and revisions must not be inserted into old profile v1
or v2 payloads.

## Wire Envelopes

Paired devices renew the bootstrap channel with the exact raw target
`POST /api/enrollment/v1/channel-renewal` and body `{ "channelRevision": "..." }`.
The request uses `X-SFSC-Authorization`, signed by the persistent device key
over the original complete consumed binding, exact method/path/body digest, and
nonce. The service checks current consumed authority and revocation state; the
requested transport revision must equal the server's current applied bootstrap
revision, but need not equal the revision retained in the original binding.
Success returns exactly `{ "payload", "signature" }`; the payload contains
`protocol`, `version`, `kind: "channel-renewal"`, `serverId`, `keyId`,
`deviceId`, `channelRevision`, and `wrappedCode`. Its Ed25519 signature covers
canonical JSON UTF-8 bytes under the already pinned server signing key.
`wrappedCode` uses the existing channel-import wrapper and must be verified by
the existing client channel importer. Renewal does not rewrite the consumed
receipt, original binding, relation grant, or synchronization baseline. A
reconfiguration changes the transport revision while leaving that authority
binding valid for data authorization. Retries use fresh nonces; reissuing a
code for the same currently applied revision does not create another device or
relation grant.

The new protocol name is `sfsc-enrollment`, version `1`.

| Type | URI prefix | compact prefix | Purpose |
|---|---|---|---|
| Channel config | `sfsc://channel/v1#` | `SFSC-CHANNEL1-` | Connect to the restricted bootstrap surface |
| One-time enrollment | `sfsc://enroll/v1#` | `SFSC-ENROLL1-` | Prove possession of a server-issued enrollment record |

The compact and URI forms carry the same base64url-encoded JSON payload. The
decoder rejects malformed or noncanonical base64url and any unknown field.

## Channel Config

The channel config is generated before a device, share, root, or relation is
established. Its exact payload keys are:

`protocol`, `version`, `kind`, `serverId`, `channelRevision`, `issuedAt`,
`expiresAt`, `connection`, `bootstrap`, `authenticator`.

- `connection` is exactly `{ type: "vless", uri }`.
- `bootstrap` is exactly `{ endpoint, purpose, expiresAt }`.
- `purpose` is exactly `identity-enrollment`.
- The bootstrap URL cannot contain credentials, a query, or a fragment.
- Channel config and bootstrap windows are both limited and independently
  checked. The default maximum channel TTL is 24 hours and the maximum future
  `issuedAt` skew is 60 seconds.
- No device, share, root, relation, storage credential, data permission, or
  `authorized` value is accepted in this payload.

`createChannelConfigCode` signs the unsigned payload with an Ed25519 server
key and includes an exact `authenticator` object:

`scheme`, `keyId`, `signature`.

`verifyChannelConfigCode` verifies that signature only with a caller-pinned
server key. A pin must contain `serverId`, `publicKey`,
`allowedBootstrapOrigins`, and `bootstrapPathPrefix`. A matching `serverId`
string inside the code is never enough to establish trust. A key pinned for a
different server, an unpinned key, an invalid signature, or a bootstrap URL
outside the pinned origin and path policy fails closed.

`bootstrapPathPrefix` is matched on path-segment boundaries. The endpoint path
must equal the prefix or continue after a `/`. A pin for
`/api/enrollment/v1` therefore accepts
`/api/enrollment/v1/challenge`, but rejects
`/api/enrollment/v1evil/challenge`.

## One-time Enrollment

The exact payload keys are:

`protocol`, `version`, `kind`, `enrollmentId`, `requestId`, `serverId`,
`deviceId`, `channelRevision`, `publicKeyFingerprint`, `bindings`, `issuedAt`,
`expiresAt`, `secret`.

- `secret` contains at least 32 random bytes.
- The default maximum enrollment TTL is 15 minutes.
- The code is a bearer value. It is not a data authorization grant by itself.
- The server stores only a SHA-256 hash of `secret` plus the complete expected
  binding in persistent authority state.
- Consumption requires an exact `requestId`, device, channel revision, public
  key, and bindings match. A consumed, expired, cross-server, cross-device,
  cross-public-key, revoked, or rebound value fails.

Each entry in `bindings` is an explicit versioned `enrollment-binding`:

`protocol`, `version`, `kind`, `identity`, `baselineEpoch`,
`channelRevision`, `credentialRevision`, `rootAttestation`.

`identity` contains all five stable IDs: `serverId`, `deviceId`, `shareId`,
`rootId`, and `relationId`. `baselineEpoch` is a positive safe integer greater
than or equal to `1`. The initial generation is `1`; that value means only
that an initial baseline generation was assigned. It does not prove that the
first bisync run completed or that engine state has been initialized.

`rootAttestation` is exactly `{ source, referenceId, attestedAt }`. Its
presence records provenance supplied to the server record. It does not prove
that a filesystem root exists or is healthy; P2 must produce real attestation
evidence. Multiple bindings are allowed so the first enrollment packet does
not make one relation the permanent limit.

Successful consumption returns an `enrollment-grant` containing the same
versioned bindings. P3 consumers should use this output instead of copying new
identities into the old profile format.

## Directory Grant and Client Projection

The enrollment grant does not contain a storage directory description. The
server must provide a separate, explicitly versioned
`enrollment-directory-grant`:

```json
{
  "protocol": "sfsc-enrollment",
  "version": 1,
  "kind": "enrollment-directory-grant",
  "revision": 3,
  "binding": {},
  "root": {
    "backend": "webdav",
    "bucketName": "",
    "path": "shares/projects"
  },
  "scope": "device",
  "authorization": {
    "directions": ["bidirectional"],
    "allowDelete": true
  }
}
```

- `revision` is a positive safe integer.
- `binding` is the complete normalized `enrollment-binding`, including
  `deviceId`, `baselineEpoch`, channel and credential revisions, and the root
  attestation. Four identity IDs alone are not sufficient.
- `root.path` is a controlled remote-relative path. An empty string means the
  share root. Absolute paths, drive paths, UNC paths, backslashes, dot
  segments, empty path segments, percent escapes, query/fragment characters,
  non-NFC text, and surrounding whitespace are rejected.
- The only currently supported backends are `s3` and `webdav`. S3 requires a
  bucket name; WebDAV requires an empty bucket name.
- A server physical absolute directory must not enter this client-side
  authorization payload.

`client/src/enrollmentRelation.js` provides
`projectVerifiedEnrollmentRelation({ grant, binding, directoryGrant,
verifiedContext })`. It checks that:

1. the selected binding appears in the consumed enrollment grant;
2. every grant binding passes `normalizeEnrollmentBindings` with the expected
   server and device, so duplicate relations and foreign bindings are
   rejected;
3. the directory grant embeds the exact same full binding; and
4. the verification context names the same positive directory-grant revision.

The caller-supplied verification context has this shape:

`protocol`, `version`, `kind`, `verifier`, `verifiedAt`,
`directoryGrantRevision`, `expectedServerId`, `expectedDeviceId`,
`expectedRequestId`, `expectedPublicKeyFingerprint`,
`expectedChannelRevision`.

The five `expected*` fields are the caller's local request expectations. They
must exactly match the normalized grant and selected binding. This prevents a
valid but unrelated grant, directory grant, and verification context from
being swapped together while preserving the expected shapes. All grant
bindings must also belong to the expected server and device, use one channel
revision, and contain no duplicate relation.

It is only an association record for verification that the caller says it
already completed. It is not cryptographic proof, server authentication,
signature verification, or authorization. The projection therefore returns
provenance with `source: "caller-supplied-verification-context"` and
`cryptographicProof: false`; it does not emit `authorized` or
`signatureVerified` labels.

The projection returns a `trustedBinding` suitable for
`buildSyncRelation`. Enrollment grant, directory grant, and verification
context are the canonical persisted inputs; `trustedBinding` is a derived
value. A restart must revalidate and rederive it rather than trusting a saved
projection by itself.

Real response signatures, pinned trust material, and atomic persistent storage
remain P3 integration requirements. This adapter validates shape and
association only and must not be presented as the final authorization proof.

## Persistent State Contract

`src/core/enrollmentAuthority.js` exposes this storage contract:

`caller-held-lock+atomic-json-replace+revision-check-v1`.

The authority state is plain JSON and contains `revision`,
`enrollmentRecords`, `devices`, `relationGrants`, and
`authorizationNonces`.

All persisted records are validated before every exported authority operation:

- State-level timestamps and record timestamps must use canonical UTC
  millisecond ISO-8601 form.
- `devices` keys must match `deviceId`; the server, enrolled timestamp,
  Ed25519 JWK, and public-key fingerprint must be internally consistent.
- `relationGrants` keys must match the full binding's `relationId`; the
  binding must belong to the state server and reference a known device.
- `enrollmentRecords` must contain complete request, key, binding, expiry, and
  consumption fields. Consumption fields are mutually consistent.
- `revokedAt` and `consumedAt` are required and accept only `null` or a
  canonical timestamp. Missing fields, `false`, empty values, and malformed
  timestamps fail with `enrollment_state_invalid`.
- Every device has an `authorizationNonces` array. New devices are initialized
  with an empty array during first consumption. Re-enrollment and additional
  relation grants preserve the existing nonce history.
- A missing nonce array, a nonce array for an unknown device, a malformed
  nonce entry, or a duplicate nonce fails with `enrollment_state_invalid`.

- The caller must hold an exclusive lock across read, transition, validation,
  and atomic file replacement.
- Every mutating helper requires `expectedRevision`.
- Helpers return `nextState` and never mutate the input state.
- A failed transition leaves the input state unchanged.
- A successful transition advances the revision exactly once.
- Two processes using the same stale revision must not both commit. The module
  provides revision checks and transactional values; cross-process exclusion
  remains the server integration's lock responsibility.
- An ordinary enrollment cannot replace an existing device public key or
  rebind an existing relation to another device or root. Such changes require
  a separate administrator-controlled migration operation that is not defined
  in this package.
- Revoked devices and relation grants do not reactivate through ordinary
  enrollment.

This schema validation detects malformed or incomplete persisted state. It
cannot distinguish every semantically valid malicious rewrite, such as
replacing a revoked timestamp with `null` or substituting another complete,
internally consistent state. Protection against that broader threat requires
an external integrity mechanism and remains outside this module.

## Signed Authorization Requests

An authorization request signs one exact `enrollment-binding` plus:

`method`, `path`, `bodySha256`, `timestamp`, `nonce`,
`publicKeyFingerprint`, and `signature`.

Authorization is allowed only when persistent server state contains:

1. an active enrolled device with the same public key fingerprint;
2. an active relation grant whose full versioned binding is identical; and
3. a valid signature, current timestamp, unused nonce, and matching route.

The request does not accept an `authorized` field. A client cannot widen its
own access by sending a boolean or by changing identity fields.

### Exact HTTP Bytes

- `method` must already be uppercase ASCII.
- `path` is the exact ASCII origin-form request target, including the original
  query order and percent escapes. It is not a parsed pathname.
- `bodySha256` is SHA-256 over the exact request-body bytes before JSON parsing
  or reserialization.
- Empty request bodies use SHA-256 over zero bytes.
- The HTTP integration must compare the signed target with the raw target used
  by routing. It must not decode, normalize, or reserialize either side.

The validator rejects fragments, backslashes, malformed percent escapes,
empty path segments, dot segments, and encoded slash, backslash, or dot
segments in the pathname. Query bytes remain untouched. The router and signing
layer must share the same raw-target policy to avoid parser differentials.

The default timestamp window is five minutes. Live nonce entries are retained
through the exact window boundary and are never evicted to make room for new
requests. Saturation fails closed. Invalid or non-finite `maxSkewMs`,
`nonceLimit`, or clock values are rejected.

## Error Boundary

`EnrollmentProtocolError` exposes stable module-local codes and provisional
HTTP status candidates. These codes are not registered in the shared HTTP
error map because this package does not add routes. API integration must map
them deliberately and update the canonical HTTP contract at that time.

## Required API Integration Gates

The following work remains outside P1-B:

1. Persist the authority JSON under the existing server state lock and atomic
   replacement path.
2. Pin channel signing public keys and allowed bootstrap origins in server
   configuration.
3. Add restricted bootstrap routes and one-time enrollment redemption.
4. Read the raw request body bytes and raw request target before parsing.
5. Map module errors to stable HTTP responses.
6. Issue, revoke, and rotate relation grants from administrator-controlled
   server state.
7. Issue signed, revisioned directory grants and wire P3 consumers to the
   versioned `enrollment-binding` output.
8. Add end-to-end client, server, and filesystem-root tests.

## First Server HTTP Slice

The current service routes are:

- `POST /api/enrollment/v1/requests`: body is exactly `{ protocol, version,
  kind, requestId, deviceId, channelRevision, publicKey }`, with protocol
  `sfsc-enrollment`, version `1`, and kind `enrollment-request`. The request
  must include `X-SFSC-Enrollment-Request`, a base64url encoded canonical JSON
  proof with `bodySha256` and `signature`. The device key signs canonical JSON
  containing that hash, `method: POST`, the exact raw path, device ID, request
  ID and channel revision. The server verifies the Ed25519 signature before
  storing the pending request.
- `GET /api/admin/enrollment/v1/requests`: administrator-token protected list
  of pending requests. It returns key fingerprints, not device private keys.
- `POST /api/admin/enrollment/v1/requests/{requestId}/issue`: administrator
  token protected; body is exactly `{ rootId }`. Issuance requires an existing
  relation catalog and an active root. `rootAttestation.referenceId` links to
  the SHA-256 digest of that exact active catalog root record; it does not claim
  a separate filesystem check. The route returns a one-time identity enrollment
  code. A private mode-0600 request metadata file stages the exact code before
  the catalog authority transaction so an HTTP retry after a dropped response
  can return the same code; request metadata is not authorization authority.
- `POST /api/enrollment/v1/consume`: body is exactly `{ code }`. The
  `X-SFSC-Authorization` header carries the canonical authorization request as
  base64url JSON. Its signature covers the exact request body bytes and raw
  target. The response includes an Ed25519 signed
  `enrollment-consumption-receipt`; clients must verify the receipt using a
  pinned channel key before accepting the grant.
- Enrollment request, consume, and data-authorization POST paths are served
  only by the separate loopback
  gateway, default port `18082` (override with
  `SFSC_ENROLLMENT_BOOTSTRAP_PORT`). The ordinary management HTTP listener
  does not expose these routes. Restricted VLESS routing is installed only
  after channel-code generation writes the bootstrap overlay, restarts through
  the supervisor, and receives the matching config digest receipt.
- `GET /api/admin/enrollment/v1/trust`: administrator-token protected server
  signing pin for the channel import wrapper. Bootstrap origin configuration
  must be present. The signer is an independent server Ed25519 key persisted
  under `SERVER_DATA_ROOT`; it is not the SFTP host key.
- `POST /api/admin/enrollment/v1/channel-code`: body is exactly `{}`. The
  server writes the current overlay config, hashes the bytes, restarts via the
  configured supervisor, and issues only after the returned digest matches.
- `POST /api/enrollment/v1/data-authorization`: body is exactly
  `{ relationId }`, authenticated with `X-SFSC-Authorization` over the exact
  method, raw path, body bytes, binding, and nonce. The server verifies the
  current unrevoked catalog grant, materializes the protected SFTP key and
  relation, starts the facade, applies the data overlay through a real
  supervisor restart, then returns `{ payload, signature }` signed by the
  independent enrollment Ed25519 key.

`catalog.authority` is the sole durable source for issued/consumed enrollment,
devices, relation grants, and authorization nonces. The separate
`sfsc-enrollment-state.json` contains request metadata only. A non-empty legacy
authority projection that conflicts with catalog authority fails explicitly
and requires controlled migration. The signer is persisted separately in
`SERVER_DATA_ROOT/sfsc-enrollment-signer.json`; it is never reused as the SFTP
host key.

The admin can register an existing directory as the first root. Registration
persists a pending catalog record before marker installation, checks the real
filesystem, and fails closed on unknown markers or overlapping roots. A
consumed enrollment grant alone is not synchronization readiness; the data
authorization request must complete actual relation startup and overlay apply.

## Administrator Revocation

The management listener exposes these administrator-token protected routes:

- `GET /api/admin/enrollment/v1/relations` returns relation/device/directory
  summaries and active/revoked state. It never returns private identity
  material or runtime handles.
- `POST /api/admin/enrollment/v1/revocations` accepts exactly
  `{ operationId, target }`, where target is either
  `{ kind: "relation", relationId }` or `{ kind: "device", deviceId }`.
- `GET /api/admin/enrollment/v1/operations/{operationId}` returns a sanitized
  operation journal snapshot without waiting for an in-flight runtime action.

The authority revoke and journal are committed before service shutdown. A
relation target revokes only its grant. A device target revokes that device and
the fixed set of its relation grants captured when the operation is created.
These enrollment permissions are separate from legacy admin/sing-box user
enable, disable, and delete operations.

Reusing an operation ID with the same target resumes its durable steps. Reusing
it with a different target or authority identity returns HTTP 409
`enrollment_revocation_operation_conflict`. HTTP 200 `complete` is allowed only
after every applicable relation is confirmed stopped or trusted absent and the
updated data overlay has a matching controlled supervisor restart receipt.
Pending or cleanup-required operations return HTTP 503; they never restore
revoked authority. Startup recovery continues pending journals before declaring
readiness, and data authorization remains blocked while recovery is unresolved.

The relation-service catalog v1-to-v2 migration is forward-only for this
release: after v2 is persisted, an older binary that only understands v1 is
not a supported reader/writer. Do not remove the revocation journal or restore
an older authority projection to reverse a revoke. Binary rollback requires a
catalog state known to be compatible with that binary and a separately
validated recovery procedure; no automatic downgrade is defined here.

## Verification

```powershell
node --test tests/enrollment-protocol.test.js
node --test tests/client-enrollment-relation.test.js
```

The test covers code type separation, old profile regression, signed channel
verification, multiple relation bindings, transaction-style state changes,
JSON restart replay blocking, expiry, cross-server/device/public-key splicing,
device and relation conflicts, exact body bytes, unsafe paths, nonce replay,
revocation, bounded timing options, consumed-grant projection, directory
revision and device splicing, empty WebDAV roots, root replacement, epoch
change, endpoint/tuning baseline stability, nested persisted-record schema
validation, device/relation revocation corruption, consumed-enrollment replay
corruption, missing or malformed nonce state, nonce-history preservation, and
bootstrap path-segment boundaries.
