import http from "node:http";
import { corsHeaders, sendJson, sendJsonError } from "./http.js";
import { proxyChatCompletion } from "./upstream.js";

// Best-effort per-IP buckets. Disabled unless RATE_LIMIT_PER_MIN is set —
// see the note in config.js about the batch consumer sharing one IP.
const WINDOW_MS = 60_000;

function makeRateLimiter(limit) {
  if (!limit || limit <= 0) return () => true;
  const buckets = new Map();

  return (key) => {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start > WINDOW_MS) {
      bucket = { count: 0, start: now };
    }
    bucket.count += 1;
    buckets.set(key, bucket);

    // Cheap sweep so the map can't grow without bound in a long-lived process.
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) {
        if (now - v.start > WINDOW_MS) buckets.delete(k);
      }
    }
    return bucket.count <= limit;
  };
}

// On Toolforge the service sits behind the front proxy, so the caller's
// address is the leftmost X-Forwarded-For entry.
function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function liftwingHeaders(settings) {
  const headers = {
    "Content-Type": "application/json",
    // Wikimedia's gateway enforces a User-Agent policy; send both the
    // standard header and the Api-User-Agent variant it documents.
    "User-Agent": settings.userAgent,
    "Api-User-Agent": settings.userAgent,
  };
  // Approved-bot JWT. The gateway parses any Authorization header as a JWT
  // and 401s a malformed one, so only attach a token that has the
  // Header.Payload.Signature shape — a blank or placeholder value then falls
  // back to anonymous access instead of 401ing every request.
  if (settings.token && settings.token.split(".").length === 3) {
    headers["Authorization"] = `Bearer ${settings.token}`;
  }
  return headers;
}

function hfHeaders(settings) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${settings.token}`,
  };
  if (settings.billTo) headers["X-HF-Bill-To"] = settings.billTo;
  return headers;
}

export function createServer(config) {
  const withinRateLimit = makeRateLimiter(config.rateLimitPerMinute);

  return http.createServer(async (req, res) => {
    const cors = corsHeaders(req, config);
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      return sendJsonError(res, 400, "Invalid request URL", cors);
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      return res.end();
    }

    // Toolforge's healthcheck hits the service root; keep both cheap and
    // dependency-free so a failing upstream never marks the pod unhealthy.
    if (req.method === "GET" && (pathname === "/" || pathname === "/healthz")) {
      return sendJson(res, 200, { ok: true, service: "llm-router" }, cors);
    }

    const route =
      pathname === config.liftwing.route
        ? "liftwing"
        : pathname === config.hf.route
          ? "hf"
          : null;

    if (!route) {
      return sendJsonError(res, 404, `Not found: ${pathname}`, cors);
    }
    if (req.method !== "POST") {
      return sendJsonError(res, 405, "Method not allowed", {
        ...cors,
        Allow: "POST, OPTIONS",
      });
    }
    if (!withinRateLimit(clientIp(req))) {
      return sendJsonError(res, 429, "Too many requests", cors);
    }

    const settings = config[route];
    try {
      await proxyChatCompletion({
        req,
        res,
        cors,
        settings,
        buildUrl:
          route === "liftwing"
            ? (body) =>
                // Lift Wing routes by model name in the path as well as in
                // the body.
                `${settings.base}/${encodeURIComponent(body.model)}/openai/v1/chat/completions`
            : () => settings.base,
        buildHeaders:
          route === "liftwing" ? () => liftwingHeaders(settings) : () => hfHeaders(settings),
      });
    } catch (err) {
      console.error(`[${route}] unhandled error:`, err);
      if (!res.headersSent) {
        sendJsonError(res, 500, "Internal proxy error", cors);
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });
}
