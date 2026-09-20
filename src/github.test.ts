import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubClient } from "./github.js";
import { COMMENT_MARKER } from "./render.js";
import { localContext, makeSnapshot } from "./snapshot.js";
import { resolveConfig } from "./config.js";
import { runReview } from "./review.js";
import { endpoint } from "./test-fixtures.js";
test("a truncated GitHub patch cannot become complete coverage", async () => {
  const c = new GitHubClient(
    "test",
    async () =>
      new Response(
        JSON.stringify([
          {
            filename: "a.ts",
            status: "modified",
            additions: 4,
            deletions: 1,
            patch: "@@ -1 +1,4 @@\n-old\n+one",
          },
        ]),
      ),
  );
  const files = await c.listChangedFiles("o", "r", 1);
  const result = await runReview({
    snapshot: makeSnapshot(localContext(files), files, resolveConfig({})),
    apiKey: "test",
    fetchImpl: endpoint(),
  });
  assert.equal(result.health, "partial");
  assert.ok(result.coverage.warnings.some((w) => w.includes("incomplete")));
});
test("pagination continues beyond 1000 files", async () => {
  let page = 0;
  const c = new GitHubClient("test", async () => {
    page++;
    return new Response(
      JSON.stringify(
        Array.from({ length: page <= 10 ? 100 : 1 }, (_, i) => ({
          filename: `${page}-${i}`,
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: "+a",
        })),
      ),
    );
  });
  assert.equal((await c.listChangedFiles("o", "r", 1)).length, 1001);
  assert.equal(page, 11);
});
test("sticky comments must belong to the expected bot", async () => {
  const c = new GitHubClient(
    "test",
    async () =>
      new Response(
        JSON.stringify([
          {
            id: 1,
            user: { login: "attacker", type: "User" },
            body: COMMENT_MARKER,
          },
          {
            id: 2,
            user: { login: "other[bot]", type: "Bot" },
            body: COMMENT_MARKER,
          },
          {
            id: 3,
            user: { login: "github-actions[bot]", type: "Bot" },
            body: COMMENT_MARKER,
          },
        ]),
      ),
  );
  assert.equal((await c.findPreviousRun("o", "r", 1))?.id, 3);
});
