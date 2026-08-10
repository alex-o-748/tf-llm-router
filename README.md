# llm-router

A small Node webservice for [Wikimedia Toolforge](https://wikitech.wikimedia.org/wiki/Portal:Toolforge)
that proxies OpenAI-compatible chat-completion requests to two upstreams:

- **Lift Wing** — Wikimedia's own model-hosting service (`POST /liftwing`)
- **HuggingFace** — the HF inference router (`POST /hf`)

It exists so a browser-based Wikipedia userscript can call these without
handling CORS or holding credentials, and so a batch job can call them without
reimplementing upstream quirks.

This is the LLM-routing half of the [public-ai-proxy](https://github.com/alex-o-748/public-ai-proxy)
Cloudflare Worker, ported to Node. Source fetching and the commercial
API-key-gated providers are deliberately not included.

## ⚠️ Read this first: Toolforge does *not* relax the Lift Wing rate limit

The premise for this port was that calling Lift Wing from inside Wikimedia
infrastructure would avoid the external rate limit and make the approved-bot
JWT unnecessary. **That turns out not to hold for Toolforge.**

Wikitech's [Lift Wing usage docs](https://wikitech.wikimedia.org/wiki/Machine_Learning/LiftWing/Usage)
split access into two paths:

| Path | Endpoint | Who can use it |
| --- | --- | --- |
| Internal | `https://inference.discovery.wmnet:30443/...` | Clients on the production WMF network — **explicitly not Toolforge or Cloud VPS** |
| External | `https://api.wikimedia.org/service/lw/inference/...` | Everyone: public internet, Toolforge, Cloud VPS |

Toolforge lives in the Cloud Services realm, which Wikimedia treats as
*external* for this purpose. So a tool running on Toolforge reaches Lift Wing
over exactly the same public path — and lands in exactly the same rate-limit
tier — as the Cloudflare Worker did.

Consequences, all of which are reflected in the code:

- **`LIFTWING_TOKEN` is kept, not removed.** The approved-bot JWT is still the
  only thing that lifts the rate limit. Removing it would have been a
  regression.
- **`LIFTWING_BASE` is an envvar**, so if an internal path is ever opened to
  Cloud Services this becomes a config change rather than a code change.
- Rate-limit relief has to come from the JWT or from an OAuth2 token that
  elevates the caller to the internal tier — not from where the code runs.

**This is unverified against a live Toolforge host.** It is read off the
official docs, which are unambiguous on the point, but nobody has yet run the
request from inside Toolforge and compared the observed limit. That is the one
open item; see [Verifying on Toolforge](#verifying-on-toolforge) for the
commands. The sibling batch service needs the same answer.

## API

| Route | Method | Upstream |
| --- | --- | --- |
| `/liftwing` | `POST` | `https://api.wikimedia.org/service/lw/inference/v1/models/<model>/openai/v1/chat/completions` |
| `/hf` | `POST` | `https://router.huggingface.co/v1/chat/completions` |
| `/liftwing`, `/hf` | `OPTIONS` | CORS preflight (`204`) |
| `/`, `/healthz` | `GET` | Health check (`200 {"ok":true}`) |

### Request

```json
{
  "model": "llm-qwen3-14b",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "max_tokens": 4096,
  "temperature": 0.1,
  "response_format": { "type": "json_object" }
}
```

`Content-Type: application/json`. No `Authorization` header — the service
injects any credential the upstream needs. `response_format` is optional and
forwarded as-is; whether constrained decoding is honoured depends on the
upstream vLLM configuration.

### Response

```json
{
  "choices": [
    { "message": { "content": "..." }, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0 }
}
```

`finish_reason: "length"` with empty content is passed through faithfully
rather than converted to an error — the client special-cases it.

### Errors

Errors are JSON, shaped `{ "error": { "message": "..." } }`. Upstream statuses
are preserved so the caller can tell a retryable failure (`429`, `503`) from a
permanent one (`400`):

| Condition | Status |
| --- | --- |
| Unknown route | `404` |
| Non-POST on a route | `405` |
| Malformed JSON / model not allowlisted | `400` |
| Body over the size cap | `413` |
| Local rate limit (if enabled) | `429` |
| Upstream `401`/`403` | `502`, with the upstream detail in the message |
| Any other upstream status | passed through verbatim, with `retry-after` |
| Upstream unreachable | `502` |
| Upstream timeout | `504` |

Upstream `401`/`403` is the one status deliberately not passed through: it
means *our* credential was rejected, not the caller's — they send no
`Authorization` at all — so surfacing it would invite a retry the caller can
never satisfy, and in a browser could trigger an auth prompt. The upstream
reason is preserved in the message, because it is usually a User-Agent policy
block or an expired token.

## Behaviour ported from the Worker

- **`<think>` stripping.** Lift Wing serves Qwen3 reasoning models that may
  emit chain-of-thought in `<think>…</think>` before the answer, which breaks
  the client's `JSON.parse`. Non-streaming responses have those blocks removed
  from every choice's `message.content`. The regex is kept byte-for-byte
  identical to the Worker's; see `lib/think.js`.
  - A completion truncated *mid-reasoning* has no closing `</think>` and is
    left untouched rather than blanked, matching the Worker.
  - Streaming responses pass through untouched — an SSE stream can't be
    cleanly rewritten mid-flight, so the client strips tags itself.
- **Model-id → URL construction.** Lift Wing routes by model name in the path
  as well as the body.
- **Model allowlists**, per route, overridable by envvar.
- **`max_tokens` clamping** — see below.
- **CORS.** `Access-Control-Allow-Origin` is echoed for origins matching
  `^https://[a-z0-9-]+\.(wikipedia|wikimedia)\.org$`; preflight returns `204`.
  Requests with no `Origin` at all (the batch job) are served normally and
  simply get no CORS headers back.
- **Wikimedia User-Agent policy.** Both `User-Agent` and `Api-User-Agent` are
  sent on Lift Wing requests.
- **JWT shape guard.** `LIFTWING_TOKEN` is only attached if it has the
  `Header.Payload.Signature` shape, because the gateway parses any
  `Authorization` header as a JWT and `401`s a malformed one. A blank or
  placeholder value falls back to anonymous access instead of failing every
  request.

### Two deliberate differences from the Worker

1. **`max_tokens` is clamped to 16384, not 4096.** The brief described the
   Worker as clamping to 4096; the Worker source actually uses `16384` for
   both routes (`HF_MAX_TOKENS`, `LIFTWING_MAX_TOKENS`). The higher ceiling is
   deliberate upstream: reasoning models spend output tokens on
   chain-of-thought before producing any answer, so a low cap truncates
   mid-reasoning and returns an empty completion. The client's own default of
   4096 sits below the ceiling either way, so the clamp only bites on
   unusually large requests. Override with `LIFTWING_MAX_TOKENS` /
   `HF_MAX_TOKENS`.
2. **`/hf` also strips `<think>` tags.** The Worker only did this for
   `/liftwing`, but the HF allowlist is all reasoning models too
   (`gpt-oss-20b`, `Qwen3-32B`). Stripping is a no-op when no tags are
   present, so this is safe even if the client already strips them, and it
   makes both routes behave identically for the batch consumer.

## Configuration

Everything is an envvar; nothing is committed. On Toolforge use
`toolforge envvars create <NAME>`.

### Secrets

| Envvar | Purpose |
| --- | --- |
| `LIFTWING_TOKEN` | Lift Wing approved-bot JWT. Optional — without it, calls use the anonymous tier. **Still required for rate-limit relief; see the warning above.** |
| `HF_TOKEN` | HuggingFace inference token. Required for `/hf`. |

### Tunables

| Envvar | Default |
| --- | --- |
| `PORT` | `8000` (assigned by Toolforge — never hardcode) |
| `LIFTWING_BASE` | `https://api.wikimedia.org/service/lw/inference/v1/models` |
| `LIFTWING_ALLOWED_MODELS` | `llm-qwen3-14b,llm-qwen36-27b` |
| `LIFTWING_MAX_TOKENS` | `16384` |
| `LIFTWING_MAX_BODY_BYTES` | `204800` |
| `LIFTWING_TIMEOUT_MS` | `120000` |
| `LIFTWING_USER_AGENT` | descriptive UA naming this repo |
| `LIFTWING_PROXY_URL` | unset (Wikimedia endpoints are reachable directly) |
| `HF_BASE` | `https://router.huggingface.co/v1/chat/completions` |
| `HF_ALLOWED_MODELS` | `openai/gpt-oss-20b,Qwen/Qwen3-32B,deepseek-ai/DeepSeek-V3.2-Exp` |
| `HF_MAX_TOKENS` | `16384` |
| `HF_MAX_BODY_BYTES` | `204800` |
| `HF_TIMEOUT_MS` | `60000` |
| `HF_BILL_TO` | `wikimedia` |
| `HF_PROXY_URL` | unset — likely needs `http://webproxy.eqiad.wmnet:8080` |
| `RATE_LIMIT_PER_MIN` | `0` (disabled) |

`HF_PROXY_URL`: Toolforge reaches the general internet through a web proxy,
while Wikimedia-hosted endpoints are reachable directly. If `/hf` fails with a
network error after deployment, this is the first thing to set.

`RATE_LIMIT_PER_MIN`: the Worker had a per-IP cap of 20/min. It is ported but
**off by default**, because the second consumer is a batch job calling from a
single Toolforge IP, and a browser-tuned per-IP cap would throttle it
immediately. Enable it only if abuse appears, and pick a value with the batch
job's rate in mind.

## Local development

```sh
npm install
npm test                                    # 36 tests, no network required
HF_TOKEN=… LIFTWING_TOKEN=… PORT=8000 npm start
```

The test suite runs the real server against a stub upstream on localhost, so
it covers routing, CORS, clamping, status passthrough, streaming and
`<think>` stripping end to end.

```sh
curl -s localhost:8000/liftwing \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://en.wikipedia.org' \
  -d '{"model":"llm-qwen3-14b","messages":[{"role":"user","content":"hi"}],"max_tokens":256}'
```

## Deployment

Toolforge's build service (Heroku-style buildpacks) reads `Procfile` and
`package.json`; the repo must be public so the builder can clone it by URL.

```sh
ssh <shell-user>@login.toolforge.org
become <toolname>

toolforge envvars create LIFTWING_TOKEN     # paste value at the prompt
toolforge envvars create HF_TOKEN

toolforge build start https://github.com/alex-o-748/tf-llm-router
toolforge build show                        # wait for success

toolforge webservice buildservice start
toolforge webservice logs -f
```

Then `https://<toolname>.toolforge.org/healthz` should return
`{"ok":true,"service":"llm-router"}`.

To redeploy after a push: `toolforge build start <url>` again, then
`toolforge webservice restart`.

## Verifying on Toolforge

The one open item. From a Toolforge shell (`become <toolname>`):

```sh
# 1. Is the internal endpoint reachable at all? Expected: it is not.
curl -sS --max-time 10 https://inference.discovery.wmnet:30443/v1/models

# 2. Baseline the external path anonymously, watching for 429 and the
#    rate-limit headers the gateway returns.
curl -sS -D- -o /dev/null \
  -H 'User-Agent: llm-router (https://github.com/alex-o-748/tf-llm-router)' \
  -H 'Content-Type: application/json' \
  -d '{"model":"llm-qwen3-14b","messages":[{"role":"user","content":"hi"}],"max_tokens":16}' \
  https://api.wikimedia.org/service/lw/inference/v1/models/llm-qwen3-14b/openai/v1/chat/completions

# 3. Repeat with `-H "Authorization: Bearer $LIFTWING_TOKEN"` and compare the
#    rate-limit headers between the two runs.
```

If step 1 unexpectedly succeeds, set `LIFTWING_BASE` to the internal endpoint
and the JWT can be dropped. If it fails as documented, the JWT stays, and the
next step is asking the Wikimedia ML team on `cloud@lists.wikimedia.org` or
`#wikimedia-cloud` whether an approved-bot JWT or an OAuth2 token is the right
route to the higher tier for a Toolforge-hosted tool.

Record the answer here — the sibling batch service needs the same knowledge.

## Not in scope

Source fetching / CORS proxying of arbitrary pages, commercial providers
(PublicAI, OpenAI, Anthropic, Gemini), request logging to a database, and auth
on the routes. These live elsewhere or are dropped by design.

## License

MIT — see [LICENSE](LICENSE).
