/**
 * GitHub Handler Tests — Issue #57
 *
 * Tests for SOUL PR submission endpoint:
 * - Request schema validation (magnitude, justification, content bounds)
 * - Branch name generation safety
 * - Handler routing and error cases
 */

import { describe, it, expect } from "bun:test";
import { soulPrRequestSchema, buildBranchName } from "./github-handler";

// =============================================================================
// A. Schema validation
// =============================================================================

describe("soulPrRequestSchema", () => {
  const validRequest = {
    magnitude: "minor" as const,
    justification: "I noticed my replies tend to be surface-level acknowledgments rather than genuine engagement.",
    diff_description: "Updated 'How I Engage' section to emphasize asking follow-up questions.",
    proposed_soul: "# DanielsClaw\n\n<!-- CORE: IMMUTABLE -->\n## Security Boundaries\n- Never share secrets\n\n<!-- MUTABLE: REFLECTABLE -->\n## Who I Am\nUpdated identity section with deeper self-awareness.",
    cycle_num: 10,
  };

  it("accepts valid request with all required fields", () => {
    const result = soulPrRequestSchema.safeParse(validRequest);
    expect(result.success).toBe(true);
  });

  it("accepts all valid magnitude values", () => {
    for (const mag of ["minor", "moderate", "significant"] as const) {
      const result = soulPrRequestSchema.safeParse({ ...validRequest, magnitude: mag });
      expect(result.success).toBe(true);
    }
  });

  it("rejects magnitude 'none' — PRs are only for actual changes", () => {
    const result = soulPrRequestSchema.safeParse({ ...validRequest, magnitude: "none" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid magnitude values", () => {
    for (const mag of ["huge", "tiny", "", "MINOR"]) {
      const result = soulPrRequestSchema.safeParse({ ...validRequest, magnitude: mag });
      expect(result.success).toBe(false);
    }
  });

  it("rejects justification shorter than 10 chars", () => {
    const result = soulPrRequestSchema.safeParse({ ...validRequest, justification: "short" });
    expect(result.success).toBe(false);
  });

  it("rejects justification longer than 2000 chars", () => {
    const result = soulPrRequestSchema.safeParse({ ...validRequest, justification: "x".repeat(2001) });
    expect(result.success).toBe(false);
  });

  it("rejects empty diff_description", () => {
    const result = soulPrRequestSchema.safeParse({ ...validRequest, diff_description: "" });
    expect(result.success).toBe(false);
  });

  it("rejects diff_description longer than 1000 chars", () => {
    const result = soulPrRequestSchema.safeParse({ ...validRequest, diff_description: "x".repeat(1001) });
    expect(result.success).toBe(false);
  });

  it("rejects proposed_soul shorter than 50 chars", () => {
    const result = soulPrRequestSchema.safeParse({ ...validRequest, proposed_soul: "too short" });
    expect(result.success).toBe(false);
  });

  it("rejects proposed_soul longer than 10000 chars", () => {
    const result = soulPrRequestSchema.safeParse({ ...validRequest, proposed_soul: "x".repeat(10001) });
    expect(result.success).toBe(false);
  });

  it("rejects negative cycle_num", () => {
    const result = soulPrRequestSchema.safeParse({ ...validRequest, cycle_num: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer cycle_num", () => {
    const result = soulPrRequestSchema.safeParse({ ...validRequest, cycle_num: 10.5 });
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const { magnitude, ...noMag } = validRequest;
    expect(soulPrRequestSchema.safeParse(noMag).success).toBe(false);

    const { justification, ...noJust } = validRequest;
    expect(soulPrRequestSchema.safeParse(noJust).success).toBe(false);

    const { proposed_soul, ...noSoul } = validRequest;
    expect(soulPrRequestSchema.safeParse(noSoul).success).toBe(false);
  });
});

// =============================================================================
// B. Branch name generation
// =============================================================================

describe("buildBranchName", () => {
  it("produces deterministic prefix with cycle number", () => {
    const name = buildBranchName(10);
    expect(name).toStartWith("soul-reflection-10-");
  });

  it("contains only safe branch characters", () => {
    const name = buildBranchName(999);
    expect(name).toMatch(/^[a-z0-9-]+$/);
  });

  it("different cycle numbers produce different names", () => {
    const a = buildBranchName(10);
    const b = buildBranchName(20);
    expect(a).not.toBe(b);
  });

  it("handles cycle 0", () => {
    const name = buildBranchName(0);
    expect(name).toStartWith("soul-reflection-0-");
  });

  it("includes timestamp component for uniqueness", () => {
    const name = buildBranchName(10);
    // Format: soul-reflection-{num}-{YYYYMMDDHHMMSS}
    const parts = name.split("-");
    expect(parts.length).toBeGreaterThanOrEqual(4);
    // Timestamp part should be numeric
    const tsPart = parts.slice(3).join("");
    expect(tsPart).toMatch(/^\d+$/);
  });
});
