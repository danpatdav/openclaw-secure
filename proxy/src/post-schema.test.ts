import { describe, test, expect } from "bun:test";
import { postRequestSchema, voteRequestSchema } from "./post-schema";

describe("post request schema", () => {
  test("accepts valid post with content only", () => {
    const result = postRequestSchema.safeParse({ content: "Hello Moltbook!" });
    expect(result.success).toBe(true);
  });

  test("accepts valid post with content and thread_id", () => {
    const result = postRequestSchema.safeParse({
      content: "Great discussion!",
      thread_id: "thread-abc-123",
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty content", () => {
    const result = postRequestSchema.safeParse({ content: "" });
    expect(result.success).toBe(false);
  });

  test("rejects content over 500 characters", () => {
    const result = postRequestSchema.safeParse({ content: "a".repeat(501) });
    expect(result.success).toBe(false);
  });

  test("accepts content at exactly 500 characters", () => {
    const result = postRequestSchema.safeParse({ content: "a".repeat(500) });
    expect(result.success).toBe(true);
  });

  test("accepts content at exactly 1 character", () => {
    const result = postRequestSchema.safeParse({ content: "x" });
    expect(result.success).toBe(true);
  });

  test("rejects thread_id with special characters", () => {
    const result = postRequestSchema.safeParse({
      content: "test",
      thread_id: "thread with spaces!",
    });
    expect(result.success).toBe(false);
  });

  test("rejects thread_id over 128 characters", () => {
    const result = postRequestSchema.safeParse({
      content: "test",
      thread_id: "a".repeat(129),
    });
    expect(result.success).toBe(false);
  });

  test("accepts thread_id with hyphens and underscores", () => {
    const result = postRequestSchema.safeParse({
      content: "test",
      thread_id: "thread_abc-123_XYZ",
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing content field", () => {
    const result = postRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("rejects non-string content", () => {
    const result = postRequestSchema.safeParse({ content: 42 });
    expect(result.success).toBe(false);
  });

  test("rejects null", () => {
    const result = postRequestSchema.safeParse(null);
    expect(result.success).toBe(false);
  });
});

describe("vote request schema", () => {
  test("accepts valid post_id", () => {
    const result = voteRequestSchema.safeParse({ post_id: "post-abc-123" });
    expect(result.success).toBe(true);
  });

  test("rejects missing post_id", () => {
    const result = voteRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("rejects post_id with special characters", () => {
    const result = voteRequestSchema.safeParse({ post_id: "post id with spaces!" });
    expect(result.success).toBe(false);
  });

  test("rejects post_id over 128 characters", () => {
    const result = voteRequestSchema.safeParse({ post_id: "a".repeat(129) });
    expect(result.success).toBe(false);
  });

  test("accepts post_id at 128 characters", () => {
    const result = voteRequestSchema.safeParse({ post_id: "a".repeat(128) });
    expect(result.success).toBe(true);
  });

  test("rejects empty post_id", () => {
    const result = voteRequestSchema.safeParse({ post_id: "" });
    expect(result.success).toBe(false);
  });

  test("rejects non-string post_id", () => {
    const result = voteRequestSchema.safeParse({ post_id: 123 });
    expect(result.success).toBe(false);
  });

  test("rejects null", () => {
    const result = voteRequestSchema.safeParse(null);
    expect(result.success).toBe(false);
  });
});
