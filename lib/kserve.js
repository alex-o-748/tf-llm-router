// Translation between the OpenAI chat-completions shape the clients speak and
// the KServe `:predict` shape some Lift Wing models are served behind.
//
// gpt-oss-safeguard-20b (T439395) is exposed at
// `<base>/<model>:predict` rather than `<base>/<model>/openai/v1/chat/completions`.
// Its request and response differ from chat-completions:
//
//   request:  { messages, developer_prompt, max_tokens, temperature, top_p }
//             — the system prompt travels as `developer_prompt`, not as a
//             `system` message.
//   response: { reasoning: "[TextContent(text='...')]",
//               verdict:   "[TextContent(text='...')]" }
//             — each field is the Python repr() of a list of TextContent
//             objects, not plain text.
//
// Translating here keeps /liftwing a single contract for callers: they send
// and receive chat-completions whatever the model, and the day Lift Wing adds
// a chat-completions endpoint for this model, dropping it from
// LIFTWING_PREDICT_MODELS is the whole migration.

// Chat-completions fields the :predict endpoint is documented to accept.
// Everything else (response_format, stream, ...) is dropped rather than
// forwarded, since an unknown field is at best ignored and at worst a 400.
const FORWARDED_PARAMS = ["max_tokens", "temperature", "top_p"];

function contentToText(content) {
  if (typeof content === "string") return content;
  // OpenAI content-part arrays: keep the text parts.
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("");
  }
  return "";
}

export function toPredictRequest(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = [];
  const rest = [];
  for (const message of messages) {
    if (message?.role === "system" || message?.role === "developer") {
      system.push(contentToText(message.content));
    } else {
      rest.push({ role: message?.role, content: contentToText(message?.content) });
    }
  }

  const out = { messages: rest };
  if (system.length > 0) out.developer_prompt = system.join("\n\n");
  for (const key of FORWARDED_PARAMS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

const SIMPLE_ESCAPES = {
  "\\": "\\",
  "'": "'",
  '"': '"',
  n: "\n",
  r: "\r",
  t: "\t",
  a: "\x07",
  b: "\b",
  f: "\f",
  v: "\v",
  0: "\0",
};

// Reads one Python string literal starting at `text[start]` (the opening
// quote). Returns the decoded value and the index just past the closing
// quote, or null if the literal is unterminated.
function readPythonString(text, start) {
  const quote = text[start];
  let out = "";
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === quote) return { value: out, end: i + 1 };
    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    const next = text[i + 1];
    const hexLength = next === "x" ? 2 : next === "u" ? 4 : next === "U" ? 8 : 0;
    if (hexLength > 0) {
      const hex = text.slice(i + 2, i + 2 + hexLength);
      if (/^[0-9a-fA-F]+$/.test(hex) && hex.length === hexLength) {
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        i += 2 + hexLength;
        continue;
      }
    }
    if (next !== undefined && Object.hasOwn(SIMPLE_ESCAPES, next)) {
      out += SIMPLE_ESCAPES[next];
    } else {
      // Unknown escape: Python keeps the backslash.
      out += "\\" + (next ?? "");
    }
    i += 2;
  }
  return null;
}

/**
 * Extracts the text from a `[TextContent(text='...'), ...]` repr, joining
 * multiple parts. A value that isn't in that shape is returned unchanged, so
 * a future fix upstream (plain strings) needs no change here.
 */
export function unwrapTextContent(value) {
  if (value == null) return "";
  if (typeof value !== "string") return JSON.stringify(value);
  // repr() of an empty list: the model produced nothing.
  if (value.trim() === "[]") return "";
  if (!/TextContent\(/.test(value)) return value;

  const parts = [];
  const marker = /TextContent\([^)]*?\btext=(['"])/g;
  let match;
  while ((match = marker.exec(value)) !== null) {
    const quoteIndex = match.index + match[0].length - 1;
    const literal = readPythonString(value, quoteIndex);
    if (!literal) break;
    parts.push(literal.value);
    marker.lastIndex = literal.end;
  }
  return parts.length > 0 ? parts.join("") : value;
}

export function fromPredictResponse(payload, model) {
  const content = unwrapTextContent(payload?.verdict);
  const reasoning = unwrapTextContent(payload?.reasoning);
  // No finish_reason comes back from :predict. Reasoning with no answer is
  // what running out of output budget mid-reasoning looks like on every other
  // reasoning model, so report it as "length" — the client names that failure
  // specifically instead of a generic "no content".
  const finishReason = content === "" && reasoning !== "" ? "length" : "stop";
  return {
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, reasoning_content: reasoning },
        finish_reason: finishReason,
      },
    ],
    // :predict reports no token counts.
    usage: { prompt_tokens: 0, completion_tokens: 0 },
  };
}
