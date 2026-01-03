const fs = require("fs");
const path = require("path");

const STATE_FILE =
  process.env.COST_STATE_FILE || "/tmp/hybrid_proxy_cost.json";

const DAILY_LIMIT = Number(process.env.CLOUD_DAILY_LIMIT || 50);
const MONTHLY_LIMIT = Number(process.env.CLOUD_MONTHLY_LIMIT || 1000);

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { day: {}, month: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function monthKey() {
  return new Date().toISOString().slice(0, 7);
}

function assertCostAllowed() {
  const state = loadState();

  const day = todayKey();
  const month = monthKey();

  state.day[day] = state.day[day] || 0;
  state.month[month] = state.month[month] || 0;

  if (state.day[day] >= DAILY_LIMIT) {
    throw new Error("Daily cloud request limit exceeded");
  }

  if (state.month[month] >= MONTHLY_LIMIT) {
    throw new Error("Monthly cloud request limit exceeded");
  }

  state.day[day]++;
  state.month[month]++;

  saveState(state);
}

module.exports = { assertCostAllowed };

