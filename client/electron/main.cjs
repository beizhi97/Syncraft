const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const port = process.env.SFSC_CLIENT_PORT || "5188";
const configuredDataRoot = process.env.SFSC_CLIENT_DATA_ROOT || process.env.SFSC_DATA_ROOT;
const logRoot = path.join(configuredDataRoot || path.join(path.dirname(process.execPath), "data"), "logs");
const logFile = path.join(logRoot, "electron-main.log");
const trayIconPng = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAMNSURBVFhH1VdBaBNBFO3RY4/e6qG7BUHw4EE86c2bPYkHIc1uhSAI6sVAD/bSiwhFFIIXKQjqQSmKIOihIELopT0IKmipKJJsZm0ak5o2SR15k51l5s/sphviwQePNrsz//958+dNMjb2v2JytnpyymenVdIxI8XRXHB40qsWHI+9cn3GE+mxspsPilO5yhEaYyhM5Orjjs/mXZ+1jWQDGZZQOI15YEBW16/VzcCZ2Ha82gUaeyAcL5gZbtV2QkWaIxFRciMIeOr6T377aYvffb7DX67u8tVPHUF8vnb/Fz87t2XMUYpYpLkM9GU3V37mxhZ/9q7Ndzt/+CCsb3T5+YW6UQCIRqY5Y6BhbHuOFQ+DN2t7/NKdhlDo5sOmjNd2ZoPjNLcAJKLJIS2FKvnFW9v88r2G+Pz2/R5v7OgKdXv9v1BOxnT8cJnmjlavS09XjsRJ0kqiRx6ttLV5AApTxxkqwDxoMLa9HwfA6o4VQiNhEosPmloBX4MeGROW9ALgYCQIuhzAXmZJLrn2pRMX8J3ta+8cn1Xi5HA7OlkS3U+fUWJbsD1QSfYGnr0o9xcAbLf0AsB4G3Cx0JdZ+OFbN06UBvSHOi92SNerTtOgWWg7KTbQAtx87WpfAa9aoEHBuaWm6N7PP3qatHQcCAf0F/vHEb0DM1JBTwEY2zOkoC/BTjfZ9TYqPdVcDJ6br2uesPT6tzEGJ08UENmv9vLElVBLaINqLiphTGpy/G/IL3ogmBEFRCakvYTUElitTVocT3UOVo3ToALJ8ZzGB9H80UEUNrypvoS8EnA2OpkSilEbTksO153IbR5SC9DuAeyZxMKTFp1sEBKrQNE22SWN+wCmoA6AqUigu2kAG3ExYavSvhPE9KrTWgGiCD9clgOw7xJpKxmKHlunuQVUFaS50EYbCW2rl7DdiqMluQVtcH322Jw4AnqsrHV+EjBo5EWI5PVxmisV0Q8SM1hmhqUDrdwGYdNebcUMOpiOX/uY2nBZEF3Z2BbjKzslfj/GPv8vIFTJB0VskUo8zyr1X1JHAGLD4W8bAAAAAElFTkSuQmCC";
let mainWindow = null;
let tray = null;
let clientServerStarted = false;
let clientShutdownRequest = null;
let quitAfterCleanup = false;
let isQuitting = false;

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

function log(message) {
  try {
    fs.mkdirSync(logRoot, { recursive: true });
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

function resolveLayout() {
  if (app.isPackaged) {
    const portableRoot = path.dirname(process.execPath);
    return {
      portableRoot,
      appRoot: path.join(portableRoot, "resources", "app", "client")
    };
  }

  const projectRoot = path.resolve(__dirname, "..", "..");
  return {
    portableRoot: path.join(projectRoot, "client"),
    appRoot: path.join(projectRoot, "client")
  };
}

async function startClientServer(layout) {
  process.env.SFSC_PORTABLE_ROOT = layout.portableRoot;
  process.env.SFSC_APP_ROOT = layout.appRoot;
  process.env.SFSC_CLIENT_PORT = port;
  process.env.SFSC_OPEN_BROWSER = "0";
  const entry = path.join(layout.appRoot, "src", "clientServer.js");
  await import(pathToFileURL(entry).href);
  log(`client server started from ${entry}`);
}

function shouldRequestClientShutdown() {
  return clientServerStarted && process.env.SFSC_PACKAGE_SMOKE !== "1";
}

function requestClientShutdown() {
  if (!shouldRequestClientShutdown()) {
    return Promise.resolve();
  }
  if (clientShutdownRequest) {
    return clientShutdownRequest;
  }

  clientShutdownRequest = new Promise((resolve, reject) => {
    const body = "{}";
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/api/client/shutdown",
      method: "POST",
      timeout: 3500,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      }
    }, (res) => {
      res.resume();
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
          return;
        }
        reject(new Error(`Client shutdown returned HTTP ${res.statusCode}`));
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("Client shutdown timed out"));
    });
    req.on("error", reject);
    req.end(body);
  });

  return clientShutdownRequest;
}

function shutdownClientAndQuit() {
  if (quitAfterCleanup) {
    return;
  }
  quitAfterCleanup = true;
  requestClientShutdown().then(() => {
    const fallbackExit = setTimeout(() => {
      app.exit(process.exitCode || 0);
    }, 6500);
    fallbackExit.unref?.();
  }).catch((error) => {
    log(`client shutdown failed ${error && error.stack ? error.stack : error}`);
    app.exit(process.exitCode || 0);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "Syncraft",
    backgroundColor: "#f4f5f7",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs")
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.on("close", (event) => {
    if (isQuitting || quitAfterCleanup || process.env.SFSC_PACKAGE_SMOKE === "1") {
      return;
    }
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) {
    return;
  }
  const icon = nativeImage.createFromBuffer(Buffer.from(trayIconPng, "base64")).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("Syncraft");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开主界面", click: showMainWindow },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
  tray.on("double-click", showMainWindow);
}

function createStartupErrorWindow(error) {
  const normalized = normalizeStartupError(error);
  mainWindow = new BrowserWindow({
    width: 760,
    height: 520,
    minWidth: 640,
    minHeight: 460,
    title: "Syncraft 启动失败",
    backgroundColor: "#f4f5f7",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderStartupErrorHtml(normalized))}`);
}

function normalizeStartupError(error) {
  const code = error?.code || error?.errorCode || "client_startup_failed";
  const message = error?.message || String(error || "Client startup failed.");
  const isPortInUse = code === "client_port_in_use" || /port .*in use|EADDRINUSE|already in use/i.test(message);
  return {
    code: isPortInUse ? "client_port_in_use" : code,
    title: isPortInUse ? "本地服务端口被占用" : "客户端本地服务启动失败",
    message,
    port,
    logFile
  };
}

function renderStartupErrorHtml(error) {
  const detail = [
    `错误码：${error.code}`,
    `端口：${error.port}`,
    `日志：${error.logFile}`,
    "",
    error.message
  ].join("\n");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SFSC 启动失败</title>
  <style>
    :root{font-family:"Segoe UI","Microsoft YaHei",Arial,sans-serif;color:#20242b;background:#f4f5f7}
    body{margin:0;min-height:100vh;display:grid;place-items:center}
    main{width:min(620px,calc(100vw - 48px));background:#fff;border:1px solid #d9dde5;border-radius:8px;padding:24px;box-shadow:0 18px 42px rgba(22,29,42,.12)}
    h1{margin:0 0 8px;font-size:20px;letter-spacing:0}
    p{margin:0 0 16px;color:#5a6372;line-height:1.6;font-size:13px}
    dl{display:grid;grid-template-columns:72px 1fr;gap:8px 12px;margin:16px 0;font-size:13px}
    dt{color:#6b7280}
    dd{margin:0;word-break:break-all}
    pre{white-space:pre-wrap;word-break:break-word;background:#f7f8fa;border:1px solid #e4e7ee;border-radius:6px;padding:12px;max-height:150px;overflow:auto;font-size:12px}
    .actions{display:flex;gap:10px;justify-content:flex-end;margin-top:18px}
    button{border:1px solid #b8c0cc;border-radius:6px;background:#fff;padding:8px 16px;font-size:13px;color:#20242b}
    button.primary{background:#2457d6;border-color:#2457d6;color:#fff}
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(error.title)}</h1>
    <p>客户端窗口已经打开，但本地服务没有启动成功。请按下面信息处理后重新启动。</p>
    <dl>
      <dt>错误码</dt><dd>${escapeHtml(error.code)}</dd>
      <dt>端口</dt><dd>${escapeHtml(error.port)}</dd>
      <dt>日志</dt><dd>${escapeHtml(error.logFile)}</dd>
    </dl>
    <pre>${escapeHtml(detail)}</pre>
    <div class="actions">
      <button onclick="navigator.clipboard && navigator.clipboard.writeText(document.querySelector('pre').textContent)">复制信息</button>
      <button class="primary" onclick="window.close()">关闭</button>
    </div>
  </main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

app.on("second-instance", () => {
  showMainWindow();
});

ipcMain.handle("sfsc:pick-folder", async (event) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(parent || undefined, {
    title: "选择本地同步文件夹",
    properties: ["openDirectory", "createDirectory"]
  });
  return {
    canceled: result.canceled,
    path: result.filePaths[0] || ""
  };
});

app.whenReady().then(async () => {
  const layout = resolveLayout();
  try {
    await startClientServer(layout);
    clientServerStarted = true;
  } catch (error) {
    log(`fatal ${error && error.stack ? error.stack : error}`);
    if (process.env.SFSC_PACKAGE_SMOKE === "1") {
      process.exitCode = 1;
      app.quit();
      return;
    }
    createStartupErrorWindow(error);
    return;
  }
  if (process.env.SFSC_PACKAGE_SMOKE === "1") return;
  createTray();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch((error) => {
  log(`fatal ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
  if (app.isReady() && process.env.SFSC_PACKAGE_SMOKE !== "1") {
    createStartupErrorWindow(error);
  } else {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (quitAfterCleanup || !shouldRequestClientShutdown()) {
    return;
  }
  isQuitting = true;
  event.preventDefault();
  shutdownClientAndQuit();
});

app.on("window-all-closed", () => {
  if (tray && !isQuitting) {
    return;
  }
  shutdownClientAndQuit();
});
