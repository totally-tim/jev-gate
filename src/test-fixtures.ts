import { resolveConfig } from "./config.js";
import { localContext, makeSnapshot } from "./snapshot.js";
import type { ConfigDocument, DiffFile, ReviewOutcome } from "./types.js";
import type { Fetch } from "@typesafe-ai/sdk";
export const file = (
  patch = "@@ -1 +1 @@\n-old\n+new\n",
  path = "src/auth.ts",
): DiffFile => ({
  path,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch,
});
export const snapshot = (
  files: DiffFile[] = [file()],
  config: ConfigDocument = {},
) =>
  makeSnapshot(
    localContext(files, { headSha: "a".repeat(40), baseSha: "b".repeat(40) }),
    files,
    resolveConfig(config),
  );
export const endpoint =
  (
    overrides: Record<string, number | null> = {},
    calls: Array<unknown> = [],
  ): Fetch =>
  async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      questions: Record<string, { type: string }>;
    };
    calls.push(body);
    const answers = Object.fromEntries(
      Object.entries(body.questions)
        .filter(([name]) => overrides[name] !== null)
        .map(([name, q]) => [
          name,
          q.type === "noul"
            ? { type: "noul", noul: overrides[name] ?? 0.01 }
            : {
                type: "score",
                score: (overrides[name] ?? 0.01) * 2,
                confidence: 0.9,
              },
        ]),
    );
    return new Response(
      JSON.stringify({
        model: "jev-test",
        answers,
        usage: { input_tokens: 100, output_tokens: 0 },
      }),
      { status: 200 },
    );
  };
