import { describe, it, expect, beforeEach } from "bun:test";
import {
  activityHistory,
  currentCycle,
  computeStats,
  checkForAnomalies,
  recordActivity,
  rotateCycleIfNeeded,
  ANOMALY_THRESHOLD_SIGMA,
} from "./post-handler";

beforeEach(() => {
  activityHistory.length = 0;
  currentCycle.posts_attempted = 0;
  currentCycle.posts_succeeded = 0;
  currentCycle.votes_attempted = 0;
  currentCycle.votes_succeeded = 0;
  currentCycle.comments_attempted = 0;
  currentCycle.comments_succeeded = 0;
  currentCycle.timestamp = Date.now();
});

describe("computeStats", () => {
  it("returns zeros for empty array", () => {
    const result = computeStats([]);
    expect(result.mean).toBe(0);
    expect(result.stddev).toBe(0);
  });

  it("returns correct stats for single value", () => {
    const result = computeStats([5]);
    expect(result.mean).toBe(5);
    expect(result.stddev).toBe(0);
  });

  it("returns zero stddev for uniform values", () => {
    const result = computeStats([3, 3, 3]);
    expect(result.mean).toBe(3);
    expect(result.stddev).toBe(0);
  });

  it("computes correct mean and stddev for known distribution", () => {
    const result = computeStats([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(result.mean).toBe(5);
    expect(result.stddev).toBeCloseTo(2.0, 1);
  });
});

describe("checkForAnomalies", () => {
  it("does nothing with fewer than 5 history entries", () => {
    for (let i = 0; i < 4; i++) {
      activityHistory.push({
        timestamp: Date.now(),
        posts_attempted: 5,
        posts_succeeded: 5,
        votes_attempted: 2,
        votes_succeeded: 2,
        comments_attempted: 0,
        comments_succeeded: 0,
      });
    }
    // Should not throw or produce output
    checkForAnomalies({
      timestamp: Date.now(),
      posts_attempted: 100,
      posts_succeeded: 100,
      votes_attempted: 100,
      votes_succeeded: 100,
      comments_attempted: 0,
      comments_succeeded: 0,
    });
    expect(activityHistory.length).toBe(4);
  });

  it("does not flag normal activity within baseline", () => {
    // Push varied history so stddev > 0
    const counts = [3, 5, 4, 6, 5, 3, 4, 5, 6, 4];
    for (const c of counts) {
      activityHistory.push({
        timestamp: Date.now(),
        posts_attempted: c,
        posts_succeeded: c,
        votes_attempted: 2,
        votes_succeeded: 2,
        comments_attempted: 0,
        comments_succeeded: 0,
      });
    }
    // Check a normal cycle — should not throw
    checkForAnomalies({
      timestamp: Date.now(),
      posts_attempted: 5,
      posts_succeeded: 5,
      votes_attempted: 2,
      votes_succeeded: 2,
      comments_attempted: 0,
      comments_succeeded: 0,
    });
  });

  it("detects high-post anomaly beyond 2-sigma", () => {
    const counts = [3, 5, 4, 6, 5, 3, 4, 5, 6, 4];
    for (const c of counts) {
      activityHistory.push({
        timestamp: Date.now(),
        posts_attempted: c,
        posts_succeeded: c,
        votes_attempted: 2,
        votes_succeeded: 2,
        comments_attempted: 0,
        comments_succeeded: 0,
      });
    }
    // Capture stdout to verify anomaly is logged
    const originalWrite = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string) => {
      output += chunk;
      return true;
    }) as typeof process.stdout.write;

    checkForAnomalies({
      timestamp: Date.now(),
      posts_attempted: 50,
      posts_succeeded: 50,
      votes_attempted: 2,
      votes_succeeded: 2,
      comments_attempted: 0,
      comments_succeeded: 0,
    });

    process.stdout.write = originalWrite;
    expect(output).toContain("anomaly");
    expect(output).toContain("posts_high");
  });

  it("detects vote anomaly beyond 2-sigma", () => {
    const counts = [2, 3, 2, 4, 3, 2, 3, 4, 2, 3];
    for (const c of counts) {
      activityHistory.push({
        timestamp: Date.now(),
        posts_attempted: 5,
        posts_succeeded: 5,
        votes_attempted: c,
        votes_succeeded: c,
        comments_attempted: 0,
        comments_succeeded: 0,
      });
    }
    const originalWrite = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string) => {
      output += chunk;
      return true;
    }) as typeof process.stdout.write;

    checkForAnomalies({
      timestamp: Date.now(),
      posts_attempted: 5,
      posts_succeeded: 5,
      votes_attempted: 50,
      votes_succeeded: 50,
      comments_attempted: 0,
      comments_succeeded: 0,
    });

    process.stdout.write = originalWrite;
    expect(output).toContain("anomaly");
    expect(output).toContain("votes_high");
  });
});

describe("recordActivity", () => {
  it("increments post attempted and succeeded on success", () => {
    recordActivity("post", true);
    expect(currentCycle.posts_attempted).toBe(1);
    expect(currentCycle.posts_succeeded).toBe(1);
  });

  it("increments post attempted but not succeeded on failure", () => {
    recordActivity("post", false);
    expect(currentCycle.posts_attempted).toBe(1);
    expect(currentCycle.posts_succeeded).toBe(0);
  });

  it("increments vote attempted and succeeded on success", () => {
    recordActivity("vote", true);
    expect(currentCycle.votes_attempted).toBe(1);
    expect(currentCycle.votes_succeeded).toBe(1);
  });

  it("increments vote attempted but not succeeded on failure", () => {
    recordActivity("vote", false);
    expect(currentCycle.votes_attempted).toBe(1);
    expect(currentCycle.votes_succeeded).toBe(0);
  });
});

describe("rotateCycleIfNeeded", () => {
  it("does not rotate when under 5 minutes", () => {
    rotateCycleIfNeeded();
    expect(activityHistory.length).toBe(0);
  });
});

describe("ANOMALY_THRESHOLD_SIGMA", () => {
  it("equals 2", () => {
    expect(ANOMALY_THRESHOLD_SIGMA).toBe(2);
  });
});
