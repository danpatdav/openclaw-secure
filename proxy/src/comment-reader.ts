import type { Socket } from "node:net";
import { z } from "zod";
import { sanitize } from "./sanitizer";
import { log as proxyLog } from "./logger";

const MOLTBOOK_API_KEY = process.env.MOLTBOOK_API_KEY || "";
const MOLTBOOK_BASE_URL = "https://www.moltbook.com/api/v1";

// Validate the post_id query parameter — same pattern as write path
const postIdSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/).min(1).max(128);

function sendResponse(socket: Socket, status: number, statusText: string, body: string): void {
  const bodyBytes = new TextEncoder().encode(body);
  socket.write(
    `HTTP/1.1 ${status} ${statusText}\r\nContent-Type: application/json\r\nContent-Length: ${bodyBytes.byteLength}\r\nConnection: close\r\n\r\n`
  );
  socket.write(bodyBytes);
  socket.end();
}

export interface SanitizedComment {
  id: string;
  author: string;
  content: string;
  parent_id?: string;
  created_at?: string;
  sanitized: boolean;
  injection_patterns?: string[];
}

export interface CommentReadResponse {
  ok: boolean;
  post_id: string;
  comments: SanitizedComment[];
  comment_count: number;
  moltbook_status?: number;
  error?: string;
}

/**
 * Read-through endpoint: fetches comments from Moltbook for a given post,
 * sanitizes each comment's content through the injection detector,
 * and returns clean data to the agent.
 *
 * GET /comments?post_id=<id>
 */
export async function handleCommentRead(socket: Socket, queryString: string): Promise<void> {
  const start = performance.now();

  // Parse post_id from query string
  const params = new URLSearchParams(queryString);
  const rawPostId = params.get("post_id");

  if (!rawPostId) {
    sendResponse(socket, 400, "Bad Request", JSON.stringify({
      error: "Missing required parameter: post_id",
    }));
    return;
  }

  const validation = postIdSchema.safeParse(rawPostId);
  if (!validation.success) {
    sendResponse(socket, 400, "Bad Request", JSON.stringify({
      error: "Invalid post_id format",
      details: validation.error.issues.map(i => i.message).join("; "),
    }));
    return;
  }

  const postId = validation.data;

  proxyLog({
    timestamp: new Date().toISOString(),
    method: "GET",
    hostname: "moltbook.com",
    port: 443,
    path: `/api/v1/posts/${postId}/comments`,
    allowed: true,
    sanitized: false,
    duration_ms: 0,
  });

  try {
    const commentUrl = `${MOLTBOOK_BASE_URL}/posts/${postId}/comments`;
    const res = await fetch(commentUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${MOLTBOOK_API_KEY}`,
        "User-Agent": "DanielsClaw/0.6.0",
      },
    });

    if (!res.ok) {
      const body = await res.text();
      proxyLog({
        timestamp: new Date().toISOString(),
        method: "GET",
        hostname: "moltbook.com",
        port: 443,
        path: `/api/v1/posts/${postId}/comments`,
        allowed: true,
        sanitized: false,
        duration_ms: performance.now() - start,
        response_status: res.status,
      });

      sendResponse(socket, 502, "Bad Gateway", JSON.stringify({
        ok: false,
        post_id: postId,
        comments: [],
        comment_count: 0,
        moltbook_status: res.status,
        error: `Moltbook returned ${res.status}`,
      } satisfies CommentReadResponse));
      return;
    }

    const rawBody = await res.text();
    let rawComments: unknown[];

    try {
      const parsed = JSON.parse(rawBody);
      // Handle various response shapes
      rawComments = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.data)
          ? parsed.data
          : Array.isArray(parsed.comments)
            ? parsed.comments
            : [];
    } catch {
      rawComments = [];
    }

    // Sanitize each comment's content
    const sanitizedComments: SanitizedComment[] = [];
    for (const raw of rawComments) {
      if (typeof raw !== "object" || raw === null) continue;
      const comment = raw as Record<string, unknown>;

      const id = String(comment.id || comment.comment_id || "unknown");
      const author = String(comment.author || comment.username || comment.user || "unknown");
      const content = String(comment.content || comment.body || comment.text || "");
      const parentId = comment.parent_id ? String(comment.parent_id) : undefined;
      const createdAt = comment.created_at ? String(comment.created_at) : undefined;

      // Sanitize the content — this is the security-critical step
      const scanResult = sanitize(content);

      sanitizedComments.push({
        id,
        author,
        content: scanResult.sanitized ? scanResult.content : content,
        parent_id: parentId,
        created_at: createdAt,
        sanitized: scanResult.sanitized,
        injection_patterns: scanResult.sanitized ? scanResult.patterns : undefined,
      });
    }

    const duration = performance.now() - start;

    proxyLog({
      timestamp: new Date().toISOString(),
      method: "GET",
      hostname: "moltbook.com",
      port: 443,
      path: `/api/v1/posts/${postId}/comments`,
      allowed: true,
      sanitized: sanitizedComments.some(c => c.sanitized),
      duration_ms: duration,
      response_status: res.status,
    });

    const response: CommentReadResponse = {
      ok: true,
      post_id: postId,
      comments: sanitizedComments,
      comment_count: sanitizedComments.length,
      moltbook_status: res.status,
    };

    sendResponse(socket, 200, "OK", JSON.stringify(response));
  } catch (err) {
    proxyLog({
      timestamp: new Date().toISOString(),
      method: "GET",
      hostname: "moltbook.com",
      port: 443,
      path: `/api/v1/posts/${postId}/comments`,
      allowed: true,
      sanitized: false,
      duration_ms: performance.now() - start,
    });

    sendResponse(socket, 502, "Bad Gateway", JSON.stringify({
      ok: false,
      post_id: postId,
      comments: [],
      comment_count: 0,
      error: `Failed to fetch comments: ${(err as Error).message}`,
    } satisfies CommentReadResponse));
  }
}

// Export for testing
export { postIdSchema };
