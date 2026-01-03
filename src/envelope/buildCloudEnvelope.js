const { randomUUID } = require("crypto");

const MODE_ENUM = ["MODE=EXPLAIN", "MODE=COMPARE", "MODE=DESIGN", "MODE=CHECKLIST"];

function normalizeMode(mode) {
  if (!mode) return "MODE=EXPLAIN";
  const m = String(mode).trim().toUpperCase();
  return MODE_ENUM.includes(m) ? m : "MODE=EXPLAIN";
}

function sectionsForMode(mode) {
  // Keep schema satisfied, but do not force a "full report" unless MODE=DESIGN.
  if (mode === "MODE=DESIGN") {
    return ["facts_given", "assumptions", "recommendations", "risks_tradeoffs", "tests", "next_steps"];
  }
  if (mode === "MODE=CHECKLIST") return ["checklist"];
  if (mode === "MODE=COMPARE") return ["comparison", "recommendation"];
  return ["answer"];
}

function deliverableForMode(mode) {
  if (mode === "MODE=DESIGN") return "design";
  if (mode === "MODE=CHECKLIST") return "checklist";
  if (mode === "MODE=COMPARE") return "compare";
  return "explain";
}

function buildCloudEnvelope({
  sanitizedProblem,
  contextSummary,
  modelId,
  webBrowsingEnabled = false,
  responseMode = "MODE=EXPLAIN",
  objective,
  constraints,
}) {
  const mode = normalizeMode(responseMode);

  return {
    transfer_prompt_version: "v1",
    web_browsing_enabled: webBrowsingEnabled,
    data_sensitivity: "EXTREMELY_HIGH",

    cloud: {
      provider: "aws_bedrock",
      model_family: "claude",
      model_id: modelId,
    },

    redaction_policy: {
      mode: "both",
      removed_categories: [
        "secrets",
        "account_ids",
        "emails",
        "domains",
        "raw_logs",
        "source_code"
      ],
      masking_style: "[REDACTED:TYPE]",
    },

    response_mode: { mode },

    task: {
      objective: objective || "Mode-aware reasoning on sanitized input (no secrets).",
      deliverable_type: deliverableForMode(mode),
      constraints: Array.isArray(constraints) ? constraints : [
        "No secrets",
        "No real-time claims",
        "No re-identification"
      ],
    },

    context_summary_sanitized: Array.isArray(contextSummary) ? contextSummary : [],

    inputs_sanitized: {
      problem_statement: sanitizedProblem,
    },

    output_format_required: {
      format: "markdown",
      sections: sectionsForMode(mode),
    },

    meta: {
      request_id: randomUUID(),
      time_utc: new Date().toISOString(),
    }
  };
}

module.exports = { buildCloudEnvelope, normalizeMode, MODE_ENUM };
