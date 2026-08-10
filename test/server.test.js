import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { loadConfig } from "../lib/config.js";
import { createServer } from "../lib/server.js";

const WIKI_ORIGIN = "https://en.wikipedia.org";

// A stand-in for Lift Wing / the HF router. `stub.reply` is swapped per test;
// `stub.lastRequest` records what the proxy actually sent upstream.
async function startStub() {
  const stub = {
    reply: { status: 200, headers: {}, body: JSON.stringify({ choices: [] }) },
    lastRequest: null,
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      stub.lastRequest = {
        path: req.url,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      };
      const { status, headers, body } = stub.reply;
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(body);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  stub.url = `http://127.0.0.1:${server.address().port}`;
  stub.close = () => server.close();
  return stub;
}

async function startProxy(stubUrl, extraEnv = {}) {
  const config = loadConfig({
    PORT: "0",
    LIFTWING_BASE: `${stubUrl}/models`,
    HF_BASE: `${stubUrl}/hf/chat/completions`,
    LIFTWING_TOKEN: "header.payload.signature",
    HF_TOKEN: "hf-test-token",
    ...extraEnv,
  });
  const server = createServer(config);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
  };
}

// Boots a stub + proxy pair and tears both down after `fn`.
async function withServers(fn, extraEnv) {
  const stub = await startStub();
  const proxy = await startProxy(stub.url, extraEnv);
  try {
    await fn({ stub, proxy });
  } finally {
    proxy.close();
    stub.close();
  }
}

function post(proxy, path, body, headers = {}) {
  return fetch(`${proxy.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: WIKI_ORIGIN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID_REQUEST = {
  model: "llm-qwen3-14b",
  messages: [
    { role: "system", content: "You verify citations." },
    { role: "user", content: "Does the source support the claim?" },
  ],
  max_tokens: 4096,
  temperature: 0.1,
  response_format: { type: "json_object" },
};

test("CORS preflight from en.wikipedia.org succeeds", async () => {
  await withServers(async ({ proxy }) => {
    const res = await fetch(`${proxy.url}/liftwing`, {
      method: "OPTIONS",
      headers: {
        Origin: WIKI_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), WIKI_ORIGIN);
    assert.match(res.headers.get("access-control-allow-methods"), /POST/);
    assert.equal(res.headers.get("access-control-allow-headers"), "content-type");
    assert.equal(res.headers.get("vary"), "Origin");
  });
});

test("preflight from a non-Wikimedia origin gets no allow-origin header", async () => {
  await withServers(async ({ proxy }) => {
    const res = await fetch(`${proxy.url}/liftwing`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.com", "Access-Control-Request-Method": "POST" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });
});

test("/liftwing strips think tags and preserves finish_reason and usage", async () => {
  await withServers(async ({ stub, proxy }) => {
    stub.reply = {
      status: 200,
      headers: {},
      body: JSON.stringify({
        choices: [
          {
            message: { content: '<think>Let me check.</think>\n{"verdict":"SUPPORTED"}' },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    };
    const res = await post(proxy, "/liftwing", VALID_REQUEST);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.choices[0].message.content, '{"verdict":"SUPPORTED"}');
    assert.equal(json.choices[0].finish_reason, "stop");
    assert.deepEqual(json.usage, { prompt_tokens: 100, completion_tokens: 20 });
    assert.equal(res.headers.get("access-control-allow-origin"), WIKI_ORIGIN);
  });
});

test("finish_reason 'length' with empty content passes through untouched", async () => {
  await withServers(async ({ stub, proxy }) => {
    stub.reply = {
      status: 200,
      headers: {},
      body: JSON.stringify({
        choices: [{ message: { content: "" }, finish_reason: "length" }],
        usage: { prompt_tokens: 100, completion_tokens: 4096 },
      }),
    };
    const res = await post(proxy, "/liftwing", VALID_REQUEST);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.choices[0].finish_reason, "length");
    assert.equal(json.choices[0].message.content, "");
  });
});

test("/liftwing puts the model id in the upstream path and sends the JWT + UA", async () => {
  await withServers(async ({ stub, proxy }) => {
    await post(proxy, "/liftwing", VALID_REQUEST);
    assert.equal(
      stub.lastRequest.path,
      "/models/llm-qwen3-14b/openai/v1/chat/completions",
    );
    assert.equal(stub.lastRequest.headers.authorization, "Bearer header.payload.signature");
    assert.match(stub.lastRequest.headers["api-user-agent"], /llm-router/);
    assert.match(stub.lastRequest.headers["user-agent"], /llm-router/);
  });
});

test("a placeholder LIFTWING_TOKEN is dropped rather than sent as a bad JWT", async () => {
  await withServers(
    async ({ stub, proxy }) => {
      await post(proxy, "/liftwing", VALID_REQUEST);
      assert.equal(stub.lastRequest.headers.authorization, undefined);
    },
    { LIFTWING_TOKEN: "not-a-jwt" },
  );
});

test("max_tokens above the ceiling is clamped, below it is left alone", async () => {
  await withServers(async ({ stub, proxy }) => {
    await post(proxy, "/liftwing", { ...VALID_REQUEST, max_tokens: 999_999 });
    assert.equal(stub.lastRequest.body.max_tokens, 16384);

    await post(proxy, "/liftwing", { ...VALID_REQUEST, max_tokens: 4096 });
    assert.equal(stub.lastRequest.body.max_tokens, 4096);
  });
});

test("response_format and temperature are forwarded unchanged", async () => {
  await withServers(async ({ stub, proxy }) => {
    await post(proxy, "/liftwing", VALID_REQUEST);
    assert.deepEqual(stub.lastRequest.body.response_format, { type: "json_object" });
    assert.equal(stub.lastRequest.body.temperature, 0.1);
    assert.equal(stub.lastRequest.body.messages.length, 2);
  });
});

test("upstream 503 keeps its status instead of collapsing to 502", async () => {
  await withServers(async ({ stub, proxy }) => {
    stub.reply = {
      status: 503,
      headers: {},
      body: JSON.stringify({ error: { message: "model is loading" } }),
    };
    const res = await post(proxy, "/liftwing", VALID_REQUEST);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.message, "model is loading");
  });
});

test("upstream 429 preserves both status and retry-after", async () => {
  await withServers(async ({ stub, proxy }) => {
    stub.reply = {
      status: 429,
      headers: { "retry-after": "30" },
      body: JSON.stringify({ error: { message: "rate limited" } }),
    };
    const res = await post(proxy, "/liftwing", VALID_REQUEST);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "30");
  });
});

test("a non-JSON upstream error body is reshaped into { error: { message } }", async () => {
  await withServers(async ({ stub, proxy }) => {
    stub.reply = {
      status: 502,
      headers: { "Content-Type": "text/html" },
      body: "<html><body>Bad Gateway</body></html>",
    };
    const res = await post(proxy, "/liftwing", VALID_REQUEST);
    assert.equal(res.status, 502);
    const json = await res.json();
    assert.match(json.error.message, /Bad Gateway/);
  });
});

test("upstream 401 becomes 502 and keeps the upstream detail", async () => {
  await withServers(async ({ stub, proxy }) => {
    stub.reply = { status: 401, headers: {}, body: "User-Agent policy violation" };
    const res = await post(proxy, "/liftwing", VALID_REQUEST);
    // Our credential, not the caller's — surfacing 401 would invite a retry
    // the caller can never satisfy.
    assert.equal(res.status, 502);
    assert.match((await res.json()).error.message, /User-Agent policy violation/);
  });
});

test("a model outside the allowlist is rejected with 400", async () => {
  await withServers(async ({ proxy }) => {
    const res = await post(proxy, "/liftwing", { ...VALID_REQUEST, model: "gpt-4" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /Model not allowed: gpt-4/);
  });
});

test("/liftwing rejects a provider suffix rather than building a bad path", async () => {
  await withServers(async ({ proxy }) => {
    const res = await post(proxy, "/liftwing", {
      ...VALID_REQUEST,
      model: "llm-qwen3-14b:something",
    });
    assert.equal(res.status, 400);
  });
});

test("/hf accepts an allowlisted model with a provider suffix", async () => {
  await withServers(async ({ stub, proxy }) => {
    const res = await post(proxy, "/hf", {
      ...VALID_REQUEST,
      model: "Qwen/Qwen3-32B:together",
    });
    assert.equal(res.status, 200);
    assert.equal(stub.lastRequest.headers.authorization, "Bearer hf-test-token");
    assert.equal(stub.lastRequest.headers["x-hf-bill-to"], "wikimedia");
    // The suffix is only stripped for the allowlist check, not in the payload.
    assert.equal(stub.lastRequest.body.model, "Qwen/Qwen3-32B:together");
  });
});

test("/hf also strips think tags so both routes behave identically", async () => {
  await withServers(async ({ stub, proxy }) => {
    stub.reply = {
      status: 200,
      headers: {},
      body: JSON.stringify({
        choices: [{ message: { content: "<think>hmm</think>done" }, finish_reason: "stop" }],
      }),
    };
    const res = await post(proxy, "/hf", { ...VALID_REQUEST, model: "openai/gpt-oss-20b" });
    assert.equal((await res.json()).choices[0].message.content, "done");
  });
});

test("malformed JSON is rejected with 400", async () => {
  await withServers(async ({ proxy }) => {
    const res = await post(proxy, "/liftwing", "{not json");
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /Invalid JSON/);
  });
});

test("an oversized body is rejected with 413", async () => {
  await withServers(
    async ({ proxy }) => {
      const res = await post(proxy, "/liftwing", {
        ...VALID_REQUEST,
        messages: [{ role: "user", content: "x".repeat(5000) }],
      });
      assert.equal(res.status, 413);
    },
    { LIFTWING_MAX_BODY_BYTES: "1024" },
  );
});

test("a server-to-server call with no Origin works and gets no CORS header", async () => {
  await withServers(async ({ stub, proxy }) => {
    stub.reply = {
      status: 200,
      headers: {},
      body: JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    };
    const res = await fetch(`${proxy.url}/liftwing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_REQUEST),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    assert.equal((await res.json()).choices[0].message.content, "ok");
  });
});

test("GET on a proxy route is 405 with an Allow header", async () => {
  await withServers(async ({ proxy }) => {
    const res = await fetch(`${proxy.url}/liftwing`, { headers: { Origin: WIKI_ORIGIN } });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST, OPTIONS");
  });
});

test("unknown paths are 404, and the health check is 200", async () => {
  await withServers(async ({ proxy }) => {
    assert.equal((await fetch(`${proxy.url}/fetch?url=http://x`)).status, 404);
    const health = await fetch(`${proxy.url}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
  });
});

test("a streaming response passes through untouched", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"<think>"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const stub = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const chunk of chunks) res.write(chunk);
      res.end();
    });
  });
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
  const proxy = await startProxy(`http://127.0.0.1:${stub.address().port}`);
  try {
    const res = await post(proxy, "/liftwing", { ...VALID_REQUEST, stream: true });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    // Tags survive: an SSE stream can't be rewritten mid-flight, so the
    // client strips them itself.
    assert.equal(await res.text(), chunks.join(""));
  } finally {
    proxy.close();
    stub.close();
  }
});

test("upstream timeout returns 504", async () => {
  const stub = http.createServer(() => {
    /* never responds */
  });
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;
  const proxy = await startProxy(stubUrl, { LIFTWING_TIMEOUT_MS: "150" });
  try {
    const res = await post(proxy, "/liftwing", VALID_REQUEST);
    assert.equal(res.status, 504);
    assert.match((await res.json()).error.message, /Upstream timeout/);
  } finally {
    proxy.close();
    stub.close();
  }
});

test("an unreachable upstream returns 502", async () => {
  // Port 1 is reserved and refuses connections.
  const proxy = await startProxy("http://127.0.0.1:1");
  try {
    const res = await post(proxy, "/liftwing", VALID_REQUEST);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error.message, /Upstream network error/);
  } finally {
    proxy.close();
  }
});

test("the rate limiter is off by default and enforced when configured", async () => {
  await withServers(async ({ proxy }) => {
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await post(proxy, "/liftwing", VALID_REQUEST)).status, 200);
    }
  });

  await withServers(
    async ({ proxy }) => {
      assert.equal((await post(proxy, "/liftwing", VALID_REQUEST)).status, 200);
      assert.equal((await post(proxy, "/liftwing", VALID_REQUEST)).status, 200);
      const third = await post(proxy, "/liftwing", VALID_REQUEST);
      assert.equal(third.status, 429);
    },
    { RATE_LIMIT_PER_MIN: "2" },
  );
});
