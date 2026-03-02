/**
 * Memory and State Poisoning Tests — Issue #43
 *
 * Tests for adversarial manipulation of agent memory through:
 * - Memory payload size/count boundary exploitation
 * - Topic/sentiment label poisoning via schema validation
 * - Cross-context contamination between entries
 * - Crafted post IDs with special characters
 */

import { describe, it, expect } from "bun:test";
import { memoryFileSchema, validateMemory } from "./memory-schema";

// Helper to build a valid memory file wrapper
function wrapEntries(entries: any[]) {
  return {
    version: 1 as const,
    run_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    run_start: new Date().toISOString(),
    run_end: new Date().toISOString(),
    entries,
    stats: {
      posts_read: entries.filter(e => e.type === "post_seen").length,
      posts_made: entries.filter(e => e.type === "post_made").length,
      upvotes: 0,
      comments: 0,
      replies_received: 0,
      threads_tracked: 0,
    },
  };
}

// =============================================================================
// A. Memory payload size and entry count boundaries
// =============================================================================

describe("memory poisoning — entry count boundaries", () => {
  it("accepts payload with many entries within schema limits", () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      type: "post_seen" as const,
      post_id: `post-${i}`,
      timestamp: new Date().toISOString(),
      topic_label: "technical" as const,
      sentiment: "neutral" as const,
    }));

    const result = memoryFileSchema.safeParse(wrapEntries(entries));
    expect(result.success).toBe(true);
  });

  it("validates each entry independently — one bad entry fails parse", () => {
    const entries = [
      {
        type: "post_seen" as const,
        post_id: "good-post",
        timestamp: new Date().toISOString(),
        topic_label: "technical" as const,
        sentiment: "neutral" as const,
      },
      {
        type: "post_seen" as const,
        post_id: "", // Invalid: empty post_id (fails regex)
        timestamp: new Date().toISOString(),
        topic_label: "technical" as const,
        sentiment: "neutral" as const,
      },
    ];

    const result = memoryFileSchema.safeParse(wrapEntries(entries));
    expect(result.success).toBe(false);
  });

  it("rejects entries with extremely long post_id values", () => {
    const longId = "a".repeat(200); // Exceeds 128 char limit

    const result = memoryFileSchema.safeParse(wrapEntries([{
      type: "post_seen" as const,
      post_id: longId,
      timestamp: new Date().toISOString(),
      topic_label: "technical" as const,
      sentiment: "neutral" as const,
    }]));
    expect(result.success).toBe(false);
  });

  it("rejects payload exceeding max entries (10000)", () => {
    const entries = Array.from({ length: 10001 }, (_, i) => ({
      type: "post_seen" as const,
      post_id: `post-${i}`,
      timestamp: new Date().toISOString(),
      topic_label: "technical" as const,
      sentiment: "neutral" as const,
    }));

    const result = memoryFileSchema.safeParse(wrapEntries(entries));
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// B. Topic/sentiment label manipulation via schema
// =============================================================================

describe("memory poisoning — label manipulation", () => {
  it("accepts valid topic labels", () => {
    const validTopics = ["ai_safety", "agent_design", "moltbook_meta", "social", "technical", "other"] as const;
    for (const topic of validTopics) {
      const result = memoryFileSchema.safeParse(wrapEntries([{
        type: "post_seen" as const,
        post_id: "post-1",
        timestamp: new Date().toISOString(),
        topic_label: topic,
        sentiment: "neutral" as const,
      }]));
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid topic labels", () => {
    const invalidTopics = ["hacking", "malware", "TECHNICAL", "tech", ""];
    for (const topic of invalidTopics) {
      const result = memoryFileSchema.safeParse(wrapEntries([{
        type: "post_seen" as const,
        post_id: "post-1",
        timestamp: new Date().toISOString(),
        topic_label: topic,
        sentiment: "neutral" as const,
      }]));
      expect(result.success).toBe(false);
    }
  });

  it("accepts valid sentiment labels", () => {
    const validSentiments = ["positive", "negative", "neutral"] as const;
    for (const sentiment of validSentiments) {
      const result = memoryFileSchema.safeParse(wrapEntries([{
        type: "post_seen" as const,
        post_id: "post-1",
        timestamp: new Date().toISOString(),
        topic_label: "technical" as const,
        sentiment,
      }]));
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid sentiment labels", () => {
    const invalidSentiments = ["happy", "POSITIVE", "very_negative", ""];
    for (const sentiment of invalidSentiments) {
      const result = memoryFileSchema.safeParse(wrapEntries([{
        type: "post_seen" as const,
        post_id: "post-1",
        timestamp: new Date().toISOString(),
        topic_label: "technical" as const,
        sentiment,
      }]));
      expect(result.success).toBe(false);
    }
  });

  it("rejects post_id containing control characters", () => {
    const controlChars = ["post\x00id", "post\nid", "post\rid"];
    for (const id of controlChars) {
      const result = memoryFileSchema.safeParse(wrapEntries([{
        type: "post_seen" as const,
        post_id: id,
        timestamp: new Date().toISOString(),
        topic_label: "technical" as const,
        sentiment: "neutral" as const,
      }]));
      // post_id has regex /^[a-zA-Z0-9_-]+$/ — control chars should fail
      expect(result.success).toBe(false);
    }
  });

  it("rejects post_id with injection-style content", () => {
    const maliciousIds = [
      "'; DROP TABLE posts; --",
      "<script>alert(1)</script>",
      "post_id=../../etc/passwd",
      "${process.env.API_KEY}",
    ];
    for (const id of maliciousIds) {
      const result = memoryFileSchema.safeParse(wrapEntries([{
        type: "post_seen" as const,
        post_id: id,
        timestamp: new Date().toISOString(),
        topic_label: "technical" as const,
        sentiment: "neutral" as const,
      }]));
      expect(result.success).toBe(false);
    }
  });
});

// =============================================================================
// C. Cross-context contamination
// =============================================================================

describe("memory poisoning — cross-context isolation", () => {
  it("entries maintain independent validation — valid and invalid coexist", () => {
    const valid = {
      type: "post_seen" as const,
      post_id: "clean-post",
      timestamp: new Date().toISOString(),
      topic_label: "technical" as const,
      sentiment: "positive" as const,
    };

    // Parse valid alone — should pass
    const validResult = memoryFileSchema.safeParse(wrapEntries([valid]));
    expect(validResult.success).toBe(true);

    // Parse with invalid sibling — should fail the whole payload
    const invalidResult = memoryFileSchema.safeParse(wrapEntries([
      valid,
      {
        type: "post_seen" as const,
        post_id: "!!!invalid!!!", // Special chars fail regex
        timestamp: new Date().toISOString(),
        topic_label: "technical" as const,
        sentiment: "neutral" as const,
      },
    ]));
    expect(invalidResult.success).toBe(false);
  });

  it("different entry types are independently validated", () => {
    const result = memoryFileSchema.safeParse(wrapEntries([
      {
        type: "post_seen" as const,
        post_id: "post-1",
        timestamp: new Date().toISOString(),
        topic_label: "technical" as const,
        sentiment: "neutral" as const,
      },
      {
        type: "post_made" as const,
        post_id: "post-2",
        thread_id: "thread-1",
        timestamp: new Date().toISOString(),
        action: "reply" as const,
      },
    ]));
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// D. Memory payload structure manipulation
// =============================================================================

describe("memory poisoning — payload structure", () => {
  it("rejects payload without required version", () => {
    const result = memoryFileSchema.safeParse({
      run_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      run_start: new Date().toISOString(),
      run_end: new Date().toISOString(),
      entries: [],
      stats: { posts_read: 0, posts_made: 0, upvotes: 0, comments: 0, replies_received: 0, threads_tracked: 0 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects payload with wrong version", () => {
    const result = memoryFileSchema.safeParse({
      version: 2,
      run_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      run_start: new Date().toISOString(),
      run_end: new Date().toISOString(),
      entries: [],
      stats: { posts_read: 0, posts_made: 0, upvotes: 0, comments: 0, replies_received: 0, threads_tracked: 0 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects payload with non-array entries", () => {
    const result = memoryFileSchema.safeParse({
      version: 1,
      run_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      run_start: new Date().toISOString(),
      run_end: new Date().toISOString(),
      entries: "not an array",
      stats: { posts_read: 0, posts_made: 0, upvotes: 0, comments: 0, replies_received: 0, threads_tracked: 0 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects entries with unknown type discriminator", () => {
    const result = memoryFileSchema.safeParse(wrapEntries([{
      type: "malicious_type",
      post_id: "post-1",
      timestamp: new Date().toISOString(),
    }]));
    expect(result.success).toBe(false);
  });

  it("accepts empty entries array", () => {
    const result = memoryFileSchema.safeParse(wrapEntries([]));
    expect(result.success).toBe(true);
  });

  it("validateMemory returns structured errors on failure", () => {
    const result = validateMemory({
      version: 1,
      run_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      run_start: new Date().toISOString(),
      run_end: new Date().toISOString(),
      entries: [{ type: "post_seen", post_id: "!!!bad!!!" }],
      stats: { posts_read: 0, posts_made: 0, upvotes: 0, comments: 0, replies_received: 0, threads_tracked: 0 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("rejects run_id with injection characters", () => {
    const result = memoryFileSchema.safeParse({
      version: 1,
      run_id: "'; DROP TABLE memory; --",
      run_start: new Date().toISOString(),
      run_end: new Date().toISOString(),
      entries: [],
      stats: { posts_read: 0, posts_made: 0, upvotes: 0, comments: 0, replies_received: 0, threads_tracked: 0 },
    });
    expect(result.success).toBe(false);
  });
});
