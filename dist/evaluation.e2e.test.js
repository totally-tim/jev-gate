import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { promisify } from "node:util";
const exec = promisify(execFile);
for (const missing of [false, true])
    test(`evaluation entrypoint measures screening replay (missing answers: ${missing})`, async (t) => {
        let requests = 0;
        const server = createServer(async (req, res) => {
            res.setHeader("content-type", "application/json");
            if (req.method === "GET") {
                assert.equal(req.url, "/passthrough/models");
                res.end(JSON.stringify({ models: [{ id: "jev-test" }] }));
                return;
            }
            assert.equal(req.url, "/passthrough/systemone");
            const chunks = [];
            for await (const chunk of req)
                chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString());
            requests++;
            const answers = Object.fromEntries(Object.entries(body.questions).map(([name, question]) => {
                const q = question;
                if (q.type === "noul") {
                    return [name, { type: "noul", noul: 0.9 }];
                }
                if (q.type === "choice") {
                    const choice = name === "evidence" ? "R1" : "api";
                    return [name, { type: "choice", choice, confidence: 1,
                            probabilities: Object.fromEntries(Object.keys(q.criteria).map(key => [key, key === choice ? 1 : 0])) }];
                }
                return [name, { type: "score", score: 2, confidence: 1, probabilities: { "0": 0, "1": 0, "2": 1, "3": 0 } }];
            }));
            res.end(JSON.stringify({ model: "jev-test", answers: missing ? {} : answers, usage: { input_tokens: 10, output_tokens: 0 } }));
        });
        await new Promise(done => server.listen(0, "127.0.0.1", done));
        t.after(() => new Promise(done => server.close(() => done())));
        const { port } = server.address();
        const result = await exec(process.execPath, ["scripts/evaluate-diagnostics.mjs"], {
            env: { ...process.env, TYPESAFE_API_KEY: "test", EVAL_ENDPOINT: `http://127.0.0.1:${port}/passthrough/systemone`, EVAL_MODEL: "jev-test", EVAL_SPLIT: "tune", EVAL_REPEAT: "1" },
        }).then(r => ({ ...r, code: 0 }), (e) => e);
        const report = JSON.parse(result.stdout);
        assert.equal(result.code, missing ? 2 : 0, JSON.stringify(report.records.map((row) => ({ replay: row.screeningReplayed, errors: row.errors, diagnostic: row.diagnostic }))));
        assert.equal(report.valid, !missing);
        assert.equal(report.totalRequests, requests);
        assert.equal(report.records.length, 4);
        for (const row of report.records) {
            assert.equal(row.screeningReplayed, true);
            assert.equal(row.replayHits, 1);
            if (!missing) {
                assert.equal(row.invariants, true);
                assert.equal(row.screening[0].value, 0.9);
            }
        }
        assert.equal(requests, missing ? 4 : 12);
    });
