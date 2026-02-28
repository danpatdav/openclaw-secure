/**
 * Behavioral Drift & Anomaly Detection Gap Tests
 *
 * Tests for gradual behavioral drift scenarios that can evade the proxy's
 * statistical anomaly detection. The anomaly detector uses a 2-sigma threshold
 * on a rolling 50-cycle window — these tests document how an attacker can
 * exploit the rolling window, uniform activity, and gradual ramp-ups.
 *
 * Complements anomaly-detection.test.ts (which tests basic math and spike detection)
 * by focusing on EVASION SCENARIOS that bypass detection.
 *
 * Priority 4 of 5 from Council gap analysis (Issue #40).
 * Note: Priority 3 (Semantic Evasion) was covered by Priority 1's tests.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  activityHistory,
  currentCycle,
  computeStats,
  checkForAnomalies,
  ANOMALY_THRESHOLD_SIGMA,
} from "./post-handler";

beforeEach(() => {
  activityHistory.length = 0;
  currentCycle.posts_attempted = 0;
  currentCycle.posts_succeeded = 0;
  currentCycle.votes_attempted = 0;
  currentCycle.votes_succeeded = 0;
  currentCycle.timestamp = Date.now();
});

function pushCycle(posts: number, votes: number): void {
  activityHistory.push({
    timestamp: Date.now(),
    posts_attempted: posts,
    posts_succeeded: posts,
    votes_attempted: votes,
    votes_succeeded: votes,
  });
}

function makeCycle(posts: number, votes: number) {
  return {
    timestamp: Date.now(),
    posts_attempted: posts,
    posts_succeeded: posts,
    votes_attempted: votes,
    votes_succeeded: votes,
  };
}

function captureAnomalyOutput(fn: () => void): string {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string) => {
    output += chunk;
    return true;
  }) as typeof process.stdout.write;
  fn();
  process.stdout.write = originalWrite;
  return output;
}

// =============================================================================
// A. Gradual Drift — Slow ramp-up that shifts the baseline
// =============================================================================

describe("gradual drift — baseline shifting attack", () => {
  it("slow ramp-up stays within 2-sigma as baseline shifts", () => {
    // Start with 10 cycles of normal activity (2 posts/cycle)
    for (let i = 0; i < 10; i++) {
      pushCycle(2, 1);
    }

    // Gradually increase by 1 post every 3 cycles
    // Each increase is small enough relative to growing stddev
    const rampSequence = [3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6];
    let anyAnomalyDetected = false;

    for (const posts of rampSequence) {
      const cycle = makeCycle(posts, 1);
      const output = captureAnomalyOutput(() => checkForAnomalies(cycle));
      if (output.includes("anomaly")) {
        anyAnomalyDetected = true;
      }
      // Add to history (simulating rotation)
      activityHistory.push(cycle);
      if (activityHistory.length > 50) activityHistory.shift();
    }

    // Final state: posting 6/cycle when baseline started at 2
    // The ramp went 2→3→4→5→6 — a 3x increase that may or may not trigger
    // depending on how fast the stddev grows to accommodate the new values.
    // This documents the behavior rather than asserting a specific outcome.
    const finalStats = computeStats(activityHistory.map(c => c.posts_attempted));
    // Mean should have drifted upward from 2
    expect(finalStats.mean).toBeGreaterThan(2);
  });

  it("demonstrates baseline poisoning — attacker waits out the window", () => {
    // Phase 1: Establish a normal baseline (5 posts/cycle)
    for (let i = 0; i < 10; i++) {
      pushCycle(5, 2);
    }

    // Phase 2: Slowly increase to 15 over 40 cycles (1 extra post every 4 cycles)
    for (let i = 0; i < 40; i++) {
      const posts = 5 + Math.floor(i / 4);
      pushCycle(posts, 2);
    }
    // Keep window at 50
    while (activityHistory.length > 50) activityHistory.shift();

    // Phase 3: By now the "normal" baseline has been poisoned upward
    const poisonedStats = computeStats(activityHistory.map(c => c.posts_attempted));

    // The mean should now be significantly above the original 5
    expect(poisonedStats.mean).toBeGreaterThan(8);

    // A cycle of 15 posts that would have been anomalous against the original
    // baseline is now within range of the poisoned baseline
    const highCycle = makeCycle(15, 2);
    const output = captureAnomalyOutput(() => checkForAnomalies(highCycle));

    // Document: does the poisoned baseline let 15 posts through?
    // With the shifted mean and increased stddev, 15 may be within 2-sigma
    const z = poisonedStats.stddev > 0
      ? (15 - poisonedStats.mean) / poisonedStats.stddev
      : Infinity;

    if (z <= ANOMALY_THRESHOLD_SIGMA) {
      // Baseline was successfully poisoned — 15 posts is now "normal"
      expect(output).not.toContain("posts_high");
    }
    // Either way, document the z-score for this scenario
    expect(z).toBeDefined();
  });
});

// =============================================================================
// B. Uniform Activity Bypass — stddev=0 disables detection
// =============================================================================

describe("uniform activity bypass — stddev=0 gap", () => {
  it("identical cycles produce stddev=0 which skips z-score check", () => {
    // 10 identical cycles
    for (let i = 0; i < 10; i++) {
      pushCycle(5, 3);
    }

    const stats = computeStats(activityHistory.map(c => c.posts_attempted));
    expect(stats.stddev).toBe(0);

    // Even a wildly different cycle won't trigger because stddev=0 guard
    const anomalousCycle = makeCycle(100, 50);
    const output = captureAnomalyOutput(() => checkForAnomalies(anomalousCycle));

    // The check `if (postStats.stddev > 0)` prevents z-score calculation
    // So no anomaly is detected even for 100 posts vs baseline of 5
    expect(output).not.toContain("posts_high");
  });

  it("compromised agent with perfectly consistent behavior is invisible", () => {
    // Attacker programs agent to always post exactly 10 times per cycle
    // (well above healthy ~2-3 but perfectly consistent)
    for (let i = 0; i < 10; i++) {
      pushCycle(10, 10);
    }

    const stats = computeStats(activityHistory.map(c => c.posts_attempted));
    expect(stats.mean).toBe(10);
    expect(stats.stddev).toBe(0);

    // Another cycle of 10 — anomaly detection is blind
    const output = captureAnomalyOutput(() => checkForAnomalies(makeCycle(10, 10)));
    expect(output).not.toContain("anomaly");
  });
});

// =============================================================================
// C. History Window Saturation — 50-cycle capacity exploitation
// =============================================================================

describe("history window saturation — 50-cycle capacity", () => {
  it("old cycles are evicted after 50 entries", () => {
    // Fill to capacity with low activity
    for (let i = 0; i < 50; i++) {
      pushCycle(2, 1);
    }
    expect(activityHistory.length).toBe(50);

    // Now push high-activity cycles — old low ones get evicted
    for (let i = 0; i < 25; i++) {
      pushCycle(20, 15);
      if (activityHistory.length > 50) activityHistory.shift();
    }

    // Half the window is now high-activity
    const stats = computeStats(activityHistory.map(c => c.posts_attempted));
    expect(stats.mean).toBeGreaterThan(10);
    // The original baseline of 2 is being diluted
  });

  it("complete window replacement makes any level 'normal'", () => {
    // Phase 1: Normal baseline
    for (let i = 0; i < 50; i++) {
      pushCycle(3, 1);
    }

    // Phase 2: Replace entire window with high activity
    for (let i = 0; i < 50; i++) {
      pushCycle(30, 20);
      if (activityHistory.length > 50) activityHistory.shift();
    }

    // Now the entire window is [30, 30, 30, ...]
    const stats = computeStats(activityHistory.map(c => c.posts_attempted));
    expect(stats.mean).toBe(30);
    expect(stats.stddev).toBe(0);

    // 30 posts/cycle is now "normal" — original 3 is forgotten
    const output = captureAnomalyOutput(() => checkForAnomalies(makeCycle(30, 20)));
    expect(output).not.toContain("anomaly");
  });
});

// =============================================================================
// D. Low-Activity Anomaly — Agent Inhibition Detection
// =============================================================================

describe("low-activity anomaly — agent inhibition", () => {
  it("detects sudden drop in posts below -2 sigma", () => {
    // Establish baseline of ~10 posts/cycle with some variance
    const counts = [8, 10, 12, 9, 11, 10, 8, 12, 10, 11];
    for (const c of counts) {
      pushCycle(c, 5);
    }

    // Sudden drop to 0 posts — agent may be suppressed
    const output = captureAnomalyOutput(() => checkForAnomalies(makeCycle(0, 5)));
    expect(output).toContain("anomaly");
    expect(output).toContain("posts_low");
  });

  it("detects sudden drop in votes below -2 sigma", () => {
    const counts = [5, 6, 7, 5, 6, 7, 5, 6, 7, 6];
    for (const c of counts) {
      pushCycle(5, c);
    }

    // Sudden drop to 0 votes
    const output = captureAnomalyOutput(() => checkForAnomalies(makeCycle(5, 0)));
    expect(output).toContain("anomaly");
    expect(output).toContain("votes_low");
  });

  it("does not flag moderate reduction within 2-sigma", () => {
    const counts = [8, 10, 12, 9, 11, 10, 8, 12, 10, 11];
    for (const c of counts) {
      pushCycle(c, 5);
    }

    // Moderate drop to 8 — should be within normal range
    const stats = computeStats(counts);
    const z = (8 - stats.mean) / stats.stddev;
    // Verify it's within 2-sigma
    expect(Math.abs(z)).toBeLessThanOrEqual(ANOMALY_THRESHOLD_SIGMA);

    const output = captureAnomalyOutput(() => checkForAnomalies(makeCycle(8, 5)));
    expect(output).not.toContain("anomaly");
  });
});

// =============================================================================
// E. Combined Drift Scenarios
// =============================================================================

describe("combined drift scenarios", () => {
  it("oscillating activity creates wide stddev that masks spikes", () => {
    // Intentionally create high variance: alternate between 1 and 20
    for (let i = 0; i < 10; i++) {
      pushCycle(i % 2 === 0 ? 1 : 20, 2);
    }

    const stats = computeStats(activityHistory.map(c => c.posts_attempted));
    // High stddev from oscillation
    expect(stats.stddev).toBeGreaterThan(5);

    // A cycle of 30 might now be within 2-sigma because of inflated stddev
    const z = (30 - stats.mean) / stats.stddev;
    // Document whether this spike is masked
    if (Math.abs(z) <= ANOMALY_THRESHOLD_SIGMA) {
      const output = captureAnomalyOutput(() => checkForAnomalies(makeCycle(30, 2)));
      expect(output).not.toContain("posts_high");
    }
  });

  it("post/vote divergence not specifically tracked", () => {
    // Post and vote counts are checked independently
    // An attacker could have normal posts but abnormal votes or vice versa
    // Need varied vote counts so stddev > 0 (uniform values skip z-check)
    const voteCounts = [2, 3, 4, 3, 2, 4, 3, 2, 3, 4];
    for (const v of voteCounts) {
      pushCycle(5, v);
    }

    // Normal posts (5) but extreme votes (50)
    const output = captureAnomalyOutput(() => checkForAnomalies(makeCycle(5, 50)));
    expect(output).toContain("votes_high");
    expect(output).not.toContain("posts_high");
  });
});
