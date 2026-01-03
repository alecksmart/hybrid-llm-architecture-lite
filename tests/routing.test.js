const { routeTask, ROUTES } = require("../src/routing/routeTask");

test("offline requirement forces local", () => {
  const decision = routeTask({
    taskType: "analysis",
    requiresDeepReasoning: true,
    containsSensitiveData: false,
    offlineRequired: true,
    cloudAllowed: true,
  });

  expect(decision.route).toBe(ROUTES.LOCAL);
});

test("sensitive data forces local", () => {
  const decision = routeTask({
    taskType: "analysis",
    requiresDeepReasoning: true,
    containsSensitiveData: true,
    offlineRequired: false,
    cloudAllowed: true,
  });

  expect(decision.route).toBe(ROUTES.LOCAL);
});

test("deep reasoning with cloud allowed routes to cloud", () => {
  const decision = routeTask({
    taskType: "architecture",
    requiresDeepReasoning: true,
    containsSensitiveData: false,
    offlineRequired: false,
    cloudAllowed: true,
  });

  expect(decision.route).toBe(ROUTES.CLOUD);
});

test("no deep reasoning defaults to local", () => {
  const decision = routeTask({
    taskType: "summarization",
    requiresDeepReasoning: false,
    containsSensitiveData: false,
    offlineRequired: false,
    cloudAllowed: true,
  });

  expect(decision.route).toBe(ROUTES.LOCAL);
});

test("cloud not allowed forces local even for deep reasoning", () => {
  const decision = routeTask({
    taskType: "architecture",
    requiresDeepReasoning: true,
    containsSensitiveData: false,
    offlineRequired: false,
    cloudAllowed: false,
  });

  expect(decision.route).toBe(ROUTES.LOCAL);
});

