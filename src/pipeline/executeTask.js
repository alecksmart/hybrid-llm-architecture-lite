const { sanitizeText } = require("../sanitizer/sanitizeText");
const { buildCloudEnvelope } = require("../envelope/buildCloudEnvelope");
const { validateEnvelope } = require("../envelope/validateEnvelope");
const { routeWithLoad } = require("../routing/routeWithLoad");
const { ROUTES } = require("../routing/routeTask");
const { callBedrock } = require("../cloud/callBedrock");
const { assertCostAllowed } = require("../cost/costGuard");

function extractResponseMode(text) {
  const m = String(text || "").match(/^\s*(MODE=(EXPLAIN|COMPARE|DESIGN|CHECKLIST))\b/i);
  return m ? m[1].toUpperCase() : "MODE=EXPLAIN";
}

function stripResponseModePrefix(text) {
  const s = String(text || "");
  return s.replace(/^\s*MODE=(EXPLAIN|COMPARE|DESIGN|CHECKLIST)\b\s*/i, "").trimStart();
}

function serializeEnvelopeToPrompt(envelope) {
  return `
${envelope.transfer_prompt_version}

${JSON.stringify(envelope, null, 2)}
`;
}

async function executeTask({
  rawInput,
  routingHints,
  modelId,
}) {
  const responseMode = extractResponseMode(rawInput);
  const inputWithoutMode = stripResponseModePrefix(rawInput);

  // 1) sanitize
  const sanitized = sanitizeText(inputWithoutMode);

  // 2) route
  const decision = routeWithLoad(routingHints);

  if (decision.route === ROUTES.LOCAL) {
    return {
      route: "local",
      reason: decision.reason,
      output: null,
    };
  }

  // 3) build envelope
  const envelope = buildCloudEnvelope({
    sanitizedProblem: sanitized,
    contextSummary: (routingHints && routingHints.contextSummary) ? routingHints.contextSummary : [],
    modelId,
    responseMode,
  });

  // 4) validate envelope (HARD GATE)
  validateEnvelope(envelope);

  // 5) serialize → cloud
  const prompt = serializeEnvelopeToPrompt(envelope);

  // cost guard (HARD STOP)
  assertCostAllowed();

  const output = await callBedrock({
    modelId,
    prompt,
  });

  return {
    route: "cloud",
    reason: decision.reason,
    output,
  };
}

module.exports = { executeTask };
