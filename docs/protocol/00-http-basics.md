# HTTP Basics

This document defines the shared JSON transport boundary for the public server API and the client-local API. Endpoint-specific request and response fields remain in `docs/INTERFACE_CONTRACT.md` and `docs/API_MATRIX.md`.

The machine-readable mirror is `docs/protocol/schemas/http-basics.json`.

## JSON Write Requests

Every `POST` request with a body must use `Content-Type: application/json`. Media type parameters such as `charset=utf-8` are allowed. A body sent without that media type returns `415 unsupported_media_type`.

An empty `POST` body may omit `Content-Type` only when transport framing does not declare a body: there is no positive `Content-Length` and no `Transfer-Encoding`. A zero-byte chunked request still requires `application/json`. An accepted empty body is normalized to `{}` before the endpoint request schema runs.

Both runtimes cap JSON request bodies at `2097152` bytes (2 MiB). A larger body returns `413 request_body_too_large`. Invalid JSON returns `400 invalid_json`.

## Guard Order

The server applies guards in this order:

1. JSON media type for every `POST`.
2. Admin authorization for protected paths.
3. Route request schema and business handling.
4. `404 not_found` for unmatched requests.

Therefore a protected or unmatched `POST` carrying a non-JSON body returns `unsupported_media_type` before authentication or route-not-found handling.

The client-local runtime applies guards in this order:

1. Browser-origin protection for every `POST`.
2. JSON media type.
3. Route request schema and business handling.
4. `404 not_found` for unmatched requests.

Therefore a cross-site request is rejected with `local_write_forbidden` before media-type or endpoint validation.

## Local Browser-Origin Boundary

The client-local API listens over HTTP on loopback. Browser `POST` requests are rejected with `403 local_write_forbidden` when `Sec-Fetch-Site` is `cross-site`, the `Origin` is malformed, its scheme is not `http:`, the origin host is not `localhost`, `127.0.0.1`, or `::1`, or the origin port differs from the local API port.

A missing `Origin` is accepted for local non-browser callers and packaged tooling. This is not remote authorization; the listener remains loopback-only.

## JSON Responses

JSON responses use `Content-Type: application/json; charset=utf-8` and `Cache-Control: no-store`.

The common error envelope has exact keys:

`error`, `errorCode`, `message`, `ok`.

`ok` is `false`; `errorCode` is the stable code; `error` is its legacy alias and must equal `errorCode`; `message` is a non-empty diagnostic string.

Unknown exceptions use public fallback messages only: `Internal server error` for `server_error` and `Client request failed` for `client_error`. Their raw exception messages must not cross the HTTP boundary.

Operation endpoints should return failures as non-2xx responses. A top-level HTTP 2xx `{ ok: false }` is valid only for explicitly documented status-style or partial-success endpoints.
