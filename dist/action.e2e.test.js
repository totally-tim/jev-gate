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
                        question.type === "noul"
                            ? { type: "noul", noul: value }
                            : { type: "score", score: value * 2, confidence: 0.9 };
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
                        patch: state.splitPatch
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
            pull_request: { number: 3 },
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
                    GITHUB_EVENT_NAME: "pull_request",
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
test("the bundled action posts a sticky comment and passes when gates clear", async () => {
    const state = { dangerProbability: 0.05, comments: [], paths: [] };
    const result = await runAction(state);
    assert.equal(result.code, 0, result.log);
    assert.equal(state.comments.length, 1, result.log);
    assert.ok(state.comments[0]?.includes("<!-- jev-gate:report -->"));
    assert.ok(!state.comments[0]?.includes("+more"), "the comment does not embed raw diff content");
    assert.ok(state.comments[0]?.includes("No open findings"));
    assert.ok(result.outputs.includes("passed=true"), result.log);
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
