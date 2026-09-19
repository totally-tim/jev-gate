import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, resolveConfig, validateConfigDocument } from "./config.js";
test("empty documents resolve to the built-in defaults", () => {
    const config = resolveConfig(validateConfigDocument(null));
    assert.equal(config.model, "jev-latest");
    assert.ok(config.rules.length >= 7);
    assert.equal(config.rules.filter((rule) => rule.gate).length, 4);
    assert.equal(config.comment, true);
    assert.equal(config.borderlineMargin, 0.1);
});
test("rule overrides replace gate and threshold", () => {
    const config = resolveConfig(validateConfigDocument({
        rules: { "danger-sensitive-area": { gate: false, threshold: 0.9 } },
    }));
    const rule = config.rules.find((entry) => entry.name === "danger-sensitive-area");
    assert.equal(rule?.gate, false);
    assert.equal(rule?.threshold, 0.9);
});
test("providers select the default model and validate their settings", () => {
    const typesafe = resolveConfig(validateConfigDocument({}));
    assert.equal(typesafe.provider, "typesafe");
    assert.equal(typesafe.model, "jev-latest");
    const openrouter = resolveConfig(validateConfigDocument({ provider: "openrouter" }));
    assert.equal(openrouter.model, "~typesafe/jev-latest");
    const pinned = resolveConfig(validateConfigDocument({ provider: "openrouter", model: "typesafe/jev-1.13" }));
    assert.equal(pinned.model, "typesafe/jev-1.13");
    const withSettings = resolveConfig(validateConfigDocument({
        provider: "openrouter",
        openrouter: { referer: "https://example.test", title: "example" },
    }));
    assert.deepEqual(withSettings.openrouter, { referer: "https://example.test", title: "example" });
    assert.throws(() => validateConfigDocument({ provider: "gemini" }), ConfigError);
    assert.throws(() => validateConfigDocument({ openrouter: { referer: "" } }), ConfigError);
    assert.throws(() => validateConfigDocument({ openrouter: { site: "example" } }), ConfigError);
});
test("edge thresholds produce warnings instead of errors", () => {
    const warnings = [];
    const doc = validateConfigDocument({ rules: { "breaking-change": { threshold: 0 } } }, warnings);
    assert.equal(doc.rules?.["breaking-change"]?.threshold, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /breaking-change/);
    const second = [];
    validateConfigDocument({ rules: { "comment-drift": { threshold: 1 } } }, second);
    assert.equal(second.length, 1);
    const clean = [];
    validateConfigDocument({ rules: { "breaking-change": { threshold: 0.6 } } }, clean);
    assert.deepEqual(clean, []);
});
test("borderlineMargin accepts the sane band and rejects the rest", () => {
    const config = resolveConfig(validateConfigDocument({ borderlineMargin: 0.25 }));
    assert.equal(config.borderlineMargin, 0.25);
    assert.equal(resolveConfig(validateConfigDocument({ borderlineMargin: 0 })).borderlineMargin, 0);
    assert.throws(() => validateConfigDocument({ borderlineMargin: 0.31 }), ConfigError);
    assert.throws(() => validateConfigDocument({ borderlineMargin: -0.1 }), ConfigError);
    assert.throws(() => validateConfigDocument({ borderlineMargin: "0.1" }), ConfigError);
});
test("unknown rule names and settings are rejected", () => {
    assert.throws(() => validateConfigDocument({ rules: { nonsense: { gate: true } } }), ConfigError);
    assert.throws(() => validateConfigDocument({ rules: { "breaking-change": { level: 1 } } }), ConfigError);
    assert.throws(() => validateConfigDocument({ model: 42 }), ConfigError);
    assert.throws(() => validateConfigDocument({ maxStateTokens: 100 }), ConfigError);
    assert.throws(() => validateConfigDocument({ rules: { "breaking-change": { threshold: 1.5 } } }), ConfigError);
    assert.throws(() => validateConfigDocument({ extra: true }), ConfigError);
});
