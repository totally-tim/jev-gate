import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, resolveConfig, validateConfigDocument } from "./config.js";

test("empty documents resolve to the built-in defaults", () => {
  const config = resolveConfig(validateConfigDocument(null));
  assert.equal(config.model, "jev-latest");
  assert.ok(config.rules.length >= 7);
  assert.equal(config.rules.filter((rule) => rule.gate).length, 4);
  assert.equal(config.comment, true);
});

test("rule overrides replace gate and threshold", () => {
  const config = resolveConfig(
    validateConfigDocument({
      rules: { "danger-sensitive-area": { gate: false, threshold: 0.9 } },
    }),
  );
  const rule = config.rules.find((entry) => entry.name === "danger-sensitive-area");
  assert.equal(rule?.gate, false);
  assert.equal(rule?.threshold, 0.9);
});

test("unknown rule names and settings are rejected", () => {
  assert.throws(() => validateConfigDocument({ rules: { nonsense: { gate: true } } }), ConfigError);
  assert.throws(() => validateConfigDocument({ rules: { "breaking-change": { level: 1 } } }), ConfigError);
  assert.throws(() => validateConfigDocument({ model: 42 }), ConfigError);
  assert.throws(() => validateConfigDocument({ maxStateTokens: 100 }), ConfigError);
  assert.throws(() => validateConfigDocument({ rules: { "breaking-change": { threshold: 1.5 } } }), ConfigError);
  assert.throws(() => validateConfigDocument({ extra: true }), ConfigError);
});
