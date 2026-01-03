const { routeTask, ROUTES } = require("./routeTask");
const { getSystemLoad } = require("../system/getSystemLoad");

const LOAD_FORCE_CLOUD_THRESHOLD =
  Number(process.env.LOAD_FORCE_CLOUD_THRESHOLD || 0.75);

function routeWithLoad(hints) {
  const baseDecision = routeTask(hints);

  // If base routing already chose local for policy reasons, respect it
  if (baseDecision.route === ROUTES.LOCAL) {
    return {
      ...baseDecision,
      loadAware: false,
    };
  }

  const { load1, cores, loadRatio } = getSystemLoad();

  if (
    loadRatio >= LOAD_FORCE_CLOUD_THRESHOLD &&
    hints.cloudAllowed === true
  ) {
    return {
      route: ROUTES.CLOUD,
      reason: `High load (${load1.toFixed(2)}/${cores})`,
      loadAware: true,
    };
  }

  return {
    ...baseDecision,
    loadAware: false,
  };
}

module.exports = { routeWithLoad };

