// All tunables in one place. Everything is overridable through Toolforge
// envvars (`toolforge envvars create <NAME>`) so that operational changes —
// a new model, a different Lift Wing base URL, an outbound proxy — don't
// require a rebuild.

function parseList(value, fallback) {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseInteger(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Wikimedia's API gateway enforces a User-Agent policy: requests without a
// descriptive UA that identifies the operator are blocked.
const DEFAULT_USER_AGENT =
  "llm-router (https://github.com/alex-o-748/tf-llm-router; Wikipedia citation verification)";

export function loadConfig(env = process.env) {
  return {
    port: parseInteger(env.PORT, 8000),

    // The userscript runs on Wikipedia/Wikimedia wikis. Requests with no
    // Origin at all (the Toolforge batch job) are not blocked — they simply
    // get no CORS headers back, which a server-to-server client ignores.
    allowedOriginPattern: /^https:\/\/[a-z0-9-]+\.(wikipedia|wikimedia)\.org$/,

    // 0 disables the limiter. Off by default: the second consumer is a batch
    // job calling from a single Toolforge IP, and a browser-tuned per-IP cap
    // would throttle it immediately. Turn it on only if abuse shows up.
    rateLimitPerMinute: parseInteger(env.RATE_LIMIT_PER_MIN, 0),

    liftwing: {
      route: "/liftwing",
      // Lift Wing routes by model name in the URL path as well as the body.
      // Overridable so that if an internal path ever opens up to Toolforge,
      // it becomes an envvar change rather than a code change.
      base: env.LIFTWING_BASE ||
        "https://api.wikimedia.org/service/lw/inference/v1/models",
      allowedModels: new Set(
        parseList(env.LIFTWING_ALLOWED_MODELS, ["llm-qwen3-14b", "llm-qwen36-27b"]),
      ),
      allowProviderSuffix: false,
      maxTokens: parseInteger(env.LIFTWING_MAX_TOKENS, 16384),
      maxBodyBytes: parseInteger(env.LIFTWING_MAX_BODY_BYTES, 200 * 1024),
      // Higher than /hf: Lift Wing generates at roughly 35 tok/s, so a long
      // reasoning completion legitimately takes minutes.
      timeoutMs: parseInteger(env.LIFTWING_TIMEOUT_MS, 120_000),
      userAgent: env.LIFTWING_USER_AGENT || DEFAULT_USER_AGENT,
      token: env.LIFTWING_TOKEN || "",
      proxyUrl: env.LIFTWING_PROXY_URL || "",
    },

    hf: {
      route: "/hf",
      base: env.HF_BASE || "https://router.huggingface.co/v1/chat/completions",
      allowedModels: new Set(
        parseList(env.HF_ALLOWED_MODELS, [
          "openai/gpt-oss-20b",
          "Qwen/Qwen3-32B",
          "deepseek-ai/DeepSeek-V3.2-Exp",
        ]),
      ),
      // `Qwen/Qwen3-32B:together` selects an inference provider.
      allowProviderSuffix: true,
      maxTokens: parseInteger(env.HF_MAX_TOKENS, 16384),
      maxBodyBytes: parseInteger(env.HF_MAX_BODY_BYTES, 200 * 1024),
      timeoutMs: parseInteger(env.HF_TIMEOUT_MS, 60_000),
      token: env.HF_TOKEN || "",
      billTo: env.HF_BILL_TO || "wikimedia",
      // Leave unset on Toolforge: Kubernetes pods there have direct internet
      // egress, verified against a live deployment on 2026-08-10. Only for
      // the rare case some other outbound proxy is needed for this upstream.
      proxyUrl: env.HF_PROXY_URL || "",
    },
  };
}
