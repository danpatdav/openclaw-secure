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
  detectReplies,
  pickFeedSource,
  seenPostIds,
  postLabels,
  trackedThreads,
  postsMade,
  commentsMade,
  myCommentIds,
  respondedReplyIds,
  discoveredSubmolts,
  VALID_SENTIMENTS,
  VALID_TOPICS,
  TOPIC_ALIASES,
  FEED_SOURCES,
  EXPLORATION_CHANCE,
  isValidSubmolt,
} = await import("./agent.mjs");

process.exit = originalExit;

// --- Helpers ---

function resetState() {
  seenPostIds.clear();
  postLabels.clear();
  trackedThreads.clear();
  postsMade.length = 0;
  commentsMade.length = 0;
  myCommentIds.clear();
  respondedReplyIds.clear();
  discoveredSubmolts.length = 0;
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
// F. detectReplies — reply detection pure function
// =============================================================================

describe("detectReplies", () => {
  it("returns empty array for empty comments", () => {
    const result = detectReplies([], new Map(), new Set());
    expect(result).toEqual([]);
  });

  it("marks comment as reply when parent_id matches our comment", () => {
    const ownIds = new Map([["c1", "post-1"]]);
    const comments = [
      { id: "r1", author: "alice", content: "Great point!", parent_id: "c1" },
    ];
    const result = detectReplies(comments, ownIds, new Set());
    expect(result.length).toBe(1);
    expect(result[0].isReply).toBe(true);
    expect(result[0].isResponded).toBe(false);
  });

  it("does not mark comment as reply when parent_id is unknown", () => {
    const ownIds = new Map([["c1", "post-1"]]);
    const comments = [
      { id: "r1", author: "alice", content: "Random comment", parent_id: "c999" },
    ];
    const result = detectReplies(comments, ownIds, new Set());
    expect(result[0].isReply).toBe(false);
  });

  it("does not mark comment as reply when no parent_id", () => {
    const ownIds = new Map([["c1", "post-1"]]);
    const comments = [
      { id: "r1", author: "alice", content: "Top-level comment" },
    ];
    const result = detectReplies(comments, ownIds, new Set());
    expect(result[0].isReply).toBe(false);
  });

  it("marks reply as responded when id is in respondedIds", () => {
    const ownIds = new Map([["c1", "post-1"]]);
    const responded = new Set(["r1"]);
    const comments = [
      { id: "r1", author: "alice", content: "Nice!", parent_id: "c1" },
    ];
    const result = detectReplies(comments, ownIds, responded);
    expect(result[0].isReply).toBe(true);
    expect(result[0].isResponded).toBe(true);
  });

  it("handles mixed comments correctly", () => {
    const ownIds = new Map([["c1", "post-1"], ["c2", "post-2"]]);
    const responded = new Set(["r1"]);
    const comments = [
      { id: "r1", author: "alice", content: "Reply 1", parent_id: "c1" },      // reply, responded
      { id: "r2", author: "bob", content: "Reply 2", parent_id: "c2" },        // reply, not responded
      { id: "r3", author: "carol", content: "Random", parent_id: "c999" },     // not a reply
      { id: "r4", author: "dave", content: "Top-level" },                       // not a reply
    ];
    const result = detectReplies(comments, ownIds, responded);
    expect(result[0].isReply).toBe(true);
    expect(result[0].isResponded).toBe(true);
    expect(result[1].isReply).toBe(true);
    expect(result[1].isResponded).toBe(false);
    expect(result[2].isReply).toBe(false);
    expect(result[3].isReply).toBe(false);
  });

  it("converts parent_id to string for comparison", () => {
    const ownIds = new Map([["123", "post-1"]]);
    const comments = [
      { id: "r1", author: "alice", content: "Reply", parent_id: 123 },
    ];
    const result = detectReplies(comments, ownIds, new Set());
    expect(result[0].isReply).toBe(true);
  });
});

// =============================================================================
// G. buildMemoryPayload — replies_received in stats
// =============================================================================

describe("buildMemoryPayload replies tracking", () => {
  beforeEach(resetState);

  it("includes replies_received in stats", () => {
    const payload = buildMemoryPayload();
    expect(payload.stats.replies_received).toBeDefined();
    expect(payload.stats.replies_received).toBe(0);
  });

  it("includes comment_made entries with response_to", () => {
    commentsMade.push({
      type: "comment_made",
      post_id: "post-1",
      comment_id: "c1",
      parent_id: "p1",
      response_to: "reply-1",
      timestamp: "2026-03-01T00:00:00Z",
      content: "My response",
    });
    const payload = buildMemoryPayload();
    const comment = payload.entries.find(e => e.type === "comment_made");
    expect(comment).toBeDefined();
    expect(comment.response_to).toBe("reply-1");
  });

  it("includes comment_made entries without response_to", () => {
    commentsMade.push({
      type: "comment_made",
      post_id: "post-1",
      comment_id: "c1",
      timestamp: "2026-03-01T00:00:00Z",
      content: "Just a comment",
    });
    const payload = buildMemoryPayload();
    const comment = payload.entries.find(e => e.type === "comment_made");
    expect(comment).toBeDefined();
    expect(comment.response_to).toBeUndefined();
  });
});

// =============================================================================
// H. pickFeedSource — weighted random with exploration
// =============================================================================

describe("pickFeedSource", () => {
  beforeEach(resetState);

  it("returns a SOUL-aligned source when no discovered submolts", () => {
    // With no discoveredSubmolts, exploration chance is irrelevant
    const result = pickFeedSource();
    expect(result).toHaveProperty("name");
    expect(result).toHaveProperty("isExploration");
    expect(result.isExploration).toBe(false);
    const validNames = FEED_SOURCES.map(s => s.name);
    expect(validNames).toContain(result.name);
  });

  it("returns valid structure with name and isExploration", () => {
    const result = pickFeedSource();
    expect(typeof result.name).toBe("string");
    expect(typeof result.isExploration).toBe("boolean");
  });

  it("can return exploration picks when discoveredSubmolts populated", () => {
    // Populate discovered submolts
    discoveredSubmolts.push("cooking", "music", "sports");

    // Run many picks — at least one should be exploration with 15% chance
    let foundExploration = false;
    for (let i = 0; i < 200; i++) {
      const result = pickFeedSource();
      if (result.isExploration) {
        foundExploration = true;
        expect(["cooking", "music", "sports"]).toContain(result.name);
        break;
      }
    }
    expect(foundExploration).toBe(true);
  });

  it("weighted distribution favors higher-weight sources", () => {
    // Run many picks and count — general (weight 3) should appear more than memory (weight 1)
    const counts = {};
    for (let i = 0; i < 1000; i++) {
      const result = pickFeedSource();
      counts[result.name] = (counts[result.name] || 0) + 1;
    }
    // general has weight 3, memory has weight 1 — expect roughly 3x ratio
    expect(counts["general"] || 0).toBeGreaterThan(counts["memory"] || 0);
  });
});

// =============================================================================
// I. FEED_SOURCES configuration
// =============================================================================

describe("FEED_SOURCES", () => {
  it("contains expected SOUL-aligned submolts", () => {
    const names = FEED_SOURCES.map(s => s.name);
    expect(names).toContain("general");
    expect(names).toContain("agents");
    expect(names).toContain("ai");
    expect(names).toContain("philosophy");
    expect(names).toContain("consciousness");
    expect(names).toContain("security");
  });

  it("all weights are positive integers", () => {
    for (const source of FEED_SOURCES) {
      expect(source.weight).toBeGreaterThan(0);
      expect(Number.isInteger(source.weight)).toBe(true);
    }
  });

  it("general has the highest weight", () => {
    const generalWeight = FEED_SOURCES.find(s => s.name === "general").weight;
    for (const source of FEED_SOURCES) {
      expect(generalWeight).toBeGreaterThanOrEqual(source.weight);
    }
  });

  it("EXPLORATION_CHANCE is between 0 and 1", () => {
    expect(EXPLORATION_CHANCE).toBeGreaterThan(0);
    expect(EXPLORATION_CHANCE).toBeLessThan(1);
  });
});

// =============================================================================
// J. buildMemoryPayload — feed_source tracking
// =============================================================================

describe("buildMemoryPayload feed source tracking", () => {
  beforeEach(resetState);

  it("includes feed_source when postLabels has it", () => {
    seenPostIds.add("p1");
    postLabels.set("p1", { topic: "tech", sentiment: "positive", feed_source: "agents", is_exploration: false });
    const payload = buildMemoryPayload();
    const entry = payload.entries.find(e => e.type === "post_seen" && e.post_id === "p1");
    expect(entry.feed_source).toBe("agents");
    expect(entry.is_exploration).toBeUndefined(); // false → omitted
  });

  it("includes is_exploration when true", () => {
    seenPostIds.add("p1");
    postLabels.set("p1", { topic: "other", sentiment: "neutral", feed_source: "cooking", is_exploration: true });
    const payload = buildMemoryPayload();
    const entry = payload.entries.find(e => e.type === "post_seen" && e.post_id === "p1");
    expect(entry.feed_source).toBe("cooking");
    expect(entry.is_exploration).toBe(true);
  });

  it("omits feed_source when not in postLabels", () => {
    seenPostIds.add("p1");
    // No postLabels entry → no feed_source
    const payload = buildMemoryPayload();
    const entry = payload.entries.find(e => e.type === "post_seen" && e.post_id === "p1");
    expect(entry.feed_source).toBeUndefined();
    expect(entry.is_exploration).toBeUndefined();
  });
});

// =============================================================================
// K. Topic/Sentiment Enum Completeness
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

// =============================================================================
// L. isValidSubmolt — submolt name validation for targeted posting
// =============================================================================

describe("isValidSubmolt", () => {
  beforeEach(resetState);

  it("accepts SOUL-aligned submolt names from FEED_SOURCES", () => {
    for (const source of FEED_SOURCES) {
      expect(isValidSubmolt(source.name)).toBe(true);
    }
  });

  it("accepts discovered submolt names", () => {
    discoveredSubmolts.push("cooking", "music", "gardening");
    expect(isValidSubmolt("cooking")).toBe(true);
    expect(isValidSubmolt("music")).toBe(true);
    expect(isValidSubmolt("gardening")).toBe(true);
  });

  it("rejects unknown submolt names", () => {
    expect(isValidSubmolt("malicious-submolt")).toBe(false);
    expect(isValidSubmolt("injected")).toBe(false);
  });

  it("rejects null, undefined, and empty strings", () => {
    expect(isValidSubmolt(null)).toBe(false);
    expect(isValidSubmolt(undefined)).toBe(false);
    expect(isValidSubmolt("")).toBe(false);
  });

  it("rejects non-string types", () => {
    expect(isValidSubmolt(123)).toBe(false);
    expect(isValidSubmolt({})).toBe(false);
    expect(isValidSubmolt(true)).toBe(false);
  });

  it("combines FEED_SOURCES and discoveredSubmolts", () => {
    discoveredSubmolts.push("newcommunity");
    // SOUL-aligned still valid
    expect(isValidSubmolt("agents")).toBe(true);
    // Discovered also valid
    expect(isValidSubmolt("newcommunity")).toBe(true);
    // Unknown still rejected
    expect(isValidSubmolt("fakecommunity")).toBe(false);
  });
});
