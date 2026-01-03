// src/routing/routeTask.js

const ROUTES = {
  LOCAL: "local",
  CLOUD: "cloud",
};

function routeTask({
  taskType,
  requiresDeepReasoning,
  containsSensitiveData,
  offlineRequired,
  cloudAllowed,
}) {
  // HARD BLOCKS (non-negotiable)
  if (offlineRequired === true) {
    return {
      route: ROUTES.LOCAL,
      reason: "Offline required",
    };
  }

  if (containsSensitiveData === true) {
    return {
      route: ROUTES.LOCAL,
      reason: "Sensitive data present",
    };
  }

  if (cloudAllowed !== true) {
    return {
      route: ROUTES.LOCAL,
      reason: "Cloud usage not allowed",
    };
  }

  // POSITIVE CLOUD INTENT
  if (requiresDeepReasoning === true) {
    return {
      route: ROUTES.CLOUD,
      reason: "Deep reasoning requested",
    };
  }

  // DEFAULT SAFE PATH
  return {
    route: ROUTES.LOCAL,
    reason: "Default to local execution",
  };
}

module.exports = {
  routeTask,
  ROUTES,
};

