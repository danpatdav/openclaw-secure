import type { Socket } from "node:net";
import { postRequestSchema, voteRequestSchema } from "./post-schema";
import { sanitize } from "./sanitizer";
import { log as proxyLog } from "./logger";
import type { PostLogEntry } from "./types";

const MOLTBOOK_API_KEY = process.env.MOLTBOOK_API_KEY || "";
const MOLTBOOK_BASE_URL = "https://www.moltbook.com/api/v1";

// --- Activity Tracker & Anomaly Detection ---
// Replaces fixed rate limits with statistical observation.
// Phase 1: observe-only (log anomalies, never block).

interface CycleActivity {
  timestamp: number;
  posts_attempted: number;
  posts_succeeded: number;
  votes_attempted: number;
  votes_succeeded: number;
}

const ACTIVITY_WINDOW_SIZE = 50; // rolling window for stats
const ANOMALY_THRESHOLD_SIGMA = 2; // standard deviations

const activityHistory: CycleActivity[] = [];
let currentCycle: CycleActivity = {
  timestamp: Date.now(),
  posts_attempted: 0,
  posts_succeeded: 0,
  votes_attempted: 0,
  votes_succeeded: 0,
};

// Rotate cycle every 5 minutes (matching agent cycle interval)
const CYCLE_ROTATION_MS = 5 * 60 * 1000;
let lastCycleRotation = Date.now();

function rotateCycleIfNeeded(): void {
  const now = Date.now();
  if (now - lastCycleRotation >= CYCLE_ROTATION_MS) {
    // Check for anomalies before archiving
    checkForAnomalies(currentCycle);
    activityHistory.push(currentCycle);
    if (activityHistory.length > ACTIVITY_WINDOW_SIZE) {
      activityHistory.shift();
    }
    currentCycle = {
      timestamp: now,
      posts_attempted: 0,
      posts_succeeded: 0,
      votes_attempted: 0,
      votes_succeeded: 0,
    };
    lastCycleRotation = now;
  }
}

function recordActivity(action: "post" | "vote", succeeded: boolean): void {
  rotateCycleIfNeeded();
  if (action === "post") {
    currentCycle.posts_attempted++;
    if (succeeded) currentCycle.posts_succeeded++;
  } else {
    currentCycle.votes_attempted++;
    if (succeeded) currentCycle.votes_succeeded++;
  }
}

function computeStats(values: number[]): { mean: number; stddev: number } {
  if (values.length === 0) return { mean: 0, stddev: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return { mean, stddev: Math.sqrt(variance) };
}

function checkForAnomalies(cycle: CycleActivity): void {
  if (activityHistory.length < 5) return; // need minimum baseline

  const postCounts = activityHistory.map((c) => c.posts_attempted);
  const voteCounts = activityHistory.map((c) => c.votes_attempted);

  const postStats = computeStats(postCounts);
  const voteStats = computeStats(voteCounts);

  const anomalies: string[] = [];

  // Check posts
  if (postStats.stddev > 0) {
    const postZ = (cycle.posts_attempted - postStats.mean) / postStats.stddev;
    if (Math.abs(postZ) > ANOMALY_THRESHOLD_SIGMA) {
      const direction = postZ > 0 ? "high" : "low";
      anomalies.push(
        `posts_${direction}: ${cycle.posts_attempted} (mean=${postStats.mean.toFixed(1)}, σ=${postStats.stddev.toFixed(1)}, z=${postZ.toFixed(1)})`
      );
    }
  }

  // Check votes
  if (voteStats.stddev > 0) {
    const voteZ = (cycle.votes_attempted - voteStats.mean) / voteStats.stddev;
    if (Math.abs(voteZ) > ANOMALY_THRESHOLD_SIGMA) {
      const direction = voteZ > 0 ? "high" : "low";
      anomalies.push(
        `votes_${direction}: ${cycle.votes_attempted} (mean=${voteStats.mean.toFixed(1)}, σ=${voteStats.stddev.toFixed(1)}, z=${voteZ.toFixed(1)})`
      );
    }
  }

  if (anomalies.length > 0) {
    proxyLog({
      timestamp: new Date().toISOString(),
      method: "POST",
      hostname: "anomaly-detector",
      port: 0,
      path: "/activity-anomaly",
      allowed: true, // observe-only: never blocks
      sanitized: false,
      duration_ms: 0,
    });
    process.stdout.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        component: "anomaly-detector",
        message: "Activity anomaly detected",
        anomalies,
        cycle_posts: cycle.posts_attempted,
        cycle_votes: cycle.votes_attempted,
        baseline_cycles: activityHistory.length,
        post_stats: postStats,
        vote_stats: voteStats,
      }) + "\n"
    );
  }
}

// Export for testing
export { activityHistory, currentCycle, computeStats, checkForAnomalies, recordActivity, rotateCycleIfNeeded, ANOMALY_THRESHOLD_SIGMA };

// --- Response Helper ---

function sendResponse(socket: Socket, status: number, statusText: string, body: string): void {
  const bodyBytes = new TextEncoder().encode(body);
  socket.write(
    `HTTP/1.1 ${status} ${statusText}\r\nContent-Type: application/json\r\nContent-Length: ${bodyBytes.byteLength}\r\nConnection: close\r\n\r\n`
  );
  socket.write(bodyBytes);
  socket.end();
}

// --- Logging ---

function logPostAttempt(entry: PostLogEntry): void {
  proxyLog({
    timestamp: entry.timestamp,
    method: "POST",
    hostname: "moltbook.com",
    port: 443,
    path: entry.action === "post" ? "/api/v1/posts" : "/api/v1/votes",
    allowed: entry.allowed,
    blocked_reason: entry.blocked_reason,
    sanitized: false,
    duration_ms: entry.duration_ms,
    response_status: entry.moltbook_status,
  });
}

// --- Post Handler ---

async function handlePost(socket: Socket, body: Buffer): Promise<void> {
  const start = performance.now();
  const logEntry: PostLogEntry = {
    timestamp: new Date().toISOString(),
    action: "post",
    allowed: false,
    duration_ms: 0,
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf-8"));
  } catch {
    logEntry.duration_ms = performance.now() - start;
    logPostAttempt(logEntry);
    sendResponse(socket, 400, "Bad Request", JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const validation = postRequestSchema.safeParse(parsed);
  if (!validation.success) {
    logEntry.blocked_reason = "Schema validation failed";
    logEntry.duration_ms = performance.now() - start;
    logPostAttempt(logEntry);
    sendResponse(
      socket,
      400,
      "Bad Request",
      JSON.stringify({
        error: "Schema validation failed",
        details: validation.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      })
    );
    return;
  }

  const data = validation.data;
  logEntry.content_length = data.content.length;
  logEntry.thread_id = data.thread_id;

  // Record activity for anomaly detection (observe-only, never blocks)
  rotateCycleIfNeeded();

  // Content scanning (reuse existing sanitizer)
  const scanResult = sanitize(data.content);
  if (scanResult.sanitized) {
    logEntry.blocked_reason = `Injection patterns detected: ${scanResult.patterns.join(", ")}`;
    logEntry.duration_ms = performance.now() - start;
    logPostAttempt(logEntry);
    sendResponse(
      socket,
      400,
      "Bad Request",
      JSON.stringify({
        error: "Content contains disallowed patterns",
        patterns: scanResult.patterns,
      })
    );
    return;
  }

  // Forward to Moltbook
  try {
    // Build Moltbook request
    // Moltbook requires: content, title, submolt_name
    // For replies to a thread: use /posts/{thread_id}/comments endpoint
    const isReply = !!data.thread_id;
    const moltbookBody: Record<string, string> = { content: data.content };

    if (!isReply) {
      // Top-level post: needs title and submolt_name
      moltbookBody.title = data.title || data.content.slice(0, 100);
      moltbookBody.submolt_name = data.submolt_name || "general";
    }

    const moltbookUrl = isReply
      ? `${MOLTBOOK_BASE_URL}/posts/${data.thread_id}/comments`
      : `${MOLTBOOK_BASE_URL}/posts`;
    const moltbookPayload = JSON.stringify(moltbookBody);

    proxyLog({
      timestamp: new Date().toISOString(),
      method: "POST",
      hostname: "moltbook.com",
      port: 443,
      path: "/api/v1/posts",
      allowed: true,
      sanitized: false,
      duration_ms: 0,
    });

    const res = await fetch(moltbookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MOLTBOOK_API_KEY}`,
        "User-Agent": "DanielsClaw/0.4.0",
      },
      body: moltbookPayload,
    });

    logEntry.allowed = true;
    logEntry.moltbook_status = res.status;
    logEntry.duration_ms = performance.now() - start;

    recordActivity("post", true);

    const responseBody = await res.text();
    logPostAttempt(logEntry);

    if (!res.ok) {
      // Log the full Moltbook error for debugging
      process.stdout.write(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "warn",
          component: "post-handler",
          message: "Moltbook POST error",
          url: moltbookUrl,
          sent_payload: moltbookPayload,
          moltbook_status: res.status,
          moltbook_response: responseBody.slice(0, 1000),
        }) + "\n"
      );
      sendResponse(
        socket,
        502,
        "Bad Gateway",
        JSON.stringify({ error: "Moltbook returned error", status: res.status, body: responseBody })
      );
      return;
    }

    let responseData: unknown;
    try {
      responseData = JSON.parse(responseBody);
    } catch {
      responseData = { raw: responseBody };
    }

    sendResponse(
      socket,
      200,
      "OK",
      JSON.stringify({ ok: true, moltbook_status: res.status, data: responseData })
    );
  } catch (err) {
    logEntry.duration_ms = performance.now() - start;
    logEntry.blocked_reason = `Moltbook request failed: ${(err as Error).message}`;
    logPostAttempt(logEntry);
    sendResponse(
      socket,
      502,
      "Bad Gateway",
      JSON.stringify({ error: "Failed to reach Moltbook", message: (err as Error).message })
    );
  }
}

// --- Vote Handler ---

async function handleVote(socket: Socket, body: Buffer): Promise<void> {
  const start = performance.now();
  const logEntry: PostLogEntry = {
    timestamp: new Date().toISOString(),
    action: "vote",
    allowed: false,
    duration_ms: 0,
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf-8"));
  } catch {
    logEntry.duration_ms = performance.now() - start;
    logPostAttempt(logEntry);
    sendResponse(socket, 400, "Bad Request", JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const validation = voteRequestSchema.safeParse(parsed);
  if (!validation.success) {
    logEntry.blocked_reason = "Schema validation failed";
    logEntry.duration_ms = performance.now() - start;
    logPostAttempt(logEntry);
    sendResponse(
      socket,
      400,
      "Bad Request",
      JSON.stringify({
        error: "Schema validation failed",
        details: validation.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      })
    );
    return;
  }

  const data = validation.data;
  logEntry.post_id = data.post_id;

  // Record activity for anomaly detection (observe-only, never blocks)
  rotateCycleIfNeeded();

  // Forward to Moltbook
  try {
    const voteUrl = `${MOLTBOOK_BASE_URL}/posts/${data.post_id}/upvote`;
    const res = await fetch(voteUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MOLTBOOK_API_KEY}`,
        "User-Agent": "DanielsClaw/0.4.0",
      },
    });

    logEntry.allowed = true;
    logEntry.moltbook_status = res.status;
    logEntry.duration_ms = performance.now() - start;

    recordActivity("vote", true);

    const responseBody = await res.text();
    logPostAttempt(logEntry);

    if (!res.ok) {
      // Log the full Moltbook error for debugging
      process.stdout.write(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "warn",
          component: "post-handler",
          message: "Moltbook vote error",
          url: voteUrl,
          moltbook_status: res.status,
          moltbook_response: responseBody.slice(0, 1000),
        }) + "\n"
      );
      sendResponse(
        socket,
        502,
        "Bad Gateway",
        JSON.stringify({ error: "Moltbook returned error", status: res.status, body: responseBody })
      );
      return;
    }

    sendResponse(socket, 200, "OK", JSON.stringify({ ok: true, moltbook_status: res.status }));
  } catch (err) {
    logEntry.duration_ms = performance.now() - start;
    logEntry.blocked_reason = `Moltbook request failed: ${(err as Error).message}`;
    logPostAttempt(logEntry);
    sendResponse(
      socket,
      502,
      "Bad Gateway",
      JSON.stringify({ error: "Failed to reach Moltbook", message: (err as Error).message })
    );
  }
}

// --- Public Router ---

export async function handlePostRequest(
  socket: Socket,
  method: string,
  path: string,
  body?: Buffer
): Promise<void> {
  if (method !== "POST") {
    sendResponse(socket, 405, "Method Not Allowed", JSON.stringify({ error: "Only POST allowed" }));
    return;
  }

  if (!body || body.length === 0) {
    sendResponse(socket, 400, "Bad Request", JSON.stringify({ error: "Empty body" }));
    return;
  }

  if (path === "/post") {
    await handlePost(socket, body);
  } else if (path === "/vote") {
    await handleVote(socket, body);
  } else {
    sendResponse(socket, 404, "Not Found", JSON.stringify({ error: "Not Found" }));
  }
}
