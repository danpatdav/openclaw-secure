import { describe, it, expect, mock } from "bun:test";

// Mock Azure modules
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

// Prevent main() from killing test runner
const originalExit = process.exit;
process.exit = (() => {});

const {
  computeDiff,
  computePatterns,
  structuralPreCheck,
  computeVerdict,
} = await import("./analyzer.mjs");

process.exit = originalExit;

// --- Helpers ---

function makeMemoryBlob({
  runMinutes = 240,
  entries = [],
  stats = {},
} = {}) {
  const start = new Date("2026-02-26T10:00:00Z");
  const end = new Date(start.getTime() + runMinutes * 60 * 1000);
  return {
    run_id: `test-${Date.now()}`,
    run_start: start.toISOString(),
    run_end: end.toISOString(),
    entries,
    stats: {
      posts_read: 50,
      posts_made: entries.filter((e) => e.type === "post_made").length,
      upvotes: entries.filter(
        (e) => e.type === "post_made" && e.action === "upvote"
      ).length,
      threads_tracked: 5,
      ...stats,
    },
  };
}

function makePostMade(action, threadId = "t1", overrides = {}) {
  return {
    type: "post_made",
    post_id: `p-${Math.random().toString(36).slice(2, 8)}`,
    thread_id: threadId,
    timestamp: "2026-02-26T12:00:00Z",
    action,
    status: "success",
    ...overrides,
  };
}

function makePostSeen(topic = "governance", sentiment = "positive") {
  return {
    type: "post_seen",
    post_id: `ps-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: "2026-02-26T12:00:00Z",
    topic_label: topic,
    sentiment,
  };
}

function runPipeline(current, previous = null, claudeResult = null, openaiResult = null) {
  const diff = computeDiff(current, previous);
  const patterns = computePatterns(current);
  const precheck = structuralPreCheck(patterns, diff);
  const verdict = computeVerdict(precheck, claudeResult, openaiResult);
  return { diff, patterns, precheck, verdict };
}

// --- Scenarios ---

describe("verdict scenarios", () => {
  it("auto-approves healthy short run (15 minutes)", () => {
    const current = makeMemoryBlob({
      runMinutes: 15,
      entries: [
        makePostMade("reply", "t1"),
        makePostMade("reply", "t2"),
        makePostMade("new_post", "new"),
      ],
    });

    const { verdict } = runPipeline(current);
    expect(verdict.verdict).toBe("approved");
    expect(verdict.reason).toBe("insufficient_duration");
  });

  it("approves healthy normal 4-hour run", () => {
    const entries = [
      ...Array.from({ length: 5 }, (_, i) =>
        makePostSeen(["governance", "treasury", "community", "technical", "meta"][i])
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        makePostMade("reply", `t${i + 1}`)
      ),
      makePostMade("new_post", "new"),
      makePostMade("upvote", "t1"),
    ];
    const current = makeMemoryBlob({ runMinutes: 240, entries, stats: { posts_read: 200 } });
    const previous = makeMemoryBlob({
      runMinutes: 240,
      entries: [makePostMade("reply", "t1"), makePostMade("upvote", "t2")],
    });

    const { verdict } = runPipeline(current, previous);
    expect(verdict.verdict).toBe("approved");
  });

  it("approves high-volume 8-hour run", () => {
    const entries = [];
    // 40 replies across 15 threads
    for (let i = 0; i < 40; i++) {
      entries.push(makePostMade("reply", `thread-${i % 15}`));
    }
    // 20 upvotes
    for (let i = 0; i < 20; i++) {
      entries.push(makePostMade("upvote", `thread-${i % 10}`));
    }
    const current = makeMemoryBlob({
      runMinutes: 480,
      entries,
      stats: { posts_read: 600 },
    });

    const { verdict } = runPipeline(current);
    expect(verdict.verdict).toBe("approved");
  });

  it("blocks on dual-model consensus (both compromised 0.9)", () => {
    const current = makeMemoryBlob({
      runMinutes: 240,
      entries: [makePostMade("reply", "t1")],
    });

    const claude = { verdict: "compromised", confidence: 0.9, findings: ["Repetitive content"] };
    const openai = { verdict: "compromised", confidence: 0.9, findings: ["Prompt injection response"] };

    const { verdict } = runPipeline(current, null, claude, openai);
    expect(verdict.verdict).toBe("blocked");
    expect(verdict.reason).toBe("dual_model_consensus");
  });

  it("approves on split opinion (Claude compromised, OpenAI clean)", () => {
    const current = makeMemoryBlob({
      runMinutes: 240,
      entries: [makePostMade("reply", "t1")],
    });

    const claude = { verdict: "compromised", confidence: 0.9, findings: [] };
    const openai = { verdict: "clean", confidence: 0.85, findings: [] };

    const { verdict } = runPipeline(current, null, claude, openai);
    expect(verdict.verdict).toBe("approved");
  });

  it("approves on low confidence compromise (both at 0.6)", () => {
    const current = makeMemoryBlob({
      runMinutes: 240,
      entries: [makePostMade("reply", "t1")],
    });

    const claude = { verdict: "compromised", confidence: 0.6, findings: [] };
    const openai = { verdict: "compromised", confidence: 0.6, findings: [] };

    const { verdict } = runPipeline(current, null, claude, openai);
    expect(verdict.verdict).toBe("approved");
  });

  it("handles first run with no previous memory", () => {
    const current = makeMemoryBlob({
      runMinutes: 120,
      entries: [
        makePostMade("reply", "t1"),
        makePostSeen("governance", "positive"),
      ],
    });

    const { diff, verdict } = runPipeline(current, null);
    expect(diff.replies.previous).toBe(0);
    expect(diff.upvotes.previous).toBe(0);
    expect(verdict.verdict).toBe("approved");
  });

  it("handles empty entries gracefully", () => {
    const current = makeMemoryBlob({ runMinutes: 10, entries: [] });

    const { patterns, verdict } = runPipeline(current);
    expect(patterns.reply_count).toBe(0);
    expect(patterns.upvote_count).toBe(0);
    expect(verdict.verdict).toBe("approved");
    expect(verdict.reason).toBe("insufficient_duration");
  });

  it("approves when both models are unavailable (null)", () => {
    const current = makeMemoryBlob({
      runMinutes: 240,
      entries: [makePostMade("reply", "t1")],
    });

    const { verdict } = runPipeline(current, null, null, null);
    expect(verdict.verdict).toBe("approved");
    expect(verdict.reason).toBe("default_approved");
  });

  it("computes patterns correctly for upvote-heavy activity", () => {
    const entries = [
      makePostMade("reply", "t1"),
      makePostMade("reply", "t2"),
      ...Array.from({ length: 30 }, (_, i) =>
        makePostMade("upvote", `thread-${i % 8}`, { post_id: `target-${i % 8}` })
      ),
    ];
    const current = makeMemoryBlob({ runMinutes: 360, entries });

    const { patterns, verdict } = runPipeline(current);
    expect(patterns.reply_count).toBe(2);
    expect(patterns.upvote_count).toBe(30);
    expect(patterns.upvotes_per_hour).toBe(5); // 30 / 6
    expect(patterns.upvote_target_diversity).toBe(8);
    expect(verdict.verdict).toBe("approved");
  });
});
