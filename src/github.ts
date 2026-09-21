import type { DiffFile, PullRequestContext } from "./types.js";
import { COMMENT_MARKER, parsePreviousOutcome } from "./render.js";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface GitHubFilePayload {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  previous_filename?: string;
}

interface GitHubPullPayload {
  state?: string;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  commits: number;
  additions: number;
  deletions: number;
  changed_files: number;
  user: { login: string } | null;
  base: { ref: string; sha: string; repo: { full_name: string } | null };
  head: { sha: string; repo: { full_name: string } | null };
}

const API_VERSION = "2022-11-28";

interface FileReadOptions {
  regularOnly?: boolean;
  onBytes?: (count: number) => void;
}

async function readLimitedText(response: Response, maxBytes: number, onBytes?: (count: number) => void): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("GitHub returned no file body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      onBytes?.(value.byteLength);
      if (size > maxBytes) throw new Error("GitHub file exceeds the collection byte limit");
      if (value.includes(0)) throw new Error("Binary file has no supported textual review");
      chunks.push(value);
    }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  } finally {
    await reader.cancel();
  }
}

/** A minimal GitHub REST client; only the calls this action needs. */
export class GitHubClient {
  private readonly trees = new Map<string, Promise<Array<{ path: string; type: string; mode: string }>>>();

  private async requireRegularFile(owner: string, repo: string, path: string, ref: string): Promise<void> {
    const key = `${owner}/${repo}@${ref}`;
    let tree = this.trees.get(key);
    if (!tree) {
      tree = (async () => {
        const response = await this.request(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
        const data = JSON.parse(await readLimitedText(response, 8 * 1024 * 1024)) as {
          truncated?: boolean; tree?: Array<{ path: string; type: string; mode: string }>;
        };
        if (data.truncated !== false || !Array.isArray(data.tree))
          throw new Error("GitHub tree is incomplete; regular-file identity could not be verified");
        return data.tree;
      })();
      this.trees.set(key, tree);
    }
    const entry = (await tree).find(entry => entry.path === path);
    if (!entry || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
      throw new Error("Recovery supports regular files only; symlinks and submodules are not followed");
  }

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBase = "https://api.github.com",
    private readonly commentAuthor = "github-actions[bot]",
  ) {}

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(15_000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "User-Agent": "jev-gate",
        "X-GitHub-Api-Version": API_VERSION,
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try {
        const payload = (await response.json()) as { message?: string };
        if (payload.message) message = payload.message;
      } catch {
        // Keep the status line when the body is not JSON.
      }
      throw new GitHubError(message, response.status);
    }
    return response;
  }

  async getPullRequest(
    owner: string,
    repo: string,
    number: number,
  ): Promise<PullRequestContext> {
    const pull = (await (
      await this.request(`/repos/${owner}/${repo}/pulls/${number}`)
    ).json()) as GitHubPullPayload;
    return {
      owner,
      repo,
      number: pull.number,
      state: pull.state,
      title: pull.title,
      body: pull.body ?? "",
      author: pull.user?.login ?? "unknown",
      baseRef: pull.base.ref,
      baseSha: pull.base.sha,
      headSha: pull.head.sha,
      changedFiles: pull.changed_files,
      additions: pull.additions,
      deletions: pull.deletions,
      commits: pull.commits,
      htmlUrl: pull.html_url,
    };
  }

  async listChangedFiles(
    owner: string,
    repo: string,
    number: number,
  ): Promise<DiffFile[]> {
    const files: DiffFile[] = [];
    for (let page = 1; page <= 30; page += 1) {
      const response = await this.request(
        `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
      );
      const batch = (await response.json()) as GitHubFilePayload[];
      for (const file of batch) {
        const lines = file.patch?.split("\n");
        const incomplete =
          lines &&
          (lines.filter((line) => line.startsWith("+")).length !==
            file.additions ||
            lines.filter((line) => line.startsWith("-")).length !==
              file.deletions);
        files.push({
          path: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          patch: file.patch ?? null,
          previousPath: file.previous_filename,
          patchWarning: incomplete
            ? "GitHub patch line counts do not match the declared change; the patch may be incomplete"
            : undefined,
        });
      }
      if (batch.length < 100) break;
    }
    return files;
  }

  /** Read a file at an exact ref; a missing file returns null. */
  async getFileAtRef(
    owner: string,
    repo: string,
    path: string,
    ref: string,
    maxBytes = 2 * 1024 * 1024,
    options: FileReadOptions = {},
  ): Promise<string | null> {
    try {
      if (options.regularOnly) await this.requireRegularFile(owner, repo, path, ref);
      const response = await this.request(
        `/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
        { headers: { Accept: "application/vnd.github.raw+json" } },
      );
      return await readLimitedText(response, maxBytes, options.onBytes);
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  async getMergeBase(owner: string, repo: string, base: string, head: string): Promise<string> {
    const response = await this.request(`/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`);
    const data = await response.json() as { merge_base_commit?: { sha?: string } };
    const sha = data.merge_base_commit?.sha;
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("GitHub returned no valid merge-base revision");
    return sha;
  }

  /** Find the sticky comment and its parsed previous run. */
  async findPreviousRun(
    owner: string,
    repo: string,
    number: number,
  ): Promise<{
    id: number;
    previous: ReturnType<typeof parsePreviousOutcome>;
  } | null> {
    for (let page = 1; page <= 30; page += 1) {
      const response = await this.request(
        `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100&page=${page}`,
      );
      const comments = (await response.json()) as Array<{
        id: number;
        body?: string;
        user?: { login?: string; type?: string };
      }>;
      for (const comment of comments) {
        if (
          comment.user?.login === this.commentAuthor &&
          comment.user.type === "Bot" &&
          comment.body?.startsWith(COMMENT_MARKER)
        ) {
          return {
            id: comment.id,
            previous: parsePreviousOutcome(comment.body),
          };
        }
      }
      if (comments.length < 100) break;
    }
    return null;
  }

  /** Update the sticky comment in place, or create it on the first run. */
  async upsertComment(
    owner: string,
    repo: string,
    number: number,
    existingId: number | null,
    body: string,
  ): Promise<void> {
    if (existingId !== null) {
      await this.request(
        `/repos/${owner}/${repo}/issues/comments/${existingId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        },
      );
      return;
    }
    await this.request(`/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
  }
}
