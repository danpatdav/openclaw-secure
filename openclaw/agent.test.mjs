/**
 * Agent Pure Function Unit Tests
 *
 * Tests for the pure/testable functions in agent.mjs:
 * - extractPostIds: JSON feed parsing with multiple response shapes
 * - filterNewPosts: deduplication against seen posts
 * - buildMemoryPayload: memory assembly with pruning
 * - normalizeSentiment: sentiment enum validation
 * - normalizeTopic: topic enum validation with alias mapping
 *
 * Priority 5 of 5 from Council gap analysis (Issue #40).
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// Mock undici since agent.mjs imports ProxyAgent at top level
mock.module("undici", () => ({
  ProxyAgent: class { constructor() {} },
}));

// Mock fs.readFileSync (SOUL loading)
mock.module("node:fs", () => ({
  readFileSync: () => "mock soul content",
}));

// Prevent main() from running
process.env.BUN_TEST = "1";

// Suppress process.exit calls from agent startup
const originalExit = process.exit;
process.exit = (() => {});

const {
  extractPostIds,
  filterNewPosts,
  buildMemoryPayload,
  normalizeSentiment,
  normalizeTopic,
  seenPostIds,
  postLabels,
  trackedThreads,
  postsMade,
  VALID_SENTIMENTS,
  VALID_TOPICS,
  TOPIC_ALIASES,
} = await import("./agent.mjs");

process.exit = originalExit;

// --- Helpers ---

function resetState() {
  seenPostIds.clear();
  postLabels.clear();
  trackedThreads.clear();
  postsMade.length = 0;
}

// =============================================================================
// A. normalizeSentiment — enum validation
// =============================================================================

describe("normalizeSentiment", () => {
  it("accepts valid sentiments unchanged", () => {
    expect(normalizeSentiment("positive")).toBe("positive");
    expect(normalizeSentiment("neutral")).toBe("neutral");
    expect(normalizeSentiment("negative")).toBe("negative");
  });

  it("returns 'neutral' for invalid string", () => {
    expect(normalizeSentiment("mixed")).toBe("neutral");
    expect(normalizeSentiment("happy")).toBe("neutral");
    expect(normalizeSentiment("POSITIVE")).toBe("neutral"); // case-sensitive
  });

  it("returns 'neutral' for non-string types", () => {
    expect(normalizeSentiment(undefined)).toBe("neutral");
    expect(normalizeSentiment(null)).toBe("neutral");
    expect(normalizeSentiment(42)).toBe("neutral");
    expect(normalizeSentiment(true)).toBe("neutral");
  });

  it("returns 'neutral' for empty string", () => {
    expect(normalizeSentiment("")).toBe("neutral");
  });
});

// =============================================================================
// B. normalizeTopic — enum validation with alias mapping
// =============================================================================

describe("normalizeTopic", () => {
  it("accepts valid topics unchanged", () => {
    for (const topic of VALID_TOPICS) {
      expect(normalizeTopic(topic)).toBe(topic);
    }
  });

  it("maps known aliases to valid topics", () => {
    expect(normalizeTopic("tech")).toBe("technical");
    expect(normalizeTopic("ai")).toBe("ai_safety");
    expect(normalizeTopic("meta")).toBe("moltbook_meta");
    expect(normalizeTopic("humor")).toBe("social");
    expect(normalizeTopic("politics")).toBe("other");
    expect(normalizeTopic("crypto")).toBe("other");
    expect(normalizeTopic("spam")).toBe("other");
  });

  it("alias lookup is case-insensitive", () => {
    expect(normalizeTopic("TECH")).toBe("technical");
    expect(normalizeTopic("Tech")).toBe("technical");
    expect(normalizeTopic("AI")).toBe("ai_safety");
  });

  it("returns 'other' for unknown strings", () => {
    expect(normalizeTopic("music")).toBe("other");
    expect(normalizeTopic("finance")).toBe("other");
  });

  it("returns 'other' for non-string types", () => {
    expect(normalizeTopic(undefined)).toBe("other");
    expect(normalizeTopic(null)).toBe("other");
    expect(normalizeTopic(42)).toBe("other");
  });
});

// =============================================================================
// C. extractPostIds — JSON feed parsing
// =============================================================================

describe("extractPostIds", () => {
  it("extracts IDs from {data: [...]} shape", () => {
    const feed = JSON.stringify({ data: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] });
    expect(extractPostIds(feed)).toEqual(["p1", "p2", "p3"]);
  });

  it("extracts IDs from {posts: [...]} shape", () => {
    const feed = JSON.stringify({ posts: [{ id: "a" }, { id: "b" }] });
    expect(extractPostIds(feed)).toEqual(["a", "b"]);
  });

  it("extracts IDs from bare array shape", () => {
    const feed = JSON.stringify([{ id: "x1" }, { id: "x2" }]);
    expect(extractPostIds(feed)).toEqual(["x1", "x2"]);
  });

  it("converts numeric IDs to strings", () => {
    const feed = JSON.stringify({ data: [{ id: 123 }, { id: 456 }] });
    expect(extractPostIds(feed)).toEqual(["123", "456"]);
  });

  it("filters out entries without id field", () => {
    const feed = JSON.stringify({ data: [{ id: "p1" }, { title: "no id" }, { id: "p3" }] });
    expect(extractPostIds(feed)).toEqual(["p1", "p3"]);
  });

  it("returns empty array for invalid JSON", () => {
    expect(extractPostIds("not json")).toEqual([]);
    expect(extractPostIds("{invalid")).toEqual([]);
  });

  it("returns empty array for empty feed", () => {
    expect(extractPostIds("")).toEqual([]);
    expect(extractPostIds("{}")).toEqual([]);
  });

  it("returns empty array for non-array data field", () => {
    const feed = JSON.stringify({ data: "not an array" });
    expect(extractPostIds(feed)).toEqual([]);
  });

  it("prefers data over posts when both present", () => {
    const feed = JSON.stringify({
      data: [{ id: "from-data" }],
      posts: [{ id: "from-posts" }],
    });
    // data is checked first in the || chain
    expect(extractPostIds(feed)).toEqual(["from-data"]);
  });
});

// =============================================================================
// D. filterNewPosts — deduplication logic
// =============================================================================

describe("filterNewPosts", () => {
  beforeEach(resetState);

  it("identifies all posts as new on first call", () => {
    const feed = JSON.stringify({ data: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] });
    const result = filterNewPosts(feed);
    expect(result.total).toBe(3);
    expect(result.new).toBe(3);
    expect(result.skipped).toBe(0);
  });

  it("marks previously seen posts as skipped", () => {
    seenPostIds.add("p1");
    seenPostIds.add("p2");
    const feed = JSON.stringify({ data: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] });
    const result = filterNewPosts(feed);
    expect(result.total).toBe(3);
    expect(result.new).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it("adds all feed post IDs to seenPostIds", () => {
    const feed = JSON.stringify({ data: [{ id: "a" }, { id: "b" }] });
    filterNewPosts(feed);
    expect(seenPostIds.has("a")).toBe(true);
    expect(seenPostIds.has("b")).toBe(true);
  });

  it("handles empty feed gracefully", () => {
    const result = filterNewPosts("{}");
    expect(result.total).toBe(0);
    expect(result.new).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("handles invalid JSON gracefully", () => {
    const result = filterNewPosts("not json");
    expect(result.total).toBe(0);
    expect(result.new).toBe(0);
  });

  it("consecutive calls show dedup working", () => {
    const feed1 = JSON.stringify({ data: [{ id: "p1" }, { id: "p2" }] });
    const feed2 = JSON.stringify({ data: [{ id: "p2" }, { id: "p3" }] });

    const r1 = filterNewPosts(feed1);
    expect(r1.new).toBe(2);

    const r2 = filterNewPosts(feed2);
    expect(r2.new).toBe(1); // only p3 is new
    expect(r2.skipped).toBe(1); // p2 was seen
  });
});

// =============================================================================
// E. buildMemoryPayload — memory assembly and pruning
// =============================================================================

describe("buildMemoryPayload", () => {
  beforeEach(resetState);

  it("produces valid structure with no data", () => {
    const payload = buildMemoryPayload();
    expect(payload.version).toBe(1);
    expect(payload.run_id).toBeDefined();
    expect(payload.run_start).toBeDefined();
    expect(payload.run_end).toBeDefined();
    expect(Array.isArray(payload.entries)).toBe(true);
    expect(payload.stats).toBeDefined();
    expect(payload.stats.posts_read).toBeDefined();
    expect(payload.stats.posts_made).toBeDefined();
    expect(payload.stats.upvotes).toBeDefined();
    expect(payload.stats.threads_tracked).toBeDefined();
  });

  it("includes post_seen entries for all seenPostIds", () => {
    seenPostIds.add("p1");
    seenPostIds.add("p2");
    seenPostIds.add("p3");
    const payload = buildMemoryPayload();
    const postSeen = payload.entries.filter(e => e.type === "post_seen");
    expect(postSeen.length).toBe(3);
    const ids = postSeen.map(e => e.post_id);
    expect(ids).toContain("p1");
    expect(ids).toContain("p2");
    expect(ids).toContain("p3");
  });

  it("uses normalized labels from postLabels map", () => {
    seenPostIds.add("p1");
    postLabels.set("p1", { topic: "tech", sentiment: "positive" });
    const payload = buildMemoryPayload();
    const entry = payload.entries.find(e => e.type === "post_seen" && e.post_id === "p1");
    expect(entry.topic_label).toBe("technical"); // "tech" alias resolved
    expect(entry.sentiment).toBe("positive");
  });

  it("defaults to 'other' topic and 'neutral' sentiment when no label", () => {
    seenPostIds.add("p1");
    // No postLabels entry for p1
    const payload = buildMemoryPayload();
    const entry = payload.entries.find(e => e.type === "post_seen");
    expect(entry.topic_label).toBe("other");
    expect(entry.sentiment).toBe("neutral");
  });

  it("includes thread_tracked entries", () => {
    trackedThreads.set("t1", {
      topic_label: "ai_safety",
      first_seen: "2026-01-01T00:00:00Z",
      last_interaction: "2026-01-02T00:00:00Z",
    });
    const payload = buildMemoryPayload();
    const tracked = payload.entries.filter(e => e.type === "thread_tracked");
    expect(tracked.length).toBe(1);
    expect(tracked[0].thread_id).toBe("t1");
    expect(tracked[0].topic_label).toBe("ai_safety");
  });

  it("includes post_made entries", () => {
    postsMade.push({
      type: "post_made",
      post_id: "pm1",
      thread_id: "t1",
      content: "test reply",
      timestamp: "2026-01-01T00:00:00Z",
      action: "reply",
      status: "success",
    });
    const payload = buildMemoryPayload();
    const made = payload.entries.filter(e => e.type === "post_made");
    expect(made.length).toBe(1);
    expect(made[0].post_id).toBe("pm1");
  });

  it("respects 10000 entry limit", () => {
    // Add more than 10000 seen post IDs
    for (let i = 0; i < 10100; i++) {
      seenPostIds.add(`p-${i}`);
    }
    const payload = buildMemoryPayload();
    expect(payload.entries.length).toBeLessThanOrEqual(10000);
  });

  it("stats reflect current counters", () => {
    postsMade.push({ type: "post_made", action: "reply", status: "success" });
    postsMade.push({ type: "post_made", action: "upvote", status: "success" });
    trackedThreads.set("t1", { topic_label: "other" });
    const payload = buildMemoryPayload();
    expect(payload.stats.posts_made).toBe(2);
    expect(payload.stats.threads_tracked).toBe(1);
  });
});

// =============================================================================
// F. Topic/Sentiment Enum Completeness
// =============================================================================

describe("enum completeness", () => {
  it("VALID_SENTIMENTS has exactly 3 values", () => {
    expect(VALID_SENTIMENTS.size).toBe(3);
    expect(VALID_SENTIMENTS.has("positive")).toBe(true);
    expect(VALID_SENTIMENTS.has("neutral")).toBe(true);
    expect(VALID_SENTIMENTS.has("negative")).toBe(true);
  });

  it("VALID_TOPICS has exactly 6 values", () => {
    expect(VALID_TOPICS.size).toBe(6);
  });

  it("every TOPIC_ALIASES value maps to a VALID_TOPICS entry", () => {
    for (const [alias, target] of Object.entries(TOPIC_ALIASES)) {
      expect(VALID_TOPICS.has(target)).toBe(true);
    }
  });
});
