const { chunkText } = require("../src/proxy/openaiProxyServer"); // export it

test("chunkText yields deterministic parts", () => {
  const text = "a".repeat(450);
  const parts = Array.from(chunkText(text, 200));
  expect(parts.length).toBe(3);
  expect(parts[0].length).toBe(200);
  expect(parts[1].length).toBe(200);
  expect(parts[2].length).toBe(50);
});

