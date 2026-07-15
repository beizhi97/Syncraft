# SFSC Protocol v1 Baseline

Status: frozen contract baseline.

SFSC Protocol v1 fixes the cross-product contract between the Windows client,
the server control plane, and the server runtime. The canonical field-level
contract is `docs/INTERFACE_CONTRACT.md`; `docs/API_MATRIX.md` fixes the route
and consumer surface; `schemas/protocol-v1-baseline.json` is the auditable
machine-readable baseline.

## Frozen Surface

- JSON HTTP request guards, body limit, error envelope, media type behavior,
  and local browser-origin protection.
- SyncKey creation, redemption, bounded replay recovery, and stable redeem error
  codes.
- Server-issued profile shape, heartbeat HMAC authentication, nonce replay
  protection, device sync summary, runtime diagnostics, and diagnostic
  redaction.
- Protocol versions `claim`, `profile`, `adminState`, `clientStatus`, and
  `heartbeat`, each fixed at `1`.

## Compatibility Policy

An incompatible runtime is never silently accepted. Heartbeats remain allowed
so the operator can diagnose the mismatch. Profile issuance and sync execution
require an explicit compatibility confirmation. A wire-incompatible change
must introduce a later protocol version; it must not reinterpret Protocol v1
fields or stable error codes.

## Release Evidence

A Protocol v1 release is valid only when the candidate source, both Windows
packages, release bundle, and N1 deployment share one source fingerprint and build ID.
The evidence set must include full contract tests, release audit,
strict preflight with zero skips, both package smoke reports, bundle SHA-256,
N1 claim lifecycle smoke, and a final N1 `restartRequired=false` result.

Historical reports are reference material only. After any source or document
change, rebuild the packages and bundle, redeploy N1, and regenerate the
evidence. `pnpm run release:status` is the safe summary of the current gate.

## Change Control And Rollback

Additive internal implementation changes may remain in v1 only when all
frozen requests, responses, errors, and policy outcomes remain compatible.
Any removal, rename, changed meaning, or changed compatibility default starts
a new protocol version and requires a migration plan.

If a candidate deployment fails an N1 smoke or fingerprint-alignment gate,
rollback to the last release bundle whose recorded N1 acceptance is complete;
do not mark a failed candidate as the baseline.
