const { buildCloudEnvelope } = require("../src/envelope/buildCloudEnvelope");
const { validateEnvelope } = require("../src/envelope/validateEnvelope");

test("valid envelope passes schema validation (default MODE=EXPLAIN)", () => {
  const env = buildCloudEnvelope({
    sanitizedProblem: "Explain how to reduce verbosity in a hybrid proxy without architecture unless asked.",
    contextSummary: [
      "Hybrid local + cloud LLM system",
      "Cloud used only for deep reasoning",
    ],
    modelId: "anthropic.claude-3-sonnet",
  });

  expect(env.response_mode).toBeDefined();
  expect(env.response_mode.mode).toBe("MODE=EXPLAIN");
  expect(env.task.deliverable_type).toBe("explain");
  expect(env.output_format_required.sections).toEqual(["answer"]);
  expect(() => validateEnvelope(env)).not.toThrow();
});

test("MODE=DESIGN produces full structured sections", () => {
  const env = buildCloudEnvelope({
    sanitizedProblem: "Design a secure routing layer using sanitized inputs only.",
    contextSummary: ["Hybrid local + cloud LLM system"],
    modelId: "anthropic.claude-3-sonnet",
    responseMode: "MODE=DESIGN",
  });

  expect(env.response_mode.mode).toBe("MODE=DESIGN");
  expect(env.task.deliverable_type).toBe("design");
  expect(env.output_format_required.sections).toEqual([
    "facts_given",
    "assumptions",
    "recommendations",
    "risks_tradeoffs",
    "tests",
    "next_steps",
  ]);
  expect(() => validateEnvelope(env)).not.toThrow();
});

test("invalid envelope is rejected", () => {
  const env = buildCloudEnvelope({
    sanitizedProblem: "short",
    contextSummary: [],
    modelId: "anthropic.claude-3-sonnet",
  });

  env.data_sensitivity = "LOW";

  expect(() => validateEnvelope(env)).toThrow();
});
