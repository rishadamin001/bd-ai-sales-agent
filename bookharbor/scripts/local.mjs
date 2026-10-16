import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import worker from "../src/worker.mjs";
import { database } from "./db.mjs";
await mkdir("work", { recursive: true });
const db = database("work/demo.sqlite");
db.exec(await readFile("schema.sql", "utf8"));
const env = {
  DB: db,
  ADMIN_KEY: crypto.randomUUID() + crypto.randomUUID(),
  LOCAL_DEMO: "true",
  AI_ENABLED: "false",
  FB_PAGE_ID: "61595323019908",
  ASSETS: {
    async fetch(req) {
      let path = new URL(req.url).pathname;
      if (path === "/") path = "/index.html";
      const target = resolve("public", "." + path);
      if (
        !target.startsWith(resolve("public") + "/") &&
        !target.startsWith(resolve("public") + "\\")
      )
        return new Response("Forbidden", { status: 403 });
      try {
        const data = await readFile(target);
        return new Response(data, {
          headers: {
            "Content-Type":
              {
                ".html": "text/html; charset=utf-8",
                ".css": "text/css",
                ".js": "text/javascript",
                ".svg": "image/svg+xml",
              }[extname(target)] || "application/octet-stream",
          },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  },
};
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = new Request("http://127.0.0.1:8787" + req.url, {
    method: req.method,
    headers: req.headers,
    ...(!["GET", "HEAD"].includes(req.method)
      ? { body: Buffer.concat(chunks) }
      : {}),
  });
  const response = await worker.fetch(request, env, {
    waitUntil: (p) => p.catch(() => {}),
  });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
server.listen(8787, "127.0.0.1", () =>
  console.log(
    "BookHarbor local demo: http://127.0.0.1:8787 — AI offline; fixed-rule fallback active.",
  ),
);
