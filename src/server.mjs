import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isLoopbackHost, normalizeLoopbackHost } from "./config.mjs";
import { clampInteger, publicError } from "./utils.mjs";

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.resolve(SOURCE_ROOT, "..", "public");
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function write(response, status, body, headers = {}, headOnly = false) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Cache-Control": "no-store",
    "Content-Length": payload.byteLength,
    ...headers,
  });
  response.end(headOnly ? undefined : payload);
}

function json(response, status, value, headOnly = false) {
  const body = JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
  write(response, status, body, { "Content-Type": "application/json; charset=utf-8" }, headOnly);
}

function requestHost(request) {
  try {
    return new URL(`http://${request.headers.host || ""}`).hostname;
  } catch {
    return "";
  }
}

function validToken(actual, expected) {
  if (typeof actual !== "string") return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function reportServerError(error) {
  const kind = String(error?.code || error?.name || "Error").slice(0, 80);
  const detail = String(error?.message || "unexpected local collector failure").replaceAll("\n", " ").slice(0, 240);
  console.error(`xedoc: ${kind}: ${detail}`);
}

function routeErrorResponse(error) {
  if (error?.code === "ENOENT") return [404, "Not found"];
  if (error?.code === "EACCES" || error?.code === "EPERM") return [403, "Permission denied"];
  if (error?.code === "EINVAL" || /(?:Invalid path|escapes its scope|not a directory|not browsable)/.test(error?.message || "")) {
    return [400, "Invalid path"];
  }
  return [500, "The local collector encountered an unexpected error."];
}

export function createXedocServer({ inspector, host = "127.0.0.1", token = randomBytes(32).toString("hex") } = {}) {
  if (!inspector) throw new Error("An inspector is required");
  if (!isLoopbackHost(host)) throw new Error("Xedoc only binds to a loopback address");

  const handleRequest = async (request, response) => {
    const headOnly = request.method === "HEAD";
    if (request.method !== "GET" && !headOnly) {
      json(response, 405, { error: "Method not allowed" });
      return;
    }
    if (!isLoopbackHost(requestHost(request))) {
      json(response, 421, { error: "Loopback Host header required" }, headOnly);
      return;
    }

    const base = `http://${request.headers.host}`;
    let url;
    try {
      url = new URL(request.url, base);
    } catch {
      json(response, 400, { error: "Invalid URL" }, headOnly);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (!validToken(request.headers["x-xedoc-token"], token)) {
        json(response, 401, { error: "Dashboard session token required" }, headOnly);
        return;
      }
      const origin = request.headers.origin;
      if (origin && origin !== base) {
        json(response, 403, { error: "Cross-origin requests are not allowed" }, headOnly);
        return;
      }

      try {
        if (url.pathname === "/api/snapshot") {
          const snapshot = await inspector.snapshot({ forceStorage: url.searchParams.get("storage") === "refresh" });
          json(response, 200, snapshot, headOnly);
          return;
        }
        if (url.pathname === "/api/threads") {
          const result = await inspector.threads({
            limit: clampInteger(url.searchParams.get("limit"), 1, 100, 50),
            offset: clampInteger(url.searchParams.get("offset"), 0, 1_000_000, 0),
            query: String(url.searchParams.get("q") || "").slice(0, 200),
            archived: ["all", "current", "archived"].includes(url.searchParams.get("archived"))
              ? url.searchParams.get("archived")
              : "all",
          });
          json(response, 200, result, headOnly);
          return;
        }
        if (url.pathname === "/api/activity") {
          const threadId = String(url.searchParams.get("threadId") || "");
          if (!threadId || threadId.length > 200 || /[\u0000-\u001f]/.test(threadId)) {
            json(response, 400, { error: "A valid threadId is required" }, headOnly);
            return;
          }
          const result = await inspector.activity(threadId);
          json(response, result.available ? 200 : 404, result, headOnly);
          return;
        }
        if (url.pathname === "/api/files") {
          if ((url.searchParams.get("scope") || "codex") !== "codex") {
            json(response, 400, { error: "Unsupported file scope" }, headOnly);
            return;
          }
          const relativePath = String(url.searchParams.get("path") || "");
          if (relativePath.length > 2_048) {
            json(response, 400, { error: "Path is too long" }, headOnly);
            return;
          }
          const result = await inspector.files(relativePath, {
            offset: clampInteger(url.searchParams.get("offset"), 0, 1_000_000, 0),
            limit: clampInteger(url.searchParams.get("limit"), 1, 200, 100),
          });
          json(response, 200, result, headOnly);
          return;
        }
        if (url.pathname === "/api/health") {
          json(response, 200, { ok: true, localOnly: true, now: Date.now() }, headOnly);
          return;
        }
        json(response, 404, { error: "API route not found" }, headOnly);
      } catch (error) {
        const [status, fallback] = routeErrorResponse(error);
        if (status === 500) reportServerError(error);
        json(response, status, { error: publicError(error, fallback) }, headOnly);
      }
      return;
    }

    const staticDefinition = STATIC_FILES.get(url.pathname);
    if (!staticDefinition) {
      write(response, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" }, headOnly);
      return;
    }
    const [filename, contentType] = staticDefinition;
    try {
      const content = await fs.readFile(path.join(PUBLIC_ROOT, filename));
      write(response, 200, content, { "Content-Type": contentType }, headOnly);
    } catch {
      write(response, 500, "Dashboard assets are missing.", { "Content-Type": "text/plain; charset=utf-8" }, headOnly);
    }
  };

  const server = http.createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      reportServerError(error);
      if (!response.headersSent) json(response, 500, { error: "The local request failed unexpectedly." });
      else response.destroy();
    });
  });

  server.requestTimeout = 35_000;
  server.headersTimeout = 40_000;
  return { server, token };
}

export async function listen(server, { host = "127.0.0.1", port = 47831 } = {}) {
  if (!isLoopbackHost(host)) throw new Error("Xedoc only binds to a loopback address");
  const bindHost = normalizeLoopbackHost(host);
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, bindHost);
  });
  const address = server.address();
  return { host: bindHost, port: address.port, url: `http://${bindHost.includes(":") ? `[${bindHost}]` : bindHost}:${address.port}/` };
}
