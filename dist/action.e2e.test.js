import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const ACTION_BUNDLE = fileURLToPath(new URL("./bundle/action.cjs", import.meta.url));
/** A mock that speaks just enough GitHub and TypeSafe for one action run. */
function startMockServer(state) {
    const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const send = (status, payload, contentType = "application/json") => {
                response.writeHead(status, { "content-type": contentType });
                response.end(typeof payload === "string" ? payload : JSON.stringify(payload));
            };
            if (url.pathname === "/v1/systemone" ||
                url.pathname === "/api/alpha/decisions") {
                state.paths.push(url.pathname);
                if (state.failProvider) {
                    send(401, { message: "bad key" });
                    return;
                }
                const parsed = JSON.parse(body);
                const answers = {};
                for (const [name, question] of Object.entries(parsed.questions)) {
                    const value = name === "danger-sensitive-area"
                        ? state.dangerProbability
                        : name === "breaking-change"
                            ? (state.breakingProbability ?? 0.05)
                            : 0.05;
                    answers[name] =
                        question.type === "choice"
                            ? { type: "choice", choice: name === "evidence" ? "R1" : "api", confidence: 1,
                                probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === (name === "evidence" ? "R1" : "api") ? 1 : 0])) }
                            : question.type === "noul"
                                ? { type: "noul", noul: value }
                                : { type: "score", score: value * 2, confidence: 0.9, probabilities: { "0": 1, "1": 0, "2": 0, "3": 0 } };
                }
                send(200, {
                    model: "jev-mock",
                    answers,
                    usage: { input_tokens: 1234, output_tokens: 0 },
                });
                return;
            }
            if (url.pathname === "/repos/o/r/pulls/3") {
                state.reads = (state.reads ?? 0) + 1;
                send(200, {
                    number: 3,
                    state: state.closed ? "closed" : "open",
                    title: "Change the login flow",
                    body: "Swaps the auth path.",
                    html_url: "https://example.test/o/r/pull/3",
                    commits: 2,
                    additions: 3,
                    deletions: 1,
                    changed_files: 1,
                    user: { login: "dev" },
                    base: {
                        ref: "main",
                        sha: "b".repeat(40),
                        repo: { full_name: "o/r" },
                    },
                    head: {
                        sha: ((state.moveHead && state.reads > 1) ||
                            (state.moveBeforePublication && state.reads > 3)
                            ? "c"
                            : "a").repeat(40),
                        repo: { full_name: "o/r" },
                    },
                });
                return;
            }
            if (url.pathname === "/repos/o/r/pulls/3/files") {
                send(200, [
                    {
                        filename: "src/auth.ts",
                        status: "modified",
                        additions: 2,
                        deletions: 1,
                        patch: state.missingPatch ? undefined : state.splitPatch
                            ? "@@ -1 +1 @@\n-old\n+new\n@@ -10,0 +11 @@\n+more\n"
                            : "@@ -1,2 +1,3 @@\n-old\n+new\n+more\n",
                    },
                ]);
                return;
            }
            if (url.pathname === "/repos/o/r/contents/.jev-gate.yml") {
                if (state.config)
                    send(200, state.config, "text/yaml");
                else
                    send(404, { message: "Not Found" });
                return;
            }
            if (url.pathname.startsWith("/repos/o/r/compare/")) {
                send(200, { merge_base_commit: { sha: "d".repeat(40) } });
                return;
            }
            if (url.pathname.startsWith("/repos/o/r/git/trees/")) {
                send(200, { truncated: false, tree: [{ path: "src/auth.ts", mode: "100644", type: "blob" }] });
                return;
            }
            if (url.pathname === "/repos/o/r/contents/src/auth.ts") {
                const ref = url.searchParams.get("ref");
                if (ref === "a".repeat(40))
                    send(200, "new\nmore\n", "text/plain");
                else if (ref === "d".repeat(40))
                    send(200, "old\n", "text/plain");
                else
                    send(400, { message: "expected pinned head or merge-base" });
                return;
            }
            if (url.pathname === "/repos/o/r/issues/3/comments" &&
                request.method === "GET") {
                send(200, []);
                return;
            }
            if (url.pathname === "/repos/o/r/issues/3/comments" &&
                request.method === "POST") {
                state.comments.push(JSON.parse(body).body);
                send(201, { id: 1 });
                return;
            }
            send(404, { message: `no mock for ${request.method} ${url.pathname}` });
        });
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            resolve({
                url: `http://127.0.0.1:${port}`,
                close: () => new Promise((done) => server.close(() => done())),
            });
        });
    });
}
async function runAction(state, options = {}) {
    const mock = await startMockServer(state);
    try {
        const dir = mkdtempSync(join(tmpdir(), "jev-gate-e2e-"));
        const eventPath = join(dir, "event.json");
        const outputPath = join(dir, "output.txt");
        const summaryPath = join(dir, "summary.md");
        writeFileSync(eventPath, JSON.stringify({
            ...(options.event === "workflow_dispatch" ? {} : { pull_request: { number: 3 } }),
            repository: { full_name: "o/r" },
        }));
        writeFileSync(outputPath, "");
        writeFileSync(summaryPath, "");
        let code = 0;
        let log = "";
        try {
            const result = await execFileAsync(process.execPath, [ACTION_BUNDLE], {
                env: {
                    ...process.env,
                    GITHUB_EVENT_NAME: options.event ?? "pull_request",
                    INPUT_PULL_REQUEST: options.pr ?? "",
                    GITHUB_EVENT_PATH: eventPath,
                    GITHUB_REPOSITORY: "o/r",
                    GITHUB_API_URL: mock.url,
                    TYPESAFE_BASE_URL: mock.url,
                    OPENROUTER_BASE_URL: mock.url,
                    ...(options.provider ? { INPUT_PROVIDER: options.provider } : {}),
                    INPUT_MODE: options.mode ?? "advisory",
                    INPUT_MAX_REQUESTS: options.maxRequests ?? "",
                    INPUT_API_KEY: "test-key",
                    INPUT_GITHUB_TOKEN: "test-token",
                    GITHUB_OUTPUT: outputPath,
                    GITHUB_STEP_SUMMARY: summaryPath,
                    RUNNER_TEMP: options.badTemp ? join(dir, "uncreated") : dir,
                },
                timeout: 30_000,
            });
            log = `${result.stdout}\n${result.stderr}`;
        }
        catch (error) {
            const failure = error;
            code = failure.code === undefined ? 1 : Number(failure.code);
            log = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`;
        }
        const outputs = readFileSync(outputPath, "utf8");
        const resultPath = outputs.split("\n").find(line => line.startsWith("result-path="))?.slice("result-path=".length);
        if (resultPath) {
            assert.equal(resultPath.startsWith(dir), true);
            assert.deepEqual(JSON.parse(readFileSync(resultPath, "utf8")), JSON.parse(outputs.split("\n").find(line => line.startsWith("result=")).slice(7)));
        }
        return {
            code,
            outputs: readFileSync(outputPath, "utf8"),
            summary: readFileSync(summaryPath, "utf8"),
            log,
        };
    }
    finally {
        await mock.close();
    }
}
test("bundled Action reviews with local-decide through the native endpoint", async () => {
    const state = {
        dangerProbability: 0.9,
        config: "provider: typesafe\nmodel: local-decide\nmode: advisory\n",
        comments: [], paths: [],
    };
    const result = await runAction(state, { event: "pull_request_target" });
    assert.equal(result.code, 0, result.log);
    assert.deepEqual(state.paths, ["/v1/systemone"]);
    const report = JSON.parse(result.outputs.split("\n").find((line) => line.startsWith("result=")).slice(7));
    assert.equal(report.health, "complete");
    assert.equal(report.model, "jev-mock");
    assert.equal(report.costUSD, 0);
    assert.equal(report.decisions.length, 5);
    assert.equal(state.comments.length, 1);
});
test("the bundled action posts a sticky comment and passes when gates clear", async () => {
    const state = { dangerProbability: 0.05, comments: [], paths: [] };
    const result = await runAction(state);
    assert.equal(result.code, 0, result.log);
    assert.equal(state.comments.length, 1, result.log);
    assert.ok(state.comments[0]?.includes("<!-- jev-gate:report -->"));
    assert.ok(!state.comments[0]?.includes("+more"), "the comment does not embed raw diff content");
    assert.ok(state.comments[0]?.includes("No open findings"));
    assert.ok(result.outputs.includes("passed=true"), result.log);
    assert.match(result.outputs, /result-path=/);
    assert.ok(result.summary.includes("JEV review"));
    assert.deepEqual(state.paths, ["/v1/systemone"]);
});
test("invalid policy publishes unavailable status without provider calls", async () => {
    const state = {
        dangerProbability: 0,
        comments: [],
        paths: [],
        config: "not-a-setting: true",
    };
    const r = await runAction(state);
    assert.equal(r.code, 2, r.log);
    assert.equal(state.paths.length, 0);
    assert.ok(state.comments[0]?.includes("invalid"));
    assert.ok(r.outputs.includes("passed=unavailable"));
});
test("the Action request budget override completes a limited review and rejects invalid limits", async () => {
    const state = {
        dangerProbability: 0,
        comments: [],
        paths: [],
        config: "maxRequests: 1",
        splitPatch: true,
    };
    const limited = await runAction(state);
    assert.equal(limited.code, 2, limited.log);
    assert.ok(limited.outputs.includes("health=partial"));
    assert.equal(state.paths.length, 1);
    state.paths = [];
    const complete = await runAction(state, { maxRequests: "2" });
    assert.equal(complete.code, 0, complete.log);
    assert.ok(complete.outputs.includes("health=complete"));
    assert.equal(state.paths.length, 2);
    for (const maxRequests of ["0", "501", "NaN"]) {
        state.paths = [];
        const invalid = await runAction(state, { maxRequests });
        assert.equal(invalid.code, 2, invalid.log);
        assert.ok(invalid.outputs.includes("health=unavailable"));
        assert.equal(state.paths.length, 0);
    }
});
test("required mode blocks configured findings and advisory mode preserves them", async () => {
    const state = {
        dangerProbability: 0,
        breakingProbability: 0.99,
        comments: [],
        paths: [],
    };
    const r = await runAction(state, { mode: "required" });
    assert.equal(r.code, 1, r.log);
    assert.ok(r.outputs.includes("health=complete"));
    assert.ok(r.outputs.includes("passed=false"));
});
test("the bundled Action uses base diagnostic policy and publishes follow-up without clearing its gate", async () => {
    const state = { dangerProbability: 0, breakingProbability: 0.99, comments: [], paths: [], config: "diagnostics:\n  enabled: true\n" };
    const result = await runAction(state, { mode: "required" });
    assert.equal(result.code, 1, result.log);
    assert.equal(state.paths.length, 3);
    assert.match(result.outputs, /passed=false/);
    assert.match(result.summary, /Compatibility follow-up: supported/);
    assert.match(state.comments[0], /Optional compatibility follow-up: \*\*complete\*\*/);
});
test("a head change while locating the prior comment prevents publication", async () => {
    const state = {
        dangerProbability: 0,
        comments: [],
        paths: [],
        moveBeforePublication: true,
    };
    const r = await runAction(state);
    assert.equal(r.code, 2, r.log);
    assert.equal(state.paths.length, 1);
    assert.equal(state.comments.length, 0);
});
test("the bundled action routes sensitive changes for review without blocking", async () => {
    const state = { dangerProbability: 0.9, comments: [], paths: [] };
    const result = await runAction(state);
    assert.equal(result.code, 0, result.log);
    assert.equal(state.comments.length, 1, result.log);
    assert.ok(state.comments[0]?.includes("danger-sensitive-area"));
    assert.ok(result.outputs.includes("status=needs-review"), result.log);
    assert.ok(!result.outputs.includes("failed-gates=danger-sensitive-area"), result.log);
});
test("the bundled action reaches the OpenRouter decisions endpoint when configured", async () => {
    const state = { dangerProbability: 0.05, comments: [], paths: [] };
    const result = await runAction(state, { provider: "openrouter" });
    assert.equal(result.code, 0, result.log);
    assert.equal(state.comments.length, 1, result.log);
    assert.deepEqual(state.paths, ["/api/alpha/decisions"]);
    assert.ok(result.outputs.includes("passed=true"), result.log);
});
test("provider failure produces an unavailable comment and a failing status", async () => {
    const state = {
        dangerProbability: 0,
        comments: [],
        paths: [],
        failProvider: true,
    };
    const r = await runAction(state);
    assert.equal(r.code, 2, r.log);
    assert.ok(r.outputs.includes("health=unavailable"));
    assert.ok(state.comments[0]?.includes("unavailable"));
});
test("a changed PR head prevents model calls and publication of stale results", async () => {
    const state = {
        dangerProbability: 0,
        comments: [],
        paths: [],
        moveHead: true,
    };
    const r = await runAction(state);
    assert.equal(r.code, 2, r.log);
    assert.equal(state.paths.length, 0);
    assert.equal(state.comments.length, 0);
});
test("manual dispatch reviews the requested open PR without overriding runner event variables", async () => {
    const state = { dangerProbability: 0.05, comments: [], paths: [] };
    const result = await runAction(state, { event: "workflow_dispatch", pr: "3" });
    assert.equal(result.code, 0, result.log);
    assert.equal(state.comments.length, 1);
    assert.equal(state.paths.length, 1);
    assert.match(result.outputs, /health=complete/);
});
test("the bundled Action recovers omitted GitHub patches before model review", async () => {
    const state = { dangerProbability: 0.05, comments: [], paths: [], missingPatch: true };
    const result = await runAction(state);
    assert.equal(result.code, 0, result.log);
    assert.equal(state.paths.length, 1);
    assert.equal(state.comments.length, 1);
    assert.match(result.outputs, /health=complete/);
});
test("manual dispatch refuses missing, malformed, and closed PRs before provider calls", async () => {
    for (const pr of ["", "0", "-3", "3/../../secrets", "3e0", "9007199254740993"]) {
        const state = { dangerProbability: 0, comments: [], paths: [] };
        const result = await runAction(state, { event: "workflow_dispatch", pr });
        assert.equal(result.code, 2, result.log);
        assert.equal(state.paths.length, 0);
        assert.equal(state.comments.length, 0);
        assert.equal(state.reads ?? 0, 0);
    }
    const state = { dangerProbability: 0, comments: [], paths: [], closed: true };
    const result = await runAction(state, { event: "workflow_dispatch", pr: "3" });
    assert.equal(result.code, 2, result.log);
    assert.equal(state.paths.length, 0);
    assert.equal(state.comments.length, 0);
});
test("a PR event cannot be redirected to another PR by an input", async () => {
    const state = { dangerProbability: 0, comments: [], paths: [] };
    const result = await runAction(state, { pr: "4" });
    assert.equal(result.code, 2, result.log);
    assert.equal(state.reads ?? 0, 0);
    assert.equal(state.comments.length, 0);
});
test("an unavailable optional artifact directory does not invalidate a completed review", async () => {
    const state = { dangerProbability: 0.05, comments: [], paths: [] };
    const result = await runAction(state, { badTemp: true });
    assert.equal(result.code, 0, result.log);
    assert.match(result.outputs, /passed=true/);
    assert.doesNotMatch(result.outputs, /result-path=|passed=unavailable/);
    assert.match(result.log, /optional JSON report file/);
    assert.equal(state.comments.length, 1);
});
