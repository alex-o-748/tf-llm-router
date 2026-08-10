// Small helpers shared by the route handlers: CORS, error shaping, and a
// size-capped request body reader.

export function corsHeaders(req, config) {
  const origin = req.headers.origin || "";
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // Echo whatever the preflight asked for, defaulting to Content-Type,
    // which is the only header the userscript actually sends.
    "Access-Control-Allow-Headers":
      req.headers["access-control-request-headers"] || "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };

  // Absent or non-matching Origin simply gets no Allow-Origin header. The
  // browser client then fails closed; the server-to-server batch job neither
  // sends an Origin nor cares about the response headers.
  if (config.allowedOriginPattern.test(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

// The client parses `{ error: { message } }` and falls back to raw text, so
// every error path we generate ourselves uses this shape.
export function sendJsonError(res, status, message, headers = {}) {
  sendJson(res, status, { error: { message } }, headers);
}

export function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    ...headers,
    "Content-Type": "application/json",
    "Content-Length": body.length,
  });
  res.end(body);
}

export class BodyTooLarge extends Error {}
export class BodyNotJson extends Error {}

// Reads the request body, aborting as soon as the cap is exceeded rather than
// buffering an oversized payload in full just to reject it.
export function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        // Stop reading, but leave the socket alive: destroying it here would
        // reach the client as a connection reset instead of the 413 that
        // tells them what went wrong. The caller closes the connection once
        // the error response has been flushed.
        req.pause();
        fail(new BodyTooLarge("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", fail);
  });
}

export async function readJsonBody(req, maxBytes) {
  const raw = await readBody(req, maxBytes);
  try {
    return JSON.parse(raw);
  } catch {
    throw new BodyNotJson("Invalid JSON");
  }
}
