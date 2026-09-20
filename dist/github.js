import { COMMENT_MARKER, parsePreviousOutcome } from "./render.js";
export class GitHubError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}
const API_VERSION = "2022-11-28";
/** A minimal GitHub REST client; only the calls this action needs. */
export class GitHubClient {
    token;
    fetchImpl;
    apiBase;
    commentAuthor;
    constructor(token, fetchImpl = fetch, apiBase = "https://api.github.com", commentAuthor = "github-actions[bot]") {
        this.token = token;
        this.fetchImpl = fetchImpl;
        this.apiBase = apiBase;
        this.commentAuthor = commentAuthor;
    }
    async request(path, init = {}) {
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
                const payload = (await response.json());
                if (payload.message)
                    message = payload.message;
            }
            catch {
                // Keep the status line when the body is not JSON.
            }
            throw new GitHubError(message, response.status);
        }
        return response;
    }
    async getPullRequest(owner, repo, number) {
        const pull = (await (await this.request(`/repos/${owner}/${repo}/pulls/${number}`)).json());
        return {
            owner,
            repo,
            number: pull.number,
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
    async listChangedFiles(owner, repo, number) {
        const files = [];
        for (let page = 1; page <= 30; page += 1) {
            const response = await this.request(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
            const batch = (await response.json());
            for (const file of batch) {
                const lines = file.patch?.split("\n");
                const incomplete = lines &&
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
            if (batch.length < 100)
                break;
        }
        return files;
    }
    /** Read a file at an exact ref; a missing file returns null. */
    async getFileAtRef(owner, repo, path, ref) {
        try {
            const response = await this.request(`/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`, { headers: { Accept: "application/vnd.github.raw+json" } });
            return await response.text();
        }
        catch (error) {
            if (error instanceof GitHubError && error.status === 404)
                return null;
            throw error;
        }
    }
    /** Find the sticky comment and its parsed previous run. */
    async findPreviousRun(owner, repo, number) {
        for (let page = 1; page <= 30; page += 1) {
            const response = await this.request(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
            const comments = (await response.json());
            for (const comment of comments) {
                if (comment.user?.login === this.commentAuthor &&
                    comment.user.type === "Bot" &&
                    comment.body?.startsWith(COMMENT_MARKER)) {
                    return {
                        id: comment.id,
                        previous: parsePreviousOutcome(comment.body),
                    };
                }
            }
            if (comments.length < 100)
                break;
        }
        return null;
    }
    /** Update the sticky comment in place, or create it on the first run. */
    async upsertComment(owner, repo, number, existingId, body) {
        if (existingId !== null) {
            await this.request(`/repos/${owner}/${repo}/issues/comments/${existingId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ body }),
            });
            return;
        }
        await this.request(`/repos/${owner}/${repo}/issues/${number}/comments`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body }),
        });
    }
}
