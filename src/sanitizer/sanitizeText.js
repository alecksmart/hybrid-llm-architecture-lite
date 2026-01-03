// src/sanitizer/sanitizeText.js

const PATTERNS = [
  { regex: /\b\d{12}\b/g, replacement: "[SANITIZED:ACCOUNT_ID]" },
  { regex: /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g, replacement: "[SANITIZED:EMAIL]" },
  { regex: /AKIA[0-9A-Z]{16}/g, replacement: "[SANITIZED:KEY]" },
  { regex: /arn:aws:[^\s]+/g, replacement: "[SANITIZED:ARN]" },
  {
    regex: /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g,
    replacement: "[SANITIZED:PRIVATE_KEY]",
  },
  {
    regex: /eyJ[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+/g,
    replacement: "[SANITIZED:JWT]",
  },
];

function sanitizeText(input) {
  let output = input;

  for (const { regex, replacement } of PATTERNS) {
    output = output.replace(regex, replacement);
  }

  return output;
}

module.exports = {
  sanitizeText,
  PATTERNS,
};

