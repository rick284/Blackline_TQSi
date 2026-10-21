/**
 * Serving the built web app from the same server as the API, so a hosted Blackline is one thing to run and the browser never makes a cross-site call.
 * The app routes with the part of the address after `#`, so the server only ever sees `/`, the built files and `/api/...`. Hashed files under
 * `/assets/` never change and are cached for a year; everything else (the page, the service worker) is checked every time.
 */
import { createReadStream, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
};

/** The file a request path names inside `root`, or null when it is outside it, is a folder or isn't there. */
export function fileFor(root: string, urlPath: string): string | null {
  let rel: string;
  try { rel = decodeURIComponent(urlPath.split("?")[0]!); } catch { return null; }
  if (rel.includes("\0")) return null;
  const file = resolve(root, "." + rel);
  if (file !== root && !file.startsWith(root + sep)) return null;
  try { return statSync(file).isFile() ? file : null; } catch { return null; }
}

export function webHandler(webDir: string) {
  const root = resolve(webDir);
  const index = resolve(root, "index.html");
  return (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.raw.url ?? "/";
    let file = fileFor(root, url === "/" ? "/index.html" : url);
    // a path that looks like a file but isn't there is a 404; any other path is the app (so a refreshed address still opens it)
    if (!file) {
      if (extname(url.split("?")[0]!) !== "") return reply.status(404).send({ error: { code: "not_found", message: "Not found." } });
      file = index;
    }
    const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    const immutable = file.startsWith(resolve(root, "assets") + sep);
    reply.header("content-type", type).header("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
    return reply.send(req.method === "HEAD" ? "" : createReadStream(file));
  };
}

/**
 * Headers that make a browser treat the app more carefully: no framing, no guessing of types, only its own scripts, and (when the request came in
 * over HTTPS) a promise to keep using HTTPS. The page needs inline styles (the grid library writes them) but no inline scripts.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
};
