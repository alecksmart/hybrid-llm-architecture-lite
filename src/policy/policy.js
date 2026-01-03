// src/policy/policy.js
//
// Deterministic policy enforcement for hybrid proxy.
// Goals:
// - Never allow cloud when OFFLINE_REQUIRED=true
// - Never allow cloud when CLOUD_ALLOWED=false
// - Block cloud when raw user text appears sensitive (unless explicitly allowed)
// - Optional: allow/deny user overrides (/cloud, /local)
//
// This module is intentionally conservative and explainable.

const DEFAULTS = Object.freeze({
  allowSensitiveCloud: (process.env.ALLOW_SENSITIVE_CLOUD || "false") === "true",
  allowUserOverrides: (process.env.ALLOW_USER_OVERRIDES || "true") === "true",
});

function looksSensitive(text) {
  const patterns = [
    /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
    /\bASIA[0-9A-Z]{16}\b/, // STS key id
    /-----BEGIN (?:RSA |EC |)?PRIVATE KEY-----/i,
    /\barn:aws:[^\s]+/i,
    /\b\d{12}\b/, // AWS account id
    /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/, // email
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/, // IPv4
    /\beyJ[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+\b/, // JWT-like
    /\bssh-rsa\b|\bssh-ed25519\b/i,
    /\bpassword\s*[:=]/i,
    /\bsecret\s*[:=]/i,
    /\btoken\s*[:=]/i,
  ];
  return patterns.some((r) => r.test(text));
}

/**
 * Determine whether cloud is allowed at all, and why.
 * Returns { allowed: boolean, reason?: string, sensitive: boolean }
 */
function evaluateCloudPolicy({ offlineRequired, cloudAllowed, rawUserText }) {
  const sensitive = looksSensitive(rawUserText || "");

  if (offlineRequired === true) {
    return { allowed: false, reason: "Offline required", sensitive };
  }

  if (cloudAllowed !== true) {
    return { allowed: false, reason: "Cloud disabled by policy", sensitive };
  }

  if (sensitive && !DEFAULTS.allowSensitiveCloud) {
    return { allowed: false, reason: "Sensitive content detected in raw input", sensitive };
  }

  return { allowed: true, sensitive };
}

/**
 * Enforce whether user overrides (/cloud, /local) are permitted.
 * Returns { allow: boolean, reason?: string }
 */
function evaluateOverridePolicy() {
  if (!DEFAULTS.allowUserOverrides) {
    return { allow: false, reason: "User overrides disabled by policy" };
  }
  return { allow: true };
}

module.exports = {
  looksSensitive,
  evaluateCloudPolicy,
  evaluateOverridePolicy,
};
