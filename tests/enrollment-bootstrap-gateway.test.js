import assert from "node:assert/strict";
import test from "node:test";

import { createEnrollmentBootstrapGateway } from "../src/service/enrollmentBootstrapGateway.js";

async function post(address, path, body, headers = {}) {
  return fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body
  });
}

test("bootstrap gateway binds loopback, forwards exact request material, and closes", async (t) => {
  const calls = [];
  const service = {
    async createRequest(input) { calls.push({ route: "create", ...input }); return { requestId: "req_test" }; },
    async consume(input) { calls.push({ route: "consume", ...input }); return { grant: { ok: true } }; },
    async issueDataAuthorization(input) { calls.push({ route: "data-authorization", ...input }); return { payload: { relationId: "rel_test" }, signature: "signed" }; }
  };
  const gateway = createEnrollmentBootstrapGateway({ enrollmentService: service, port: 0 });
  const address = await gateway.start();
  t.after(() => gateway.close());

  assert.equal(address.address, "127.0.0.1");
  assert.ok(address.port > 0);
  assert.deepEqual(gateway.address(), address);

  const requestBody = '{"protocol":"sfsc-enrollment","kind":"request"}';
  const requestResponse = await post(address, "/api/enrollment/v1/requests", requestBody,
    { "x-sfsc-enrollment-request": "signed-request" });
  assert.equal(requestResponse.status, 202);
  assert.deepEqual(await requestResponse.json(), { requestId: "req_test" });
  assert.deepEqual(calls[0].input, JSON.parse(requestBody));
  assert.equal(calls[0].bodyBytes.toString("utf8"), requestBody);
  assert.equal(calls[0].rawTarget, "/api/enrollment/v1/requests");
  assert.equal(calls[0].proofHeader, "signed-request");

  const consumeBody = '{"code":"one-time-code"}';
  const consumeResponse = await post(address, "/api/enrollment/v1/consume", consumeBody,
    { "x-sfsc-authorization": "signed-authorization" });
  assert.equal(consumeResponse.status, 200);
  assert.deepEqual(await consumeResponse.json(), { grant: { ok: true } });
  assert.deepEqual(calls[1].body, JSON.parse(consumeBody));
  assert.equal(calls[1].bodyBytes.toString("utf8"), consumeBody);
  assert.equal(calls[1].rawTarget, "/api/enrollment/v1/consume");
  assert.equal(calls[1].authorizationHeader, "signed-authorization");

  const dataBody = '{"relationId":"rel_test"}';
  const dataResponse = await post(address, "/api/enrollment/v1/data-authorization", dataBody,
    { "x-sfsc-authorization": "signed-data-authorization" });
  assert.equal(dataResponse.status, 200);
  assert.deepEqual(await dataResponse.json(), { payload: { relationId: "rel_test" }, signature: "signed" });
  assert.equal(calls[2].route, "data-authorization");
  assert.deepEqual(calls[2].body, { relationId: "rel_test" });
  assert.equal(calls[2].bodyBytes.toString("utf8"), dataBody);
  assert.equal(calls[2].rawTarget, "/api/enrollment/v1/data-authorization");
  assert.equal(calls[2].authorizationHeader, "signed-data-authorization");

  await gateway.close();
  assert.equal(gateway.address(), null);
  await assert.rejects(fetch(`http://127.0.0.1:${address.port}/api/enrollment/v1/consume`));
});

test("gateway rejects all non-exact paths, queries, methods, admin, and health without forwarding", async (t) => {
  const calls = [];
  const service = {
    async createRequest(input) { calls.push(input); return {}; },
    async consume(input) { calls.push(input); return {}; },
    async issueDataAuthorization(input) { calls.push(input); return {}; }
  };
  const gateway = createEnrollmentBootstrapGateway({ enrollmentService: service });
  const address = await gateway.start();
  t.after(() => gateway.close());

  const requests = [
    fetch(`http://127.0.0.1:${address.port}/api/enrollment/v1/requests?x=1`, { method: "POST", body: "{}" }),
    fetch(`http://127.0.0.1:${address.port}/api/enrollment/v1/data-authorization?x=1`, { method: "POST", body: "{}" }),
    fetch(`http://127.0.0.1:${address.port}/api/admin/enrollment/v1/requests`),
    fetch(`http://127.0.0.1:${address.port}/health`),
    fetch(`http://127.0.0.1:${address.port}/api/enrollment/v1/requests`)
  ];
  for (const response of await Promise.all(requests)) {
    assert.equal(response.status, 404);
    assert.equal((await response.json()).errorCode, "not_found");
  }
  assert.equal(calls.length, 0);
});

test("gateway transport probe requires a random challenge and returns an explicit service identity without state writes", async t => {
  let calls = 0;
  const gateway = createEnrollmentBootstrapGateway({
    enrollmentService: {
      async createRequest() { calls += 1; return {}; },
      async consume() { calls += 1; return {}; }
    }
  });
  const address = await gateway.start();
  t.after(() => gateway.close());

  const challenge = "a1".repeat(24);
  const valid = await fetch(`http://127.0.0.1:${address.port}/api/enrollment/v1/transport-probe?challenge=${challenge}`);
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), {
    ok: true,
    service: "sfsc-enrollment-bootstrap",
    challenge
  });
  for (const path of [
    "/api/enrollment/v1/transport-probe",
    "/api/enrollment/v1/transport-probe?challenge=short",
    `/api/enrollment/v1/transport-probe?challenge=${challenge}&extra=1`,
    `/api/enrollment/v1/transport-probe?challenge=${challenge}&challenge=${challenge}`
  ]) {
    const rejected = await fetch(`http://127.0.0.1:${address.port}${path}`);
    assert.equal(rejected.status, 404);
    assert.equal((await rejected.json()).errorCode, "not_found");
  }
  assert.equal(calls, 0);
});

test("gateway reuses JSON errors and enforces a configurable body limit", async (t) => {
  const service = {
    async createRequest() { throw Object.assign(new Error("bad proof"), { code: "enrollment_auth_invalid", status: 401 }); },
    async consume() { return {}; }
  };
  const gateway = createEnrollmentBootstrapGateway({ enrollmentService: service, maxBodyBytes: 4 });
  const address = await gateway.start();
  t.after(() => gateway.close());

  const tooLarge = await post(address, "/api/enrollment/v1/requests", "12345");
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).errorCode, "request_body_too_large");
  const invalid = await post(address, "/api/enrollment/v1/consume", "{");
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).errorCode, "invalid_json");
  const serviceError = await post(address, "/api/enrollment/v1/requests", "{}", { "x-sfsc-enrollment-request": "bad" });
  assert.equal(serviceError.status, 401);
  assert.equal((await serviceError.json()).errorCode, "enrollment_auth_invalid");
});

test("gateway refuses non-loopback bind configuration", () => {
  const service = { createRequest() {}, consume() {} };
  assert.throws(() => createEnrollmentBootstrapGateway({ enrollmentService: service, host: "0.0.0.0" }), /127\.0\.0\.1/);
});
