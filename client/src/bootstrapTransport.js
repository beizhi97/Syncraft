import net from "node:net";
import tls from "node:tls";

const RESPONSE_LIMIT = 1024 * 1024;

/** Sends one HTTP request through a local sing-box SOCKS5 listener. No direct fallback exists. */
export async function requestThroughSocks(endpoint, path, bodyBytes, headers = {}, proxy = {}) {
  const url = new URL(endpoint);
  if (!new Set(["https:", "http:"]).has(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw transportError("enrollment_endpoint_invalid", "Bootstrap endpoint is invalid");
  }
  if (!path.startsWith("/")) throw transportError("enrollment_endpoint_invalid", "Bootstrap path must be absolute");
  const port = Number(proxy.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw transportError("enrollment_proxy_unavailable", "Bootstrap proxy is unavailable");
  const targetHost = url.hostname.replace(/^\[|\]$/g, "");
  const socket = await socksConnect(targetHost, Number(url.port || (url.protocol === "https:" ? 443 : 80)), proxy.host || "127.0.0.1", port);
  const stream = url.protocol === "https:"
    ? await tlsConnect(socket, targetHost)
    : socket;
  const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  const requestHeaders = {
    Host: host,
    Connection: "close",
    "Content-Length": String(bodyBytes.length),
    "Content-Type": "application/json",
    ...headers
  };
  const head = [`POST ${path} HTTP/1.1`, ...Object.entries(requestHeaders).map(([key, value]) => `${key}: ${value}`), "", ""].join("\r\n");
  const responseBytes = await exchange(stream, Buffer.concat([Buffer.from(head, "ascii"), bodyBytes]));
  return parseResponse(responseBytes);
}

function socksConnect(targetHost, targetPort, proxyHost, proxyPort) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: proxyHost, port: proxyPort });
    const fail = (error) => { socket.destroy(); reject(transportError("enrollment_proxy_unavailable", `Bootstrap proxy connection failed: ${error.message}`)); };
    socket.setTimeout(10000, () => fail(new Error("timeout")));
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.write(Buffer.from([5, 1, 0]));
      readExactly(socket, 2).then((answer) => {
        if (answer[0] !== 5 || answer[1] !== 0) throw new Error("SOCKS5 proxy rejected unauthenticated connection");
        const addressType = net.isIPv4(targetHost) ? 1 : net.isIPv6(targetHost) ? 4 : 3;
        const host = addressType === 1
          ? Buffer.from(targetHost.split(".").map(Number))
          : addressType === 4
            ? ipv6Bytes(targetHost)
            : Buffer.from(targetHost, "utf8");
        if (host.length > 255) throw new Error("Bootstrap host name is too long");
        const port = Buffer.alloc(2); port.writeUInt16BE(targetPort);
        socket.write(Buffer.concat([Buffer.from([5, 1, 0, addressType, ...(addressType === 3 ? [host.length] : [])]), host, port]));
        return readExactly(socket, 4);
      }).then((header) => {
        if (header[0] !== 5 || header[1] !== 0) throw new Error(`SOCKS5 connect failed (${header[1]})`);
        const tailLength = header[3] === 1 ? 4 : header[3] === 4 ? 16 : header[3] === 3 ? 1 : -1;
        if (tailLength < 0) throw new Error("SOCKS5 address type is invalid");
        return readExactly(socket, tailLength).then((prefix) => {
          const length = header[3] === 3 ? prefix[0] : 0;
          return readExactly(socket, length + 2);
        });
      }).then(() => {
        socket.setTimeout(0);
        socket.removeAllListeners("error");
        resolve(socket);
      }).catch(fail);
    });
  });
}

function readExactly(socket, length) {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const onData = (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length >= length) {
        socket.pause();
        socket.unshift(data.subarray(length));
        cleanup(); resolve(data.subarray(0, length));
      }
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onEnd = () => { cleanup(); reject(new Error("SOCKS5 connection closed")); };
    const cleanup = () => { socket.off("data", onData); socket.off("error", onError); socket.off("end", onEnd); };
    socket.on("data", onData); socket.once("error", onError); socket.once("end", onEnd); socket.resume();
  });
}

function tlsConnect(socket, servername) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername });
    secure.once("secureConnect", () => resolve(secure));
    secure.once("error", reject);
    secure.setTimeout(15000, () => secure.destroy(new Error("TLS handshake timed out")));
  });
}

function exchange(socket, requestBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const timer = setTimeout(() => socket.destroy(new Error("Bootstrap response timed out")), 20000);
    socket.on("data", (chunk) => {
      size += chunk.length;
      if (size > RESPONSE_LIMIT) return socket.destroy(new Error("Bootstrap response is too large"));
      chunks.push(chunk);
    });
    socket.once("error", (error) => { clearTimeout(timer); reject(transportError("enrollment_transport_failed", error.message)); });
    socket.once("end", () => {
      clearTimeout(timer);
      const response = Buffer.concat(chunks);
      socket.destroy();
      if (response.length === 0) {
        reject(transportError("enrollment_transport_failed", "Bootstrap connection closed before an HTTP response"));
        return;
      }
      resolve(response);
    });
    socket.write(requestBytes);
    socket.resume();
  });
}

function ipv6Bytes(input) {
  const [leftText, rightText = ""] = input.toLowerCase().split("::");
  const left = leftText ? leftText.split(":") : [];
  const right = rightText ? rightText.split(":") : [];
  const words = input.includes("::")
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : input.split(":");
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) throw new Error("Invalid IPv6 bootstrap host");
  const bytes = Buffer.alloc(16);
  words.forEach((word, index) => bytes.writeUInt16BE(Number.parseInt(word, 16), index * 2));
  return bytes;
}

function parseResponse(bytes) {
  const boundary = bytes.indexOf("\r\n\r\n");
  if (boundary < 0) throw transportError("enrollment_response_invalid", "Bootstrap response headers are invalid");
  const lines = bytes.subarray(0, boundary).toString("latin1").split("\r\n");
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(lines.shift() || "");
  if (!match) throw transportError("enrollment_response_invalid", "Bootstrap response status is invalid");
  const responseHeaders = Object.fromEntries(lines.map((line) => {
    const split = line.indexOf(":");
    return split < 0 ? ["", ""] : [line.slice(0, split).trim().toLowerCase(), line.slice(split + 1).trim()];
  }).filter(([key]) => key));
  let body = bytes.subarray(boundary + 4);
  if (/chunked/i.test(responseHeaders["transfer-encoding"] || "")) body = decodeChunks(body);
  let parsed = null;
  try { parsed = JSON.parse(body.toString("utf8")); } catch {
    throw transportError("enrollment_response_invalid", "Bootstrap response was not valid JSON");
  }
  return { status: Number(match[1]), body: parsed };
}

function decodeChunks(input) {
  const chunks = []; let offset = 0;
  while (offset < input.length) {
    const end = input.indexOf("\r\n", offset);
    if (end < 0) throw transportError("enrollment_response_invalid", "Chunked response is invalid");
    const length = Number.parseInt(input.subarray(offset, end).toString("ascii").split(";")[0], 16);
    if (!Number.isSafeInteger(length) || length < 0) throw transportError("enrollment_response_invalid", "Chunked response is invalid");
    offset = end + 2;
    if (length === 0) break;
    if (offset + length + 2 > input.length) throw transportError("enrollment_response_invalid", "Chunked response is incomplete");
    chunks.push(input.subarray(offset, offset + length)); offset += length + 2;
  }
  return Buffer.concat(chunks);
}

function transportError(code, message) { const error = new Error(message); error.code = code; return error; }
