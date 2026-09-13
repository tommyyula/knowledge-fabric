#!/usr/bin/env node
/**
 * Production static server for the built frontend (dist/).
 *
 * Drop-in replacement for the Vite dev server on :8888 so no ingress change is needed:
 * - serves dist/ from memory with gzip and immutable caching for hashed /assets
 * - SPA fallback to index.html (no-cache)
 * - proxies /api and /healthz to the API server, streaming both ways (SSE-safe),
 *   mirroring the dev-time Vite proxy in vite.config.ts.
 */
import express from "express";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const port = Number(process.env.STATIC_PORT ?? 8888);
const apiTarget = new URL(process.env.STATIC_API_TARGET ?? "http://127.0.0.1:8787");

if (!fs.existsSync(path.join(distDir, "index.html"))) {
  console.error(`[serve-dist] ${distDir}/index.html not found. Run \`pnpm exec vite build\` first.`);
  process.exit(1);
}

const MIME = new Map(Object.entries({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
}));
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".map", ".svg", ".txt"]);

// dist is small and immutable per deploy: cache file bodies (and their gzip) in memory.
const fileCache = new Map();
function loadFile(relativePath) {
  const cached = fileCache.get(relativePath);
  if (cached !== undefined) return cached;
  const filePath = path.join(distDir, relativePath);
  let entry = null;
  if (filePath.startsWith(distDir + path.sep) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const body = fs.readFileSync(filePath);
    entry = {
      body,
      gzip: COMPRESSIBLE.has(ext) && body.length > 1024 ? zlib.gzipSync(body, { level: 9 }) : null,
      type: MIME.get(ext) ?? "application/octet-stream",
    };
  }
  fileCache.set(relativePath, entry);
  return entry;
}

function send(req, res, entry, cacheControl) {
  res.setHeader("Content-Type", entry.type);
  res.setHeader("Cache-Control", cacheControl);
  res.setHeader("Vary", "Accept-Encoding");
  if (entry.gzip && String(req.headers["accept-encoding"] ?? "").includes("gzip")) {
    res.setHeader("Content-Encoding", "gzip");
    return void res.end(entry.gzip);
  }
  res.end(entry.body);
}

function proxy(req, res) {
  const upstream = http.request({
    host: apiTarget.hostname,
    port: apiTarget.port,
    method: req.method,
    path: req.originalUrl,
    headers: { ...req.headers, host: `${apiTarget.hostname}:${apiTarget.port}` },
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Upstream unavailable: ${err.message}` }));
  });
  req.pipe(upstream);
}

const app = express();
app.use("/api", proxy);
app.use("/healthz", proxy);
app.use("/.well-known", proxy);

app.use((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") return void res.status(405).end();
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.originalUrl, "http://localhost").pathname);
  } catch {
    return void res.status(400).end();
  }
  const relative = pathname.replace(/^\/+/, "");
  const entry = relative ? loadFile(relative) : null;
  if (entry) {
    const immutable = relative.startsWith("assets/");
    return void send(req, res, entry, immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600");
  }
  const index = loadFile("index.html");
  if (!index) return void res.status(500).end("index.html missing");
  send(req, res, index, "no-cache");
});

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`[serve-dist] dist=${distDir} port=${port} api-proxy=${apiTarget.origin}`);
});
// Long-lived SSE streams must not be cut by Node's default 5-minute request timeout.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
