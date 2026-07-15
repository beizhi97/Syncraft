const { dirname, join } = require("node:path");
const http = require("node:http");
const { spawn, execFile } = require("node:child_process");

const root = dirname(process.execPath);
const nodeExe = join(root, "runtime", "node.exe");
const appEntry = join(root, "app", "client", "src", "clientServer.js");
const port = process.env.SFSC_CLIENT_PORT || "5188";
const url = `http://127.0.0.1:${port}/`;

main().catch(() => process.exit(1));

async function main() {
  if (!(await isClientReady())) {
    const child = spawn(nodeExe, [appEntry], {
      cwd: root,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        SFSC_PORTABLE_ROOT: root,
        SFSC_CLIENT_PORT: port,
        SFSC_OPEN_BROWSER: "0"
      }
    });
    child.unref();
    await waitForClient(12000);
  }

  if (process.env.SFSC_OPEN_BROWSER !== "0") {
    execFile("cmd", ["/c", "start", "", url], { windowsHide: true }, () => {});
  }
}

function waitForClient(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await isClientReady()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`Client startup timed out: ${url}`));
      setTimeout(tick, 300);
    };
    tick();
  });
}

function isClientReady() {
  return new Promise((resolve) => {
    const req = http.get(`${url}api/health`, { timeout: 800 }, (res) => {
      let body = "";
      let settled = false;
      const settle = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 32768) {
          req.destroy();
          settle(false);
        }
      });
      res.on("end", () => {
        settle(res.statusCode === 200 && isSfscClientHealth(body));
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function isSfscClientHealth(body) {
  try {
    const payload = JSON.parse(body);
    return payload?.ok === true
      && payload?.mode === "client-exe-runtime"
      && payload?.diagnostics?.role === "client";
  } catch {
    return false;
  }
}
