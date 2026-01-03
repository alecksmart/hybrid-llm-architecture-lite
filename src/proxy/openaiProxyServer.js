// src/proxy/openaiProxyServer.js
//
// OpenAI-compatible proxy for Open WebUI:
// - GET  /v1/models
// - GET  /v1/health
// - POST /v1/chat/completions (non-stream + stream SSE)
//
// Routes:
// - Local: Ollama OpenAI-compatible endpoint (/v1) with model mapping
// - Cloud: AWS Bedrock (sanitized envelope)
//
// Policy (STEP 16):
// - Optional API key auth (Open WebUI "API Key" field)
// - Cloud blocked when OFFLINE_REQUIRED=true or CLOUD_ALLOWED=false
// - Cloud blocked when raw input appears sensitive unless ALLOW_SENSITIVE_CLOUD=true
// - Optional: allow/deny user overrides (/cloud, /local)
//
// Streaming (STEP 18):
// - Local: true SSE passthrough from Ollama
// - Cloud: true Bedrock streaming via InvokeModelWithResponseStream (fallback to chunked)

const express = require("express");
const fs = require("fs");

const { sanitizeText } = require("../sanitizer/sanitizeText");
const { buildCloudEnvelope } = require("../envelope/buildCloudEnvelope");
const { validateEnvelope } = require("../envelope/validateEnvelope");
const { ROUTES } = require("../routing/routeTask");

// Step 14 modules
const { routeWithLoad } = require("../routing/routeWithLoad");
const { assertCostAllowed } = require("../cost/costGuard");

// Bedrock callers
const { callBedrock, streamBedrockText } = require("../cloud/callBedrock");

// Policy module (STEP 16)
const { evaluateCloudPolicy, evaluateOverridePolicy } = require("../policy/policy");

// -------------------- Env / config --------------------

const PORT = Number(process.env.PORT || 8787);

// Ollama OpenAI-compatible base URL MUST include /v1
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1";

// Actual Ollama model to use for "local-fast" / local routed requests
const OLLAMA_LOCAL_MODEL = process.env.OLLAMA_LOCAL_MODEL || "llama3.1:8b";

const TRANSFER_PROMPT_PATH =
  process.env.TRANSFER_PROMPT_PATH || "prompts/transfer/cloud_transfer_prompt_v1.md";

// Proxy-exposed model IDs (what Open WebUI sees)
const MODEL_AUTO = process.env.DEFAULT_MODEL_AUTO || "auto-hybrid";
const MODEL_LOCAL = process.env.DEFAULT_MODEL_LOCAL || "local-fast";
const MODEL_CLOUD = process.env.DEFAULT_MODEL_CLOUD || "cloud-deep";

// Bedrock model id must be a valid Bedrock modelId
const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID || "eu.anthropic.claude-3-sonnet-20240229-v1:0";

const OFFLINE_REQUIRED = (process.env.OFFLINE_REQUIRED || "false") === "true";
const CLOUD_ALLOWED = (process.env.CLOUD_ALLOWED || "false") === "true";

// Optional proxy auth (set to require Open WebUI API key)
const PROXY_API_KEY = process.env.PROXY_API_KEY || "";

// Open WebUI file resolution for vision
// Required only when Open WebUI sends image_url with a file-id (UUID) instead of a real URL/data URL.
const OPEN_WEBUI_BASE_URL = process.env.OPEN_WEBUI_BASE_URL || process.env.OPENWEBUI_BASE_URL || "";
const OPEN_WEBUI_SERVICE_TOKEN =
  process.env.OPEN_WEBUI_SERVICE_TOKEN || process.env.OPENWEBUI_SERVICE_TOKEN || "";
const ALLOW_CLOUD_IMAGES = (process.env.ALLOW_CLOUD_IMAGES || "false") === "true";

// Debug toggles
const DEBUG_LOCAL = (process.env.DEBUG_LOCAL || "false") === "true";
const DEBUG_CLOUD = (process.env.DEBUG_CLOUD || "false") === "true";

// -------------------- Helpers: auth --------------------

function authMiddleware(req, res, next) {
  if (!PROXY_API_KEY) return next();

  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const xKey = req.headers["x-api-key"] || "";

  if (bearer === PROXY_API_KEY || xKey === PROXY_API_KEY) return next();

  return res.status(401).json({ error: { message: "Unauthorized" } });
}

// -------------------- Helpers: OpenAI compat --------------------

function modelsPayload() {
  const now = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: [
      { id: MODEL_AUTO, object: "model", created: now, owned_by: "hybrid-proxy" },
      { id: MODEL_LOCAL, object: "model", created: now, owned_by: "hybrid-proxy" },
      { id: MODEL_CLOUD, object: "model", created: now, owned_by: "hybrid-proxy" },
    ],
  };
}

function openaiChatResponse({ id, model, content }) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  };
}

// -------------------- Helpers: SSE streaming --------------------

function setSseHeaders(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
}

function sseWrite(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sseDone(res) {
  res.write("data: [DONE]\n\n");
  res.end();
}

function openaiStreamChunk({ id, model, content, created }) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: null,
      },
    ],
  };
}

function openaiStreamFinal({ id, model, created }) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  };
}

function* chunkText(text, chunkSize = 200) {
  for (let i = 0; i < text.length; i += chunkSize) {
    yield text.slice(i, i + chunkSize);
  }
}

// -------------------- Helpers: input parsing --------------------

function stringifyContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (!p) return "";
        if (typeof p === "string") return p;
        if (typeof p.text === "string") return p.text;
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  return "";
}

// -------------------- Helpers: modes + multimodal --------------------

function extractResponseMode(text) {
  const m = (text || "").match(/^\s*(MODE=(EXPLAIN|COMPARE|DESIGN|CHECKLIST))\b/i);
  return m ? m[1].toUpperCase() : "MODE=EXPLAIN";
}

function stripResponseModePrefix(text) {
  return (text || "").replace(/^\s*MODE=(EXPLAIN|COMPARE|DESIGN|CHECKLIST)\b\s*/i, "");
}

function isDataUrl(u) {
  return typeof u === "string" && u.startsWith("data:");
}

function isHttpUrl(u) {
  return typeof u === "string" && (u.startsWith("http://") || u.startsWith("https://"));
}

function looksLikeUuid(u) {
  return typeof u === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(u);
}

function extractUserTextAndImageRefs(messages) {
  const users = (messages || []).filter((m) => m && m.role === "user");

  const textParts = [];
  const imageRefs = [];

  for (const m of users) {
    const c = m.content;

    if (typeof c === "string") {
      textParts.push(c);
      continue;
    }

    if (Array.isArray(c)) {
      for (const p of c) {
        if (!p) continue;

        if (typeof p === "string") {
          textParts.push(p);
          continue;
        }

        // text part
        if (typeof p.text === "string") textParts.push(p.text);

        // image part (OpenAI-style)
        if (p.type === "image_url" && p.image_url && typeof p.image_url.url === "string") {
          imageRefs.push(p.image_url.url);
        }
      }
      continue;
    }

    // fallback
    textParts.push(stringifyContent(c));
  }

  return { userText: textParts.filter(Boolean).join("\n\n"), imageRefs };
}

async function fetchOpenWebUIFileAsDataUrl(fileId) {
  if (!OPEN_WEBUI_BASE_URL || !OPEN_WEBUI_SERVICE_TOKEN) {
    throw new Error(
      "Vision requires OPEN_WEBUI_BASE_URL and OPEN_WEBUI_SERVICE_TOKEN to resolve image file IDs."
    );
  }

  const base = OPEN_WEBUI_BASE_URL.replace(/\/$/, "");
  const url = `${base}/api/v1/files/${fileId}/content`;

  const r = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${OPEN_WEBUI_SERVICE_TOKEN}`,
    },
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Failed to fetch image from Open WebUI (${r.status}): ${t.slice(0, 200)}`);
  }

  const contentType = r.headers.get("content-type") || "image/png";
  const buf = Buffer.from(await r.arrayBuffer());
  const b64 = buf.toString("base64");
  return { contentType, dataUrl: `data:${contentType};base64,${b64}`, base64: b64 };
}

async function resolveImageRefs(imageRefs) {
  const out = [];
  for (const ref of imageRefs || []) {
    if (!ref) continue;

    if (isDataUrl(ref)) {
      // parse mime if possible
      const m = ref.match(/^data:([^;]+);base64,(.*)$/);
      out.push({ contentType: m ? m[1] : "image/png", dataUrl: ref, base64: m ? m[2] : "" });
      continue;
    }

    if (isHttpUrl(ref)) {
      // If you want, you can implement URL fetching here; for now we pass through as unsupported.
      // Bedrock expects base64 image bytes, so URL fetch is not sufficient unless we fetch and convert.
      const fetched = await (async () => {
        const r = await fetch(ref);
        if (!r.ok) throw new Error(`Failed to fetch image URL (${r.status})`);
        const contentType = r.headers.get("content-type") || "image/png";
        const buf = Buffer.from(await r.arrayBuffer());
        const b64 = buf.toString("base64");
        return { contentType, dataUrl: `data:${contentType};base64,${b64}`, base64: b64 };
      })();
      out.push(fetched);
      continue;
    }

    // Open WebUI sends file IDs like UUIDs
    if (looksLikeUuid(ref)) {
      out.push(await fetchOpenWebUIFileAsDataUrl(ref));
      continue;
    }

    // Unknown ref format
    throw new Error(`Unsupported image reference format: ${String(ref).slice(0, 80)}`);
  }
  return out;
}

function extractUserText(messages) {
  return (messages || [])
    .filter((m) => m && m.role === "user")
    .map((m) => stringifyContent(m.content))
    .filter(Boolean)
    .join("\n\n");
}

// -------------------- Routing hints (deterministic) --------------------

function decideRoutingHints(userText, requestedModel) {
  const overridePolicy = evaluateOverridePolicy();

  const wantsCloudOverride = userText.includes("/cloud");
  const wantsLocalOverride = userText.includes("/local");

  const explicitCloud =
    (overridePolicy.allow && wantsCloudOverride) || requestedModel === MODEL_CLOUD;

  const explicitLocal =
    (overridePolicy.allow && wantsLocalOverride) || requestedModel === MODEL_LOCAL;

  // If overrides are disabled but user tried them, keep neutral; requestedModel still applies.
  // Sensitivity is evaluated later in policy gate (cloud blocks).

  if (explicitLocal) {
    return {
      requiresDeepReasoning: false,
      forceLocal: true,
      forceCloud: false,
    };
  }

  if (explicitCloud) {
    return {
      requiresDeepReasoning: true,
      forceLocal: false,
      forceCloud: true,
    };
  }

  const longOrComplex =
    userText.length > 2000 ||
    /threat model|architecture|trade-?offs|design|attack surface|risk|mitigation|iam|policy/i.test(
      userText
    );

  return {
    requiresDeepReasoning: longOrComplex,
    forceLocal: false,
    forceCloud: false,
  };
}

// -------------------- Transfer prompt + Bedrock handling --------------------

function loadTransferPromptTemplate() {
  return fs.readFileSync(TRANSFER_PROMPT_PATH, "utf8");
}

function fillTemplatePlaceholders(template, envelope) {
  return template
    .replaceAll("{{WEB_BROWSING_ENABLED}}", "false")
    .replaceAll("{{CLOUD_MODEL_FAMILY}}", envelope.cloud?.model_family || "claude")
    .replaceAll("{{CLOUD_MODEL_ID}}", envelope.cloud?.model_id || BEDROCK_MODEL_ID)
    .replaceAll("{{REQUEST_ID}}", envelope.meta?.request_id || "")
    .replaceAll("{{TIME_UTC}}", envelope.meta?.time_utc || "");
}

function serializeTransferPrompt(template, envelope) {
  const filled = fillTemplatePlaceholders(template, envelope);
  return `${filled}\n\n${JSON.stringify(envelope, null, 2)}\n`;
}

function buildCloudPromptFromUserText(userText, responseMode) {
  const sanitized = sanitizeText(userText);

  const envelope = buildCloudEnvelope({
    sanitizedProblem: sanitized,
    contextSummary: [
      "Hybrid local + AWS Bedrock architecture",
      "EXTREMELY_HIGH sensitivity: no raw confidential data leaves local",
    ],
    modelId: BEDROCK_MODEL_ID,
    webBrowsingEnabled: false,
    responseMode,
  });

  validateEnvelope(envelope);

  const template = loadTransferPromptTemplate();
  const prompt = serializeTransferPrompt(template, envelope);

  return { prompt, sanitizedChars: sanitized.length, envelope };
}

// -------------------- Cloud: Bedrock vision (images) --------------------

async function invokeBedrockMessages({ modelId, messages, maxTokens = 2048 }) {
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "eu-west-1";

  // Lazy require to avoid hard dependency if not used
  const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");

  const client = new BedrockRuntimeClient({ region });

  const payload = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: maxTokens,
    messages,
  };

  const cmd = new InvokeModelCommand({
    modelId,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(payload),
  });

  const resp = await client.send(cmd);
  const bodyStr = Buffer.from(resp.body).toString("utf-8");
  const parsed = JSON.parse(bodyStr);

  // Claude Messages response: { content: [{type:"text", text:"..."}], ... }
  const out =
    (Array.isArray(parsed.content) ? parsed.content.map((c) => c && c.text ? c.text : "").join("") : "") ||
    parsed.completion ||
    "";

  return out;
}

async function callBedrockVision({ modelId, prompt, imageRefs }) {
  const images = await resolveImageRefs(imageRefs);

  const content = [
    { type: "text", text: prompt },
    ...images.map((img) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: img.contentType || "image/png",
        data: img.base64,
      },
    })),
  ];

  const messages = [{ role: "user", content }];

  return await invokeBedrockMessages({ modelId, messages });
}

async function handleCloudNonStream({ userText, responseMode, imageRefs }) {
  // HARD STOP cost guard (no AWS call if exceeded)
  assertCostAllowed();

  const { prompt, sanitizedChars, envelope } = buildCloudPromptFromUserText(userText, responseMode);

  if (imageRefs && imageRefs.length > 0) {
  const id = `hybrid-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  setSseHeaders(res);

  try {
    const output = await callBedrockVision({ modelId: BEDROCK_MODEL_ID, prompt, imageRefs });

    if (DEBUG_CLOUD) {
      console.log("[cloud] bedrock_vision_response_chars:", output.length);
    }

    sseWrite(res, openaiStreamChunk({ id, model: MODEL_CLOUD, content: output, created }));
    sseWrite(res, openaiStreamFinal({ id, model: MODEL_CLOUD, created }));
    return sseDone(res);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    // Return a normal JSON error-shaped SSE chunk as final message
    sseWrite(res, openaiStreamChunk({ id, model: MODEL_CLOUD, content: `Error: ${msg}`, created }));
    sseWrite(res, openaiStreamFinal({ id, model: MODEL_CLOUD, created }));
    return sseDone(res);
  }
}

  if (DEBUG_CLOUD) {
    console.log("[cloud] model_id:", BEDROCK_MODEL_ID);
    console.log("[cloud] request_id:", envelope.meta?.request_id);
    console.log("[cloud] time_utc:", envelope.meta?.time_utc);
    console.log("[cloud] sanitized_chars:", sanitizedChars);
    console.log("[cloud] web_browsing_enabled:", envelope.web_browsing_enabled);
  }

  const output = await callBedrock({ modelId: BEDROCK_MODEL_ID, prompt });

  if (DEBUG_CLOUD) {
    console.log("[cloud] bedrock_response_chars:", output.length);
  }

  return output;
}

async function handleCloudStream({ userText, responseMode, imageRefs, res }) {
  // HARD STOP cost guard (no AWS call if exceeded)
  assertCostAllowed();

  const { prompt, sanitizedChars, envelope } = buildCloudPromptFromUserText(userText, responseMode);

  if (imageRefs && imageRefs.length > 0) {
    const output = await callBedrockVision({ modelId: BEDROCK_MODEL_ID, prompt, imageRefs });
    if (DEBUG_CLOUD) {
      console.log("[cloud] bedrock_vision_response_chars:", output.length);
    }
    return output;
  }

  if (DEBUG_CLOUD) {
    console.log("[cloud-stream] model_id:", BEDROCK_MODEL_ID);
    console.log("[cloud-stream] request_id:", envelope.meta?.request_id);
    console.log("[cloud-stream] time_utc:", envelope.meta?.time_utc);
    console.log("[cloud-stream] sanitized_chars:", sanitizedChars);
  }

  const id = `hybrid-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  setSseHeaders(res);

  // True Bedrock streaming (STEP 18). Fallback to non-stream chunking if it fails.
  try {
    await streamBedrockText({
      modelId: BEDROCK_MODEL_ID,
      prompt,
      onTextDelta: (delta) => {
        if (delta) {
          sseWrite(res, openaiStreamChunk({ id, model: MODEL_CLOUD, content: delta, created }));
        }
      },
    });

    sseWrite(res, openaiStreamFinal({ id, model: MODEL_CLOUD, created }));
    return sseDone(res);
  } catch (e) {
    if (DEBUG_CLOUD) console.log("[cloud-stream] fallback to chunked:", e.message);

    const content = await callBedrock({ modelId: BEDROCK_MODEL_ID, prompt });
    for (const part of chunkText(content, 200)) {
      sseWrite(res, openaiStreamChunk({ id, model: MODEL_CLOUD, content: part, created }));
    }
    sseWrite(res, openaiStreamFinal({ id, model: MODEL_CLOUD, created }));
    return sseDone(res);
  }
}

// -------------------- Ollama forwarding --------------------

async function forwardToOllamaOpenAIChat(body) {
  const resp = await fetch(`${OLLAMA_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Ollama forward failed: ${resp.status} ${t}`);
  }
  return resp.json();
}

async function forwardToOllamaOpenAIChatStream(reqBody, res) {
  const resp = await fetch(`${OLLAMA_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...reqBody, stream: true }),
  });

  if (!resp.ok || !resp.body) {
    const t = await resp.text();
    throw new Error(`Ollama stream forward failed: ${resp.status} ${t}`);
  }

  setSseHeaders(res);

  const reader = resp.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

// -------------------- Server --------------------

function main() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // Apply auth to v1 routes only (Open WebUI uses these)
  app.use("/v1", authMiddleware);

  app.get("/v1/health", (req, res) => {
    res.json({ ok: true, service: "hybrid-proxy" });
  });

  app.get("/v1/models", (req, res) => {
    res.json(modelsPayload());
  });

  app.post("/v1/chat/completions", async (req, res) => {
    try {
      const body = req.body || {};
      const requestedModel = body.model || MODEL_AUTO;
      const wantsStream = body.stream === true;

      const { userText: rawUserText, imageRefs } = extractUserTextAndImageRefs(body.messages);

      const responseMode = extractResponseMode(rawUserText);
      const userText = stripResponseModePrefix(rawUserText);

      // Policy gate for cloud (STEP 16)
      const cloudPolicy = evaluateCloudPolicy({
        offlineRequired: OFFLINE_REQUIRED,
        cloudAllowed: CLOUD_ALLOWED,
        rawUserText: userText,
      });

      // If images are present, only cloud vision can handle them (local model is text-only).
// Enforced by default to avoid silently ignoring images.
if (imageRefs && imageRefs.length > 0) {
  if (OFFLINE_REQUIRED) {
    return res.status(400).json({
      error: { message: "Image input detected but OFFLINE_REQUIRED=true. Vision requires cloud and cannot run offline." }
    });
  }
  if (!CLOUD_ALLOWED) {
    return res.status(400).json({
      error: { message: "Image input detected but CLOUD_ALLOWED=false. Enable cloud to use vision." }
    });
  }
  if (!ALLOW_CLOUD_IMAGES) {
    return res.status(400).json({
      error: {
        message:
          "Image input detected, but cloud image forwarding is disabled. Set ALLOW_CLOUD_IMAGES=true and configure OPEN_WEBUI_BASE_URL + OPEN_WEBUI_SERVICE_TOKEN."
      }
    });
  }
}

// Determine routing intent/overrides
      const hints = decideRoutingHints(userText, requestedModel);

      // Policy switch: offline always local (never error)
      if (OFFLINE_REQUIRED === true) {
        if (DEBUG_LOCAL) console.log("[local] offline required; routing local");
        if (wantsStream) {
          if (DEBUG_LOCAL) console.log("[local] forwarding to ollama model:", OLLAMA_LOCAL_MODEL);
          return await forwardToOllamaOpenAIChatStream(
            { ...body, model: OLLAMA_LOCAL_MODEL },
            res
          );
        }
        if (DEBUG_LOCAL) console.log("[local] forwarding to ollama model:", OLLAMA_LOCAL_MODEL);
        const forwarded = await forwardToOllamaOpenAIChat({ ...body, model: OLLAMA_LOCAL_MODEL });
        return res.json(forwarded);
      }

      // If user explicitly selected cloud model but cloud is not allowed, return 403
      if (requestedModel === MODEL_CLOUD && !cloudPolicy.allowed) {
        return res.status(403).json({
          error: { message: `Cloud blocked: ${cloudPolicy.reason}` },
        });
      }

      // Determine base route decision (STEP 14 load-aware)
      const baseDecision = routeWithLoad({
        taskType: "chat",
        requiresDeepReasoning: hints.requiresDeepReasoning,
        containsSensitiveData: !cloudPolicy.allowed, // conservative: if cloud not allowed, treat as sensitive for routing
        offlineRequired: OFFLINE_REQUIRED,
        cloudAllowed: CLOUD_ALLOWED,
      });

      // Compute final route:
      // - forceLocal always wins
      // - forceCloud only if cloud policy allows
      // - otherwise: baseDecision, but only cloud if policy allows
      let finalRoute = baseDecision.route;
      let finalReason = baseDecision.reason;

      if (hints.forceLocal) {
        finalRoute = ROUTES.LOCAL;
        finalReason = "Forced local";
      } else if (hints.forceCloud) {
        if (cloudPolicy.allowed) {
          finalRoute = ROUTES.CLOUD;
          finalReason = "Forced cloud";
        } else {
          finalRoute = ROUTES.LOCAL;
          finalReason = `Cloud blocked: ${cloudPolicy.reason}`;
        }
      } else {
        if (finalRoute === ROUTES.CLOUD && !cloudPolicy.allowed) {
          finalRoute = ROUTES.LOCAL;
          finalReason = `Cloud blocked: ${cloudPolicy.reason}`;
        }
      }

      // CLOUD PATH
      if (finalRoute === ROUTES.CLOUD) {
        if (wantsStream) return await handleCloudStream({ userText, responseMode, imageRefs, res });

        const content = await handleCloudNonStream({ userText, responseMode, imageRefs });
        return res.json(
          openaiChatResponse({
            id: `hybrid-${Date.now()}`,
            model: MODEL_CLOUD,
            content,
          })
        );
      }

      // LOCAL PATH (model mapping applied)
      if (DEBUG_LOCAL) console.log("[local] routing local; forwarding to ollama model:", OLLAMA_LOCAL_MODEL);

      if (wantsStream) {
        return await forwardToOllamaOpenAIChatStream({ ...body, model: OLLAMA_LOCAL_MODEL }, res);
      }

      const forwarded = await forwardToOllamaOpenAIChat({ ...body, model: OLLAMA_LOCAL_MODEL });
      return res.json(forwarded);
    } catch (e) {
      const wantsStream = req.body && req.body.stream === true;
      if (wantsStream) {
        setSseHeaders(res);
        sseWrite(res, {
          error: {
            message: e.message,
            details: e.details || null,
          },
        });
        return sseDone(res);
      }

      return res.status(500).json({
        error: { message: e.message, details: e.details || null },
      });
    }
  });

  app.listen(PORT, () => {
    console.log(`Hybrid OpenAI-compatible proxy listening on :${PORT}`);
  });
}

module.exports = {
  main,
  chunkText, // exported for unit tests if desired
};

if (require.main === module) main();
