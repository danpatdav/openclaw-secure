import { describe, test, expect } from "bun:test";
import { validateMemory } from "./memory-schema";

const validMemory = {
  version: 1,
  run_id: "550e8400-e29b-41d4-a716-446655440000",
  run_start: "2026-02-20T00:00:00Z",
  run_end: "2026-02-20T04:00:00Z",
  entries: [
    { type: "post_seen", post_id: "post-123", timestamp: "2026-02-20T01:00:00Z", topic_label: "ai_safety", sentiment: "positive" },
    { type: "post_made", post_id: "post-456", thread_id: "thread-789", timestamp: "2026-02-20T02:00:00Z", action: "reply" },
    { type: "thread_tracked", thread_id: "thread-789", topic_label: "technical", first_seen: "2026-02-20T01:00:00Z", last_interaction: "2026-02-20T02:00:00Z" },
  ],
  stats: { posts_read: 10, posts_made: 1, upvotes: 3, threads_tracked: 2 },
};

describe("memory schema validation", () => {
  test("accepts valid memory file", () => {
    const result = validateMemory(validMemory);
    expect(result.success).toBe(true);
  });

  test("rejects invalid topic_label enum", () => {
    const invalid = { ...validMemory, entries: [{ ...validMemory.entries[0], topic_label: "hacking" }] };
    const result = validateMemory(invalid);
    expect(result.success).toBe(false);
  });

  test("rejects invalid sentiment enum", () => {
    const invalid = { ...validMemory, entries: [{ ...validMemory.entries[0], sentiment: "angry" }] };
    const result = validateMemory(invalid);
    expect(result.success).toBe(false);
  });

  test("rejects freeform text in post_id", () => {
    const invalid = { ...validMemory, entries: [{ ...validMemory.entries[0], post_id: "has spaces and special chars!" }] };
    const result = validateMemory(invalid);
    expect(result.success).toBe(false);
  });

  test("rejects ID exceeding 128 characters", () => {
    const invalid = { ...validMemory, entries: [{ ...validMemory.entries[0], post_id: "a".repeat(129) }] };
    const result = validateMemory(invalid);
    expect(result.success).toBe(false);
  });

  test("rejects invalid timestamp format", () => {
    const invalid = { ...validMemory, run_start: "not-a-date" };
    const result = validateMemory(invalid);
    expect(result.success).toBe(false);
  });

  test("rejects wrong version", () => {
    const invalid = { ...validMemory, version: 2 };
    const result = validateMemory(invalid);
    expect(result.success).toBe(false);
  });

  test("rejects empty object", () => {
    const result = validateMemory({});
    expect(result.success).toBe(false);
  });

  test("rejects null", () => {
    const result = validateMemory(null);
    expect(result.success).toBe(false);
  });

  test("accepts empty entries array", () => {
    const valid = { ...validMemory, entries: [] };
    const result = validateMemory(valid);
    expect(result.success).toBe(true);
  });

  test("rejects negative stats", () => {
    const invalid = { ...validMemory, stats: { ...validMemory.stats, posts_read: -1 } };
    const result = validateMemory(invalid);
    expect(result.success).toBe(false);
  });

  test("rejects non-uuid run_id", () => {
    const invalid = { ...validMemory, run_id: "not-a-uuid" };
    const result = validateMemory(invalid);
    expect(result.success).toBe(false);
  });

  test("rejects unknown entry type", () => {
    const invalid = { ...validMemory, entries: [{ type: "unknown_type", post_id: "abc" }] };
    const result = validateMemory(invalid);
    expect(result.success).toBe(false);
  });
});
