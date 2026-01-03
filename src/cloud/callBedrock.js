// src/cloud/callBedrock.js
//
// Bedrock caller for Anthropic Claude via Bedrock Runtime.
// Provides:
// - callBedrock({ modelId, prompt }) -> full text
// - streamBedrockText({ modelId, prompt, onTextDelta }) -> streams text deltas
//
// Requires: @aws-sdk/client-bedrock-runtime

const {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} = require("@aws-sdk/client-bedrock-runtime");

function createBedrockClient() {
  return new BedrockRuntimeClient({
    region: process.env.AWS_REGION || "eu-west-1",
  });
}

function buildAnthropicBody({ prompt, maxTokens }) {
  return {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: maxTokens ?? 4096,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
    ],
  };
}

async function callBedrock({ modelId, prompt, maxTokens }) {
  const client = createBedrockClient();

  const body = buildAnthropicBody({ prompt, maxTokens });

  const command = new InvokeModelCommand({
    modelId,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(body),
  });

  const response = await client.send(command);
  const decoded = JSON.parse(Buffer.from(response.body).toString("utf8"));

  // Anthropic messages API returns {content:[{type:"text", text:"..."}], ...}
  const out = decoded?.content?.[0]?.text;
  return typeof out === "string" ? out : JSON.stringify(decoded);
}

/**
 * Stream text deltas from Bedrock (Anthropic).
 * Calls onTextDelta(deltaText) for each emitted piece of text.
 *
 * Notes:
 * - Bedrock returns an event stream. For Anthropic, payloads are JSON objects
 *   representing message/content deltas.
 * - This implementation is defensive and ignores unknown event shapes.
 */
async function streamBedrockText({ modelId, prompt, maxTokens, onTextDelta }) {
  const client = createBedrockClient();

  const body = buildAnthropicBody({ prompt, maxTokens });

  const command = new InvokeModelWithResponseStreamCommand({
    modelId,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(body),
  });

  const response = await client.send(command);

  if (!response.body || typeof response.body[Symbol.asyncIterator] !== "function") {
    throw new Error("Bedrock response stream not available");
  }

  for await (const event of response.body) {
    // Different SDK versions can shape events differently.
    // The canonical shape uses event.chunk.bytes (Uint8Array).
    const bytes =
      event?.chunk?.bytes ||
      event?.Chunk?.Bytes ||
      event?.chunk ||
      null;

    if (!bytes) continue;

    const text = Buffer.from(bytes).toString("utf8").trim();
    if (!text) continue;

    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      // If the chunk isn't valid JSON, ignore (or could buffer). Keep conservative.
      continue;
    }

    // Anthropic streaming commonly emits objects like:
    // { "type":"content_block_delta", "delta": { "type":"text_delta", "text":"..." } }
    // Also may emit "message_delta", "message_stop", etc.
    const type = obj?.type;

    if (type === "content_block_delta") {
      const delta = obj?.delta;
      const deltaType = delta?.type;
      if (deltaType === "text_delta" && typeof delta?.text === "string") {
        onTextDelta(delta.text);
      }
      continue;
    }

    // Some variants may use: {type:"delta", text:"..."} (defensive)
    if ((type === "delta" || type === "text_delta") && typeof obj?.text === "string") {
      onTextDelta(obj.text);
      continue;
    }

    // Some variants may include: {type:"message", content:[...]} but that's usually non-stream.
    // Ignore other event types.
  }
}

module.exports = {
  callBedrock,
  streamBedrockText,
};
