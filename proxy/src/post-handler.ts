import type { Socket } from "node:net";
import { postRequestSchema, voteRequestSchema } from "./post-schema";
import { sanitize } from "./sanitizer";
import { log as proxyLog } from "./logger";
import type { PostLogEntry } from "./types";

const MOLTBOOK_API_KEY = process.env.MOLTBOOK_API_KEY || "";
const MOLTBOOK_BASE_URL = "https://www.moltbook.com/api/v1";

// --- Rate Limiter (in-memory, sliding window) ---

interface RateWindow {
  timestamps: number[];
}

const rateLimits = {
  post_hourly: { max: 3, windowMs: 60 * 60 * 1000 },
  post_daily: { max: 10, windowMs: 24 * 60 * 60 * 1000 },
  vote_hourly: { max: 20, windowMs: 60 * 60 * 1000 },
};

const rateWindows: Record<string, RateWindow> = {
  post_hourly: { timestamps: [] },
  post_daily: { timestamps: [] },
  vote_hourly: { timestamps: [] },
};

function checkRateLimit(key: string): { allowed: boolean; reason?: string } {
  const limit = rateLimits[key as keyof typeof rateLimits];
  const window = rateWindows[key];
  if (!limit || !window) return { allowed: true };

  const now = Date.now();
  window.timestamps = window.timestamps.filter((t) => now - t < limit.windowMs);

  if (window.timestamps.length >= limit.max) {
    return {
      allowed: false,
      reason: `Rate limit exceeded: ${key} (${limit.max} per ${limit.windowMs / 3600000}h)`,
    };
  }

  return { allowed: true };
}

function recordRate(key: string): void {
  const window = rateWindows[key];
  if (window) {
    window.timestamps.push(Date.now());
  }
}

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

  // Rate limit checks
  const hourlyCheck = checkRateLimit("post_hourly");
  if (!hourlyCheck.allowed) {
    logEntry.blocked_reason = hourlyCheck.reason;
    logEntry.duration_ms = performance.now() - start;
    logPostAttempt(logEntry);
    sendResponse(socket, 429, "Too Many Requests", JSON.stringify({ error: hourlyCheck.reason }));
    return;
  }

  const dailyCheck = checkRateLimit("post_daily");
  if (!dailyCheck.allowed) {
    logEntry.blocked_reason = dailyCheck.reason;
    logEntry.duration_ms = performance.now() - start;
    logPostAttempt(logEntry);
    sendResponse(socket, 429, "Too Many Requests", JSON.stringify({ error: dailyCheck.reason }));
    return;
  }

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

    recordRate("post_hourly");
    recordRate("post_daily");

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

  // Rate limit check
  const voteCheck = checkRateLimit("vote_hourly");
  if (!voteCheck.allowed) {
    logEntry.blocked_reason = voteCheck.reason;
    logEntry.duration_ms = performance.now() - start;
    logPostAttempt(logEntry);
    sendResponse(socket, 429, "Too Many Requests", JSON.stringify({ error: voteCheck.reason }));
    return;
  }

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

    recordRate("vote_hourly");

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
