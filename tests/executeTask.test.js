jest.mock("../src/cloud/callBedrock", () => ({
  callBedrock: jest.fn(async () => "MOCK_CLOUD_RESPONSE"),
}));

const { executeTask } = require("../src/pipeline/executeTask");

test("local route never calls cloud", async () => {
  const result = await executeTask({
    rawInput: "Sensitive data here",
    routingHints: {
      requiresDeepReasoning: true,
      containsSensitiveData: true,
      offlineRequired: false,
      cloudAllowed: true,
    },
    modelId: "anthropic.claude-3-sonnet",
  });

  expect(result.route).toBe("local");
  expect(result.output).toBeNull();
});

test("cloud route produces output", async () => {
  const result = await executeTask({
    rawInput: "Design a generic routing algorithm.",
    routingHints: {
      requiresDeepReasoning: true,
      containsSensitiveData: false,
      offlineRequired: false,
      cloudAllowed: true,
      contextSummary: ["Hybrid LLM architecture"],
    },
    modelId: "anthropic.claude-3-sonnet",
  });

  expect(result.route).toBe("cloud");
  expect(result.output).toBe("MOCK_CLOUD_RESPONSE");
});

