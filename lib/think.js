// Qwen3 and the other reasoning models served by Lift Wing may emit their
// chain-of-thought wrapped in <think>…</think> ahead of the actual answer.
// The client JSON.parses the message content, so an unstripped reasoning
// block breaks verdict parsing in a way that looks like a model failure
// rather than a proxy failure. This is the highest-risk behaviour in the
// port; it is kept byte-for-byte equivalent to the Cloudflare Worker's
// version.
//
// Note the non-greedy match requires a closing tag: a completion truncated
// mid-reasoning (finish_reason "length") has no </think> and is deliberately
// left untouched rather than blanked, matching the Worker.
export function stripThinkTags(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^\s+/, "");
}

// Applies stripThinkTags to every choice's message content, in place.
//
// Only string content is touched. A null/absent content — which is what a
// completion truncated mid-reasoning looks like — is left exactly as it
// arrived, as are finish_reason and usage, because the client special-cases
// `finish_reason: "length"` with empty content and needs to see it verbatim.
export function normalizeCompletion(payload) {
  if (!payload || !Array.isArray(payload.choices)) return payload;

  for (const choice of payload.choices) {
    if (choice && choice.message && typeof choice.message.content === "string") {
      choice.message.content = stripThinkTags(choice.message.content);
    }
  }
  return payload;
}
