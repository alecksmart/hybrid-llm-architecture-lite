const os = require("os");

function getSystemLoad() {
  const [load1] = os.loadavg();
  const cores = os.cpus().length;

  return {
    load1,
    cores,
    loadRatio: cores > 0 ? load1 / cores : 0,
  };
}

module.exports = { getSystemLoad };

