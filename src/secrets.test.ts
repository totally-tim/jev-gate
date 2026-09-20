import assert from "node:assert/strict";
import { test } from "node:test";
import { redactText } from "./secrets.js";
import { runReview } from "./review.js";
import { file, snapshot, endpoint } from "./test-fixtures.js";

test("unquoted environment assignments and quoted JSON credentials are withheld before any model call", async () => {
  const values = [
    "sk-" + "aB9_cD3eF5gH7jK2mN4pQ6",
    "aBcD1234".repeat(4),
    "qwertY1234".repeat(3),
  ];
  const lines = [
    `APP_MODEL_API_KEY=${values[0]}`,
    `SERVICE_AUTH_TOKEN=${values[1]}`,
    `{"password": "${values[2]}"}`,
  ];
  const patch = `@@ -0,0 +1,3 @@\n${lines.map((line) => `+${line}`).join("\n")}`;
  const calls: unknown[] = [];
  const result = await runReview({
    snapshot: snapshot([file(patch, ".env")]),
    apiKey: "test",
    fetchImpl: endpoint({}, calls),
  });
  for (const value of values) {
    assert.ok(!JSON.stringify(calls).includes(value));
    assert.ok(!JSON.stringify(result).includes(value));
  }
  assert.deepEqual(
    result.findings.filter((f) => f.source === "local").map((f) => f.startLine),
    [1, 2, 3],
  );
});

test("redaction preserves references and placeholders while recognizing standalone prefixed keys", () => {
  const safe =
    'api_key=process.env.SERVICE_PROVIDER_KEY\napi_key="example"\napi_key=${SERVICE_KEY}';
  assert.equal(redactText(safe), safe);
  const key = "sk-" + "Aa19".repeat(8);
  assert.ok(!redactText(`Authorization: ${key}`).includes(key));
  assert.equal(
    JSON.parse(redactText(`{"api_key":"${"k9".repeat(16)}"}`)).api_key,
    "[REDACTED]",
  );
});
