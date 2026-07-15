import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const port = Number(process.env.PORT || 5199);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const requested = url.pathname === "/" ? "/prototypes/ui-design/index.html" : url.pathname;
  const file = normalize(join(root, decodeURIComponent(requested)));

  if (!file.startsWith(root)) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("invalid path");
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": contentType(file),
      "cache-control": "no-store"
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`SFSC UI prototype: http://127.0.0.1:${port}/prototypes/ui-design/index.html?surface=client&variant=A`);
});

function contentType(file) {
  const ext = extname(file);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

