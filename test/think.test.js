import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCompletion, stripThinkTags } from "../lib/think.js";

test("strips a single think block and the whitespace it leaves behind", () => {
  assert.equal(stripThinkTags("<think>weighing it up</think>\n\n{\"v\":1}"), '{"v":1}');
});

test("strips multiple think blocks", () => {
  assert.equal(stripThinkTags("<think>a</think>one<think>b</think>two"), "onetwo");
});

test("matches the tag case-insensitively", () => {
  assert.equal(stripThinkTags("<THINK>hmm</Think>answer"), "answer");
});

test("strips a block spanning newlines", () => {
  assert.equal(stripThinkTags("<think>line one\nline two\n</think>answer"), "answer");
});

test("leaves text without think tags untouched", () => {
  assert.equal(stripThinkTags('{"verdict":"SUPPORTED"}'), '{"verdict":"SUPPORTED"}');
});

test("only trims leading whitespace, never trailing", () => {
  assert.equal(stripThinkTags("  answer  "), "answer  ");
});

test("leaves an unterminated think block intact", () => {
  // A completion truncated mid-reasoning has no closing tag. The Worker left
  // this untouched rather than blanking the content, and so do we — the
  // client distinguishes this case via finish_reason.
  const truncated = "<think>reasoning that never finished";
  assert.equal(stripThinkTags(truncated), truncated);
});

test("normalizeCompletion strips content across every choice", () => {
  const payload = {
    choices: [
      { message: { content: "<think>a</think>first" }, finish_reason: "stop" },
      { message: { content: "<think>b</think>second" }, finish_reason: "stop" },
    ],
  };
  normalizeCompletion(payload);
  assert.equal(payload.choices[0].message.content, "first");
  assert.equal(payload.choices[1].message.content, "second");
});

test("normalizeCompletion preserves finish_reason and usage verbatim", () => {
  const payload = {
    choices: [{ message: { content: "<think>x</think>ok" }, finish_reason: "length" }],
    usage: { prompt_tokens: 12, completion_tokens: 34 },
  };
  normalizeCompletion(payload);
  assert.equal(payload.choices[0].finish_reason, "length");
  assert.deepEqual(payload.usage, { prompt_tokens: 12, completion_tokens: 34 });
});

test("normalizeCompletion leaves the empty-content length case alone", () => {
  const payload = {
    choices: [{ message: { content: "" }, finish_reason: "length" }],
  };
  normalizeCompletion(payload);
  assert.equal(payload.choices[0].message.content, "");
  assert.equal(payload.choices[0].finish_reason, "length");
});

test("normalizeCompletion ignores non-string content", () => {
  const payload = { choices: [{ message: { content: null }, finish_reason: "length" }] };
  normalizeCompletion(payload);
  assert.equal(payload.choices[0].message.content, null);
});

test("normalizeCompletion tolerates a payload with no choices array", () => {
  assert.deepEqual(normalizeCompletion({ error: { message: "nope" } }), {
    error: { message: "nope" },
  });
  assert.equal(normalizeCompletion(null), null);
});
