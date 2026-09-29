import test from "node:test";
import assert from "node:assert/strict";
import { fromPredictResponse, toPredictRequest, unwrapTextContent } from "../lib/kserve.js";

// Verbatim shape of a live llm-gpt-oss-safeguard-20b:predict response (T439395).
const LIVE_VERDICT =
  "[TextContent(text='{\"violation\": 1, \"rationale\": \"The message is a promotional click‑bait offering a prize.\"}')]";

test("unwrapTextContent decodes the live :predict verdict repr", () => {
  assert.equal(
    unwrapTextContent(LIVE_VERDICT),
    '{"violation": 1, "rationale": "The message is a promotional click‑bait offering a prize."}',
  );
});

test("unwrapTextContent decodes Python escapes and double-quoted literals", () => {
  assert.equal(unwrapTextContent("[TextContent(text='it\\'s\\na \\\\ b')]"), "it's\na \\ b");
  // repr() switches to double quotes when the text has a ' and no ".
  assert.equal(unwrapTextContent(`[TextContent(text="it's fine")]`), "it's fine");
  assert.equal(unwrapTextContent("[TextContent(text='caf\\xe9 \\u2014 \\U0001F600')]"), "café — 😀");
});

test("unwrapTextContent joins multiple parts and tolerates extra fields", () => {
  assert.equal(
    unwrapTextContent("[TextContent(type='text', text='ab'), TextContent(text='cd', annotations=None)]"),
    "abcd",
  );
});

test("unwrapTextContent passes plain strings through and handles absent values", () => {
  assert.equal(unwrapTextContent('{"verdict":"SUPPORTED"}'), '{"verdict":"SUPPORTED"}');
  assert.equal(unwrapTextContent(undefined), "");
  assert.equal(unwrapTextContent("[TextContent(text='')]"), "");
});

test("toPredictRequest moves system messages into developer_prompt", () => {
  const out = toPredictRequest({
    model: "llm-gpt-oss-safeguard-20b",
    messages: [
      { role: "system", content: "Rules." },
      { role: "user", content: [{ type: "text", text: "Claim" }] },
    ],
    max_tokens: 4096,
    temperature: 0.1,
    top_p: 0.95,
    response_format: { type: "json_object" },
  });
  assert.deepEqual(out, {
    messages: [{ role: "user", content: "Claim" }],
    developer_prompt: "Rules.",
    max_tokens: 4096,
    temperature: 0.1,
    top_p: 0.95,
  });
});

test("fromPredictResponse builds a chat completion", () => {
  const out = fromPredictResponse(
    { reasoning: "[TextContent(text='thinking')]", verdict: "[TextContent(text='{}')]" },
    "llm-gpt-oss-safeguard-20b",
  );
  assert.equal(out.choices[0].message.content, "{}");
  assert.equal(out.choices[0].message.reasoning_content, "thinking");
  assert.equal(out.choices[0].finish_reason, "stop");
});

test("fromPredictResponse reports reasoning with no answer as length", () => {
  const out = fromPredictResponse(
    { reasoning: "[TextContent(text='still thinking')]", verdict: "[]" },
    "llm-gpt-oss-safeguard-20b",
  );
  assert.equal(out.choices[0].message.content, "");
  assert.equal(out.choices[0].finish_reason, "length");
});
