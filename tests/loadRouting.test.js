const os = require("os");
jest.mock("os");

const { routeWithLoad } = require("../src/routing/routeWithLoad");
const { ROUTES } = require("../src/routing/routeTask");

test("high load promotes cloud", () => {
  os.loadavg.mockReturnValue([8, 0, 0]);
  os.cpus.mockReturnValue(new Array(8).fill({}));

  const decision = routeWithLoad({
    requiresDeepReasoning: true,
    containsSensitiveData: false,
    offlineRequired: false,
    cloudAllowed: true,
  });

  expect(decision.route).toBe(ROUTES.CLOUD);
  expect(decision.loadAware).toBe(true);
});

