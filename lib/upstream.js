import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
// undici's fetch rather than the global one: only this entry point honours a
// per-request `dispatcher`, which is how an upstream is routed through
// Toolforge's web proxy. It is the same implementation Node ships internally.
import { fetch, ProxyAgent } from "undici";
import { normalizeCompletion } from "./think.js";
import {
  BodyNotJson,
  BodyTooLarge,
  readJsonBody,
  sendJson,
  sendJsonError,
} from "./http.js";

// A ProxyAgent is only needed when an upstream is configured to go through
// Toolforge's web proxy, so agents are built lazily and cached per URL.
const proxyAgents = new Map();

function dispatcherFor(proxyUrl) {
  if (!proxyUrl) return undefined;
  if (!proxyAgents.has(proxyUrl)) {
    proxyAgents.set(proxyUrl, new ProxyAgent(proxyUrl));
  }
  return proxyAgents.get(proxyUrl);
}

const MAX_ERROR_DETAIL = 500;

// Turns a non-JSON upstream error body into the `{ error: { message } }`
// shape the client expects, and leaves an already-JSON body alone — upstream
// OpenAI-compatible errors are emitted in that shape already.
function shapeErrorBody(text, status) {
  const trimmed = (text || "").trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Not JSON — an HTML error page from the gateway, most likely.
    }
  }
  return {
    error: {
      message: trimmed
        ? trimmed.slice(0, MAX_ERROR_DETAIL)
        : `Upstream returned ${status}`,
    },
  };
}

/**
 * Shared proxy pipeline for both routes.
 *
 * @param {object} opts
 * @param {import('node:http').IncomingMessage} opts.req
 * @param {import('node:http').ServerResponse} opts.res
 * @param {object} opts.cors           CORS headers to attach to every response
 * @param {object} opts.settings       Per-route slice of the config
 * @param {(body: object) => string} opts.buildUrl
 * @param {(body: object) => object} opts.buildHeaders
 */
export async function proxyChatCompletion({
  req,
  res,
  cors,
  settings,
  buildUrl,
  buildHeaders,
}) {
  let body;
  try {
    body = await readJsonBody(req, settings.maxBodyBytes);
  } catch (err) {
    if (err instanceof BodyTooLarge) {
      // The rest of the upload is never read, so the connection can't be
      // reused — say so, and tear it down once the 413 is on the wire.
      res.on("finish", () => req.destroy());
      return sendJsonError(res, 413, "Request body too large", {
        ...cors,
        Connection: "close",
      });
    }
    if (err instanceof BodyNotJson) {
      return sendJsonError(res, 400, "Invalid JSON", cors);
    }
    return sendJsonError(res, 400, "Could not read request body", cors);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return sendJsonError(res, 400, "Request body must be a JSON object", cors);
  }

  const modelId = typeof body.model === "string" ? body.model : "";
  // HuggingFace model ids may carry a `:provider` suffix that selects the
  // inference provider, so the allowlist is checked against the base id there.
  // Lift Wing has no such convention and puts the id straight into the URL
  // path, so a suffix must not be accepted — it would build a path that 404s.
  const baseModel = settings.allowProviderSuffix ? modelId.split(":")[0] : modelId;
  if (!settings.allowedModels.has(baseModel)) {
    return sendJsonError(
      res,
      400,
      `Model not allowed: ${modelId || "(missing)"}`,
      cors,
    );
  }

  // Reasoning models spend output tokens on chain-of-thought before producing
  // any answer, so the ceiling is deliberately generous — a low cap truncates
  // mid-reasoning and yields an empty completion.
  if (typeof body.max_tokens === "number" && body.max_tokens > settings.maxTokens) {
    body.max_tokens = settings.maxTokens;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  // If the caller hangs up, stop paying for the upstream generation.
  const onClientClose = () => controller.abort();
  res.on("close", onClientClose);

  let upstream;
  try {
    upstream = await fetch(buildUrl(body), {
      method: "POST",
      headers: buildHeaders(body),
      body: JSON.stringify(body),
      signal: controller.signal,
      dispatcher: dispatcherFor(settings.proxyUrl),
    });
  } catch (err) {
    clearTimeout(timer);
    res.off("close", onClientClose);
    if (res.writableEnded || !res.writable) return undefined;
    if (err.name === "AbortError") {
      return sendJsonError(res, 504, "Upstream timeout", cors);
    }
    return sendJsonError(res, 502, `Upstream network error: ${err.message}`, cors);
  }

  try {
    // 401/403 means *our* credential was rejected, not the caller's — they
    // send no Authorization at all. Reporting it verbatim would invite a
    // pointless retry (and, in a browser, an auth prompt), so this is the one
    // status deliberately not passed through. The upstream detail is kept in
    // the message because it is usually a User-Agent policy block or an
    // expired token, which a bare "auth failed" would hide.
    if (upstream.status === 401 || upstream.status === 403) {
      const detail = (await upstream.text()).slice(0, 300);
      return sendJsonError(
        res,
        502,
        `Upstream auth failed (${upstream.status}): ${detail}`,
        cors,
      );
    }

    // Every other status is preserved: the client uses it to decide whether a
    // retry is worthwhile, and collapsing 429/503 (retry) together with 400
    // (never retry) would destroy that signal.
    if (!upstream.ok) {
      const headers = { ...cors };
      const retryAfter = upstream.headers.get("retry-after");
      if (retryAfter) headers["retry-after"] = retryAfter;
      const text = await upstream.text();
      return sendJson(res, upstream.status, shapeErrorBody(text, upstream.status), headers);
    }

    const contentType = upstream.headers.get("content-type") || "";
    const isStream = body.stream === true || contentType.includes("text/event-stream");

    // Streaming passes through untouched — an SSE stream can't be cleanly
    // rewritten mid-flight, so the client strips <think> tags itself.
    if (isStream) {
      res.writeHead(upstream.status, {
        ...cors,
        "Content-Type": contentType || "text/event-stream",
        "Cache-Control": "no-cache",
      });
      // Headers are through, so the request timeout has done its job — a long
      // generation must not be cut off mid-stream by it. The client-disconnect
      // abort stays armed for the whole stream.
      clearTimeout(timer);
      await pipeline(Readable.fromWeb(upstream.body), res);
      return undefined;
    }

    const text = await upstream.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      // A 2xx that isn't JSON: hand it back untouched rather than corrupt it.
      res.writeHead(upstream.status, {
        ...cors,
        "Content-Type": contentType || "text/plain",
      });
      res.end(text);
      return undefined;
    }

    return sendJson(res, upstream.status, normalizeCompletion(payload), cors);
  } catch (err) {
    if (res.writableEnded || !res.writable) return undefined;
    if (err.name === "AbortError") {
      return sendJsonError(res, 504, "Upstream timeout", cors);
    }
    return sendJsonError(res, 502, `Upstream read error: ${err.message}`, cors);
  } finally {
    clearTimeout(timer);
    res.off("close", onClientClose);
  }
}
