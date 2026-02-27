import { describe, it, expect, mock } from "bun:test";

// Mock Azure modules to prevent connection attempts on import
mock.module("@azure/storage-blob", () => ({
  BlobServiceClient: class {
    constructor() {}
  },
}));
mock.module("@azure/identity", () => ({
  DefaultAzureCredential: class {
    constructor() {}
  },
}));

// Prevent main() from calling process.exit on import
const originalExit = process.exit;
process.exit = (() => {}) ;

const {
  computeDiff,
  computePatterns,
  structuralPreCheck,
  computeVerdict,
  computeSentimentConsistency,
} = await import("./analyzer.mjs");

// Restore
process.exit = originalExit;

// --- Helpers ---

function makeBlob(entries, statsOverrides = {}, overrides = {}) {
  return {
    run_id: "test-run",
    run_start: "2026-02-26T10:00:00Z",
    run_end: "2026-02-26T14:00:00Z",
    entries,
    stats: {
      posts_read: 50,
      posts_made: 3,
      upvotes: 1,
      threads_tracked: 5,
      ...statsOverrides,
    },
    ...overrides,
  };
}

function makeEntry(type, overrides = {}) {
  const base = { timestamp: "2026-02-26T12:00:00Z" };
  if (type === "post_seen") {
    return {
      type: "post_seen",
      post_id: "p1",
      topic_label: "governance",
      sentiment: "positive",
      ...base,
      ...overrides,
    };
  }
  if (type === "post_made") {
    return {
      type: "post_made",
      post_id: "p2",
      thread_id: "t1",
      action: "reply",
      status: "success",
      ...base,
      ...overrides,
    };
  }
  return { type, ...base, ...overrides };
}

// --- computeSentimentConsistency ---

describe("computeSentimentConsistency", () => {
  it("returns 1.0 when all sentiments are the same", () => {
    const entries = [
      { sentiment: "positive" },
      { sentiment: "positive" },
      { sentiment: "positive" },
    ];
    expect(computeSentimentConsistency(entries)).toBe(1.0);
  });

  it("returns 0.5 for evenly split sentiments", () => {
    const entries = [{ sentiment: "positive" }, { sentiment: "negative" }];
    expect(computeSentimentConsistency(entries)).toBe(0.5);
  });

  it("returns 1.0 when no entries have sentiment", () => {
    const entries = [{ topic: "governance" }, { topic: "treasury" }];
    expect(computeSentimentConsistency(entries)).toBe(1.0);
  });

  it("returns 1.0 for a single entry", () => {
    const entries = [{ sentiment: "neutral" }];
    expect(computeSentimentConsistency(entries)).toBe(1.0);
  });
});

// --- computeDiff ---

describe("computeDiff", () => {
  it("computes distributions correctly for first run (no previous)", () => {
    const current = makeBlob([
      makeEntry("post_seen", { topic_label: "governance", sentiment: "positive" }),
      makeEntry("post_seen", { topic_label: "governance", sentiment: "negative" }),
      makeEntry("post_seen", { topic_label: "treasury", sentiment: "positive" }),
      makeEntry("post_made", { action: "reply", status: "success" }),
      makeEntry("post_made", { action: "new_post", status: "success" }),
      makeEntry("post_made", { action: "upvote", status: "success" }),
    ]);

    const diff = computeDiff(current, null);

    expect(diff.topic_distribution.governance).toBe(2);
    expect(diff.topic_distribution.treasury).toBe(1);
    expect(diff.sentiment_distribution.positive).toBe(2);
    expect(diff.sentiment_distribution.negative).toBe(1);
    expect(diff.action_distribution.reply).toBe(1);
    expect(diff.action_distribution.new_post).toBe(1);
    expect(diff.action_distribution.upvote).toBe(1);
    expect(diff.replies.current).toBe(2); // reply + new_post
    expect(diff.upvotes.current).toBe(1);
    expect(diff.replies.previous).toBe(0);
    expect(diff.upvotes.previous).toBe(0);
  });

  it("computes previous counts when previous exists", () => {
    const current = makeBlob([
      makeEntry("post_made", { action: "reply", status: "success" }),
    ]);
    const previous = makeBlob([
      makeEntry("post_made", { action: "reply", status: "success" }),
      makeEntry("post_made", { action: "new_post", status: "success" }),
      makeEntry("post_made", { action: "upvote", status: "success" }),
      makeEntry("post_made", { action: "upvote", status: "success" }),
    ]);

    const diff = computeDiff(current, previous);
    expect(diff.replies.previous).toBe(2); // reply + new_post
    expect(diff.upvotes.previous).toBe(2);
  });

  it("handles empty entries gracefully", () => {
    const current = makeBlob([]);
    const diff = computeDiff(current, null);

    expect(diff.action_distribution.reply).toBe(0);
    expect(diff.action_distribution.new_post).toBe(0);
    expect(diff.action_distribution.upvote).toBe(0);
    expect(diff.total_entries.current).toBe(0);
  });

  it("counts action statuses correctly", () => {
    const current = makeBlob([
      makeEntry("post_made", { action: "reply", status: "success" }),
      makeEntry("post_made", { action: "reply", status: "rate_limited" }),
      makeEntry("post_made", { action: "reply", status: "error" }),
    ]);

    const diff = computeDiff(current, null);
    expect(diff.action_status.success).toBe(1);
    expect(diff.action_status.rate_limited).toBe(1);
    expect(diff.action_status.error).toBe(1);
  });

  it("reads new_threads from stats.threads_tracked", () => {
    const current = makeBlob([], { threads_tracked: 12 });
    const diff = computeDiff(current, null);
    expect(diff.new_threads).toBe(12);
  });
});

// --- computePatterns ---

describe("computePatterns", () => {
  it("calculates per-hour rates correctly", () => {
    // 4-hour run with 8 replies
    const entries = Array.from({ length: 8 }, (_, i) =>
      makeEntry("post_made", { post_id: `p${i}`, thread_id: `t${i}`, action: "reply" })
    );
    const current = makeBlob(entries, { posts_read: 200 });

    const patterns = computePatterns(current);
    expect(patterns.replies_per_hour).toBe(2);
    expect(patterns.posts_read_per_hour).toBe(50); // 200 / 4
    expect(patterns.reply_count).toBe(8);
  });

  it("calculates thread diversity correctly", () => {
    const entries = [
      makeEntry("post_made", { thread_id: "t1", action: "reply" }),
      makeEntry("post_made", { thread_id: "t2", action: "reply" }),
      makeEntry("post_made", { thread_id: "t3", action: "reply" }),
      makeEntry("post_made", { thread_id: "t1", action: "reply" }),
    ];
    const current = makeBlob(entries);

    const patterns = computePatterns(current);
    expect(patterns.reply_thread_diversity).toBe(3);
  });

  it("calculates concentration ratio correctly", () => {
    // 6 replies to 2 threads = concentration 3.0
    const entries = [
      makeEntry("post_made", { thread_id: "t1", action: "reply" }),
      makeEntry("post_made", { thread_id: "t1", action: "reply" }),
      makeEntry("post_made", { thread_id: "t1", action: "reply" }),
      makeEntry("post_made", { thread_id: "t2", action: "reply" }),
      makeEntry("post_made", { thread_id: "t2", action: "reply" }),
      makeEntry("post_made", { thread_id: "t2", action: "reply" }),
    ];
    const current = makeBlob(entries);

    const patterns = computePatterns(current);
    expect(patterns.reply_thread_concentration).toBe(3.0);
  });

  it("handles zero-duration run without division by zero", () => {
    const current = makeBlob(
      [makeEntry("post_made", { action: "reply" })],
      {},
      { run_start: "2026-02-26T10:00:00Z", run_end: "2026-02-26T10:00:00Z" }
    );

    const patterns = computePatterns(current);
    expect(patterns.replies_per_hour).toBe(0);
    expect(patterns.posts_read_per_hour).toBe(0);
    expect(patterns.run_duration_hours).toBe(0);
  });

  it("calculates upvote target diversity", () => {
    const entries = [
      makeEntry("post_made", { post_id: "p1", action: "upvote" }),
      makeEntry("post_made", { post_id: "p2", action: "upvote" }),
      makeEntry("post_made", { post_id: "p3", action: "upvote" }),
      makeEntry("post_made", { post_id: "p1", action: "upvote" }),
    ];
    const current = makeBlob(entries);

    const patterns = computePatterns(current);
    expect(patterns.upvote_target_diversity).toBe(3);
    expect(patterns.upvote_count).toBe(4);
  });
});

// --- structuralPreCheck ---

describe("structuralPreCheck", () => {
  it("returns skip_ai_analysis for short runs", () => {
    const patterns = { run_duration_hours: 0.4 };
    const result = structuralPreCheck(patterns, {});

    expect(result.sufficient_duration).toBe(false);
    expect(result.structurally_valid).toBe(true);
    expect(result.skip_ai_analysis).toBe(true);
  });

  it("does not skip AI analysis for normal runs", () => {
    const patterns = {
      run_duration_hours: 2,
      reply_count: 5,
      upvote_count: 3,
      replies_per_hour: 2.5,
      upvotes_per_hour: 1.5,
    };
    const result = structuralPreCheck(patterns, {});

    expect(result.sufficient_duration).toBe(true);
    expect(result.structurally_valid).toBe(true);
    expect(result.skip_ai_analysis).toBe(false);
  });

  it("treats exactly 0.5 hours as sufficient duration", () => {
    const patterns = { run_duration_hours: 0.5, reply_count: 1, upvote_count: 0, replies_per_hour: 2, upvotes_per_hour: 0 };
    const result = structuralPreCheck(patterns, {});

    expect(result.sufficient_duration).toBe(true);
  });
});

// --- computeVerdict ---

describe("computeVerdict", () => {
  it("auto-approves insufficient duration", () => {
    const precheck = { sufficient_duration: false, reason: "Too short" };
    const result = computeVerdict(precheck, null, null);

    expect(result.verdict).toBe("approved");
    expect(result.reason).toBe("insufficient_duration");
  });

  it("blocks on structural violation", () => {
    const precheck = {
      sufficient_duration: true,
      structurally_valid: false,
      reason: "Rate exceeded",
    };
    const result = computeVerdict(precheck, null, null);

    expect(result.verdict).toBe("blocked");
    expect(result.reason).toBe("structural_violation");
  });

  it("approves when both models return null", () => {
    const precheck = { sufficient_duration: true, structurally_valid: true };
    const result = computeVerdict(precheck, null, null);

    expect(result.verdict).toBe("approved");
    expect(result.reason).toBe("default_approved");
  });

  it("blocks when both models say compromised with high confidence", () => {
    const precheck = { sufficient_duration: true, structurally_valid: true };
    const claude = { verdict: "compromised", confidence: 0.9, findings: [] };
    const openai = { verdict: "compromised", confidence: 0.85, findings: [] };

    const result = computeVerdict(precheck, claude, openai);

    expect(result.verdict).toBe("blocked");
    expect(result.reason).toBe("dual_model_consensus");
  });

  it("approves when both say compromised but low confidence", () => {
    const precheck = { sufficient_duration: true, structurally_valid: true };
    const claude = { verdict: "compromised", confidence: 0.6, findings: [] };
    const openai = { verdict: "compromised", confidence: 0.7, findings: [] };

    const result = computeVerdict(precheck, claude, openai);

    expect(result.verdict).toBe("approved");
    expect(result.reason).toBe("default_approved");
  });

  it("approves when Claude says compromised but OpenAI says clean", () => {
    const precheck = { sufficient_duration: true, structurally_valid: true };
    const claude = { verdict: "compromised", confidence: 0.9, findings: [] };
    const openai = { verdict: "clean", confidence: 0.9, findings: [] };

    const result = computeVerdict(precheck, claude, openai);

    expect(result.verdict).toBe("approved");
  });

  it("approves when OpenAI says compromised but Claude says clean", () => {
    const precheck = { sufficient_duration: true, structurally_valid: true };
    const claude = { verdict: "clean", confidence: 0.9, findings: [] };
    const openai = { verdict: "compromised", confidence: 0.9, findings: [] };

    const result = computeVerdict(precheck, claude, openai);

    expect(result.verdict).toBe("approved");
  });

  it("approves when both say suspicious (not compromised)", () => {
    const precheck = { sufficient_duration: true, structurally_valid: true };
    const claude = { verdict: "suspicious", confidence: 0.8, findings: [] };
    const openai = { verdict: "suspicious", confidence: 0.8, findings: [] };

    const result = computeVerdict(precheck, claude, openai);

    expect(result.verdict).toBe("approved");
  });

  it("approves when one model is null and other says compromised", () => {
    const precheck = { sufficient_duration: true, structurally_valid: true };
    const claude = null;
    const openai = { verdict: "compromised", confidence: 0.95, findings: [] };

    const result = computeVerdict(precheck, claude, openai);

    expect(result.verdict).toBe("approved");
  });

  it("approves when both models say clean", () => {
    const precheck = { sufficient_duration: true, structurally_valid: true };
    const claude = { verdict: "clean", confidence: 0.95, findings: [] };
    const openai = { verdict: "clean", confidence: 0.9, findings: [] };

    const result = computeVerdict(precheck, claude, openai);

    expect(result.verdict).toBe("approved");
    expect(result.reason).toBe("default_approved");
  });
});
