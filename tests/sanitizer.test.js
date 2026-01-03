const fs = require("fs");
const { sanitizeText } = require("../src/sanitizer/sanitizeText");

test("no secrets survive sanitization", () => {
  const raw = fs.readFileSync("tests/sanitization/input_raw.txt", "utf8");
  const sanitized = sanitizeText(raw);

  const forbiddenPatterns = [
    /AKIA[0-9A-Z]{16}/,
    /arn:aws:/,
    /@/,
    /BEGIN PRIVATE KEY/,
    /\b\d{12}\b/,
  ];

  for (const pattern of forbiddenPatterns) {
    expect(pattern.test(sanitized)).toBe(false);
  }

  expect(sanitized).toContain("[SANITIZED:");
});

