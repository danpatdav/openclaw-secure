import type { Socket } from "node:net";
import { createHash } from "node:crypto";
import { z } from "zod";
import { log as proxyLog } from "./logger";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "danpatdav/openclaw-secure";
const GITHUB_API = "https://api.github.com";

// --- Schema ---

export const soulPrRequestSchema = z.object({
  magnitude: z.enum(["minor", "moderate", "significant"]),
  justification: z.string().min(10).max(2000),
  diff_description: z.string().min(1).max(1000),
  proposed_soul: z.string().min(50).max(10000),
  cycle_num: z.number().int().nonnegative(),
});

export type SoulPrRequest = z.infer<typeof soulPrRequestSchema>;

// --- Helpers ---

function sendResponse(socket: Socket, status: number, statusText: string, body: string): void {
  const bodyBytes = new TextEncoder().encode(body);
  socket.write(
    `HTTP/1.1 ${status} ${statusText}\r\nContent-Type: application/json\r\nContent-Length: ${bodyBytes.byteLength}\r\nConnection: close\r\n\r\n`
  );
  socket.write(bodyBytes);
  socket.end();
}

// Safe branch name: soul-reflection-{cycleNum}-{YYYYMMDD-HHmmss}
export function buildBranchName(cycleNum: number): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T.]/g, "").slice(0, 14); // 20260302160000
  return `soul-reflection-${cycleNum}-${ts}`;
}

async function githubApi(path: string, method: string, body?: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// --- GitHub PR Creation ---

async function createSoulPr(req: SoulPrRequest): Promise<{ pr_url: string; branch: string }> {
  const branchName = buildBranchName(req.cycle_num);
  const [owner, repo] = GITHUB_REPO.split("/");

  // Normalize: ensure trailing newline
  const soulContent = req.proposed_soul.endsWith("\n") ? req.proposed_soul : req.proposed_soul + "\n";

  // Compute checksum from exact content being committed
  const checksum = createHash("sha256").update(soulContent, "utf-8").digest("hex") + "\n";

  // 1. Get main branch commit SHA
  const mainRef = await githubApi(`/repos/${owner}/${repo}/git/ref/heads/main`, "GET");
  if (!mainRef.ok) {
    throw new Error(`Failed to get main branch ref: ${mainRef.status}`);
  }
  const baseCommitSha = mainRef.data.object.sha;

  // 2. Get the base tree SHA
  const baseCommit = await githubApi(`/repos/${owner}/${repo}/git/commits/${baseCommitSha}`, "GET");
  if (!baseCommit.ok) {
    throw new Error(`Failed to get base commit: ${baseCommit.status}`);
  }
  const baseTreeSha = baseCommit.data.tree.sha;

  // 3. Create blobs for both files
  const soulBlob = await githubApi(`/repos/${owner}/${repo}/git/blobs`, "POST", {
    content: Buffer.from(soulContent, "utf-8").toString("base64"),
    encoding: "base64",
  });
  if (!soulBlob.ok) {
    throw new Error(`Failed to create SOUL blob: ${soulBlob.status}`);
  }

  const checksumBlob = await githubApi(`/repos/${owner}/${repo}/git/blobs`, "POST", {
    content: Buffer.from(checksum, "utf-8").toString("base64"),
    encoding: "base64",
  });
  if (!checksumBlob.ok) {
    throw new Error(`Failed to create checksum blob: ${checksumBlob.status}`);
  }

  // 4. Create tree with both files
  const tree = await githubApi(`/repos/${owner}/${repo}/git/trees`, "POST", {
    base_tree: baseTreeSha,
    tree: [
      { path: "openclaw/SOUL.md", mode: "100644", type: "blob", sha: soulBlob.data.sha },
      { path: ".soul-checksum", mode: "100644", type: "blob", sha: checksumBlob.data.sha },
    ],
  });
  if (!tree.ok) {
    throw new Error(`Failed to create tree: ${tree.status}`);
  }

  // 5. Create commit
  const commitMsg = `soul: ${req.magnitude} reflection update (cycle ${req.cycle_num})\n\n${req.justification}`;
  const commit = await githubApi(`/repos/${owner}/${repo}/git/commits`, "POST", {
    message: commitMsg,
    tree: tree.data.sha,
    parents: [baseCommitSha],
  });
  if (!commit.ok) {
    throw new Error(`Failed to create commit: ${commit.status}`);
  }

  // 6. Create branch pointing to new commit
  const branchRef = await githubApi(`/repos/${owner}/${repo}/git/refs`, "POST", {
    ref: `refs/heads/${branchName}`,
    sha: commit.data.sha,
  });
  if (!branchRef.ok) {
    throw new Error(`Failed to create branch: ${branchRef.status} ${JSON.stringify(branchRef.data)}`);
  }

  // 5. Create PR
  const prBody = `## Soul Reflection (Cycle ${req.cycle_num})

**Magnitude:** ${req.magnitude}

### Justification
${req.justification}

### Changes
${req.diff_description}

---
*Proposed by DanielsClaw during quiet reflection mode. Requires human review before merge.*`;

  const pr = await githubApi(`/repos/${owner}/${repo}/pulls`, "POST", {
    title: `soul: ${req.magnitude} update from reflection cycle ${req.cycle_num}`,
    body: prBody,
    head: branchName,
    base: "main",
  });
  if (!pr.ok) {
    throw new Error(`Failed to create PR: ${pr.status} ${JSON.stringify(pr.data)}`);
  }

  return { pr_url: pr.data.html_url, branch: branchName };
}

// --- Handler ---

export async function handleGithubRequest(
  socket: Socket,
  method: string,
  path: string,
  body?: Buffer,
): Promise<void> {
  if (method !== "POST") {
    sendResponse(socket, 405, "Method Not Allowed", JSON.stringify({ error: "Only POST allowed" }));
    return;
  }

  if (path !== "/github/soul-pr") {
    sendResponse(socket, 404, "Not Found", JSON.stringify({ error: "Not Found" }));
    return;
  }

  if (!GITHUB_TOKEN) {
    proxyLog({
      timestamp: new Date().toISOString(),
      method: "POST",
      hostname: "github-handler",
      port: 0,
      path: "/github/soul-pr",
      allowed: false,
      sanitized: false,
      duration_ms: 0,
      blocked_reason: "GITHUB_TOKEN not configured",
    });
    sendResponse(socket, 503, "Service Unavailable", JSON.stringify({ error: "GitHub integration not configured" }));
    return;
  }

  if (!body || body.length === 0) {
    sendResponse(socket, 400, "Bad Request", JSON.stringify({ error: "Empty body" }));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf-8"));
  } catch {
    sendResponse(socket, 400, "Bad Request", JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const validation = soulPrRequestSchema.safeParse(parsed);
  if (!validation.success) {
    const errors = validation.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
    sendResponse(socket, 400, "Bad Request", JSON.stringify({ error: "Validation failed", details: errors }));
    return;
  }

  const start = performance.now();
  try {
    const result = await createSoulPr(validation.data);

    proxyLog({
      timestamp: new Date().toISOString(),
      method: "POST",
      hostname: "github-handler",
      port: 0,
      path: "/github/soul-pr",
      allowed: true,
      sanitized: false,
      duration_ms: performance.now() - start,
      response_status: 201,
    });

    sendResponse(socket, 201, "Created", JSON.stringify({
      ok: true,
      pr_url: result.pr_url,
      branch: result.branch,
      magnitude: validation.data.magnitude,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    proxyLog({
      timestamp: new Date().toISOString(),
      method: "POST",
      hostname: "github-handler",
      port: 0,
      path: "/github/soul-pr",
      allowed: true,
      sanitized: false,
      duration_ms: performance.now() - start,
      response_status: 502,
      blocked_reason: message,
    });

    sendResponse(socket, 502, "Bad Gateway", JSON.stringify({ error: "GitHub API error", details: message }));
  }
}
