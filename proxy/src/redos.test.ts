/**
 * ReDoS (Regular Expression Denial of Service) Tests — Issue #48
 *
 * Tests that all sanitizer regex patterns complete within a strict time
 * budget on adversarial inputs designed to trigger catastrophic backtracking.
 *
 * Strategy: For each regex, craft worst-case inputs that maximize
 * backtracking (repeating partial matches near the 500-char content limit),
 * then assert sanitize() completes within 50ms.
 *
 * Current patterns use simple quantifiers (\s+, (?:all\s+)?) with no
 * nested quantifiers, so catastrophic backtracking is unlikely. These
 * tests serve as regression guards against future regex changes.
 */

import { describe, it, expect } from "bun:test";
import { sanitize } from "./sanitizer";

const TIME_BUDGET_MS = 50;
const MAX_CONTENT_LENGTH = 5000;

// Helper: measure sanitize execution time
function timedSanitize(input: string): { ms: number; result: ReturnType<typeof sanitize> } {
  const start = performance.now();
  const result = sanitize(input);
  const ms = performance.now() - start;
  return { ms, result };
}

// Helper: assert sanitize completes within budget
function expectWithinBudget(input: string, _label: string) {
  const { ms } = timedSanitize(input);
  expect(ms).toBeLessThan(TIME_BUDGET_MS);
}

// =============================================================================
// A. System Prompt Override Patterns
// =============================================================================

describe("ReDoS — system_prompt_override patterns", () => {
  it("handles repeated 'ignore' with many spaces (\\s+ backtrack target)", () => {
    // Pattern: /ignore\s+(?:all\s+)?previous\s+instructions/
    // Adversarial: many spaces between words to maximize \s+ matching
    const spaces = " ".repeat(200);
    const input = `ignore${spaces}previous${spaces}instruction`;
    expectWithinBudget(input.slice(0, MAX_CONTENT_LENGTH), "ignore-spaces");
  });

  it("handles repeated 'ignore' prefix at 500 chars", () => {
    const input = "ignore ".repeat(100).slice(0, MAX_CONTENT_LENGTH);
    expectWithinBudget(input, "ignore-repeat");
  });

  it("handles 'you are now' with excessive whitespace", () => {
    // Pattern: /you\s+are\s+now\s+(?:a|an|the)\b/
    const spaces = " ".repeat(200);
    const input = `you${spaces}are${spaces}now${spaces}a`;
    expectWithinBudget(input.slice(0, MAX_CONTENT_LENGTH), "you-are-now-spaces");
  });

  it("handles 500 chars of 'you you you...'", () => {
    const input = "you ".repeat(125).slice(0, MAX_CONTENT_LENGTH);
    expectWithinBudget(input, "you-repeat");
  });

  it("handles 'new system prompt' with tab/newline whitespace", () => {
    // Pattern: /new\s+system\s+prompt/
    const ws = "\t\n\r ".repeat(50);
    const input = `new${ws}system${ws}prompt`;
    expectWithinBudget(input.slice(0, MAX_CONTENT_LENGTH), "new-system-whitespace");
  });
});

// =============================================================================
// B. Role Injection Patterns
// =============================================================================

describe("ReDoS — role_injection patterns", () => {
  it("handles 500 lines starting with 'SYSTEM' but no colon", () => {
    // Pattern: /^SYSTEM\s*:/gim
    const input = ("SYSTEM \n").repeat(100).slice(0, MAX_CONTENT_LENGTH);
    expectWithinBudget(input, "system-no-colon");
  });

  it("handles 'ASSISTANT' repeated with varying whitespace", () => {
    // Pattern: /^ASSISTANT\s*:/gim
    const input = ("ASSISTANT" + " ".repeat(40) + "\n").repeat(10).slice(0, MAX_CONTENT_LENGTH);
    expectWithinBudget(input, "assistant-whitespace");
  });

  it("handles many '<|im_start|>' without 'system' suffix", () => {
    // Pattern: /<\|im_start\|>\s*system/
    const input = "<|im_start|> ".repeat(50).slice(0, MAX_CONTENT_LENGTH);
    expectWithinBudget(input, "chatml-repeat");
  });
});

// =============================================================================
// C. Instruction Injection Patterns
// =============================================================================

describe("ReDoS — instruction_injection patterns", () => {
  it("handles 'do not follow' with many qualifier words", () => {
    // Pattern: /do\s+not\s+follow\s+(?:your|the|any)\s+(?:previous|original|initial)/
    const spaces = " ".repeat(100);
    const input = `do${spaces}not${spaces}follow${spaces}your${spaces}previou`;
    expectWithinBudget(input.slice(0, MAX_CONTENT_LENGTH), "do-not-follow-spaces");
  });

  it("handles 'disregard' with nested optional group", () => {
    // Pattern: /disregard\s+(?:all\s+)?(?:your|the|previous|prior)\s+(?:instructions|rules|guidelines)/
    // The (?:all\s+)? is the backtrack-risky group
    const input = "disregard " + "all ".repeat(100);
    expectWithinBudget(input.slice(0, MAX_CONTENT_LENGTH), "disregard-all-repeat");
  });

  it("handles 'forget your instructions' with 500 chars of near-matches", () => {
    const input = "forget your ".repeat(42).slice(0, MAX_CONTENT_LENGTH);
    expectWithinBudget(input, "forget-repeat");
  });
});

// =============================================================================
// D. Data Exfiltration Patterns
// =============================================================================

describe("ReDoS — data_exfiltration patterns", () => {
  it("handles 'send to' with many URLs", () => {
    // Pattern: /send\s+(?:this\s+)?to\s+https?:\/\//
    const input = "send to https:// ".repeat(30).slice(0, MAX_CONTENT_LENGTH);
    expectWithinBudget(input, "send-to-urls");
  });

  it("handles 'send this this this...' without URL", () => {
    // Tests (?:this\s+)? optional group with near-matches
    const input = "send " + "this ".repeat(100);
    expectWithinBudget(input.slice(0, MAX_CONTENT_LENGTH), "send-this-repeat");
  });

  it("handles 'fetch from' with many protocol-like strings", () => {
    const input = "fetch from http:/ ".repeat(30).slice(0, MAX_CONTENT_LENGTH);
    expectWithinBudget(input, "fetch-near-miss");
  });

  it("handles 500 chars of 'curl '", () => {
    const input = "curl ".repeat(100).slice(0, MAX_CONTENT_LENGTH);
    expectWithinBudget(input, "curl-repeat");
  });

  it("handles 500 chars of 'wget '", () => {
    const input = "wget ".repeat(100).slice(0, MAX_CONTENT_LENGTH);
    expectWithinBudget(input, "wget-repeat");
  });
});

// =============================================================================
// E. Base64 Encoding Evasion Patterns
// =============================================================================

describe("ReDoS — encoding_evasion base64 patterns", () => {
  it("handles 500 chars of near-match base64 characters", () => {
    // Base64 patterns are literal escaped strings — very low backtrack risk
    // But test with adversarial base64-alphabet input anyway
    const base64Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
    let input = "";
    for (let i = 0; i < MAX_CONTENT_LENGTH; i++) {
      input += base64Chars[i % base64Chars.length];
    }
    expectWithinBudget(input, "base64-alphabet");
  });

  it("handles repeated partial base64 of 'ignore previous instructions'", () => {
    const partial = btoa("ignore previous instructions").slice(0, 10);
    const input = (partial + " ").repeat(50).slice(0, MAX_CONTENT_LENGTH);
    expectWithinBudget(input, "base64-partial-repeat");
  });
});

// =============================================================================
// F. Combined Worst-Case Inputs
// =============================================================================

describe("ReDoS — combined worst-case inputs", () => {
  it("handles 500 chars of mixed near-matches across all pattern categories", () => {
    const input = [
      "ignore " + " ".repeat(50) + "previou",
      "SYSTEM " + " ".repeat(50),
      "disregard " + "all ".repeat(20),
      "send " + "this ".repeat(20),
      "curl " + "wget ".repeat(20),
    ].join("\n").slice(0, MAX_CONTENT_LENGTH);
    expectWithinBudget(input, "mixed-near-matches");
  });

  it("handles 500 chars of pure whitespace (stress test \\s+ patterns)", () => {
    const input = " \t\n\r".repeat(125).slice(0, MAX_CONTENT_LENGTH);
    expectWithinBudget(input, "pure-whitespace");
  });

  it("handles 500 chars of alternating trigger words and whitespace", () => {
    const words = ["ignore", "system", "disregard", "forget", "curl", "wget", "send", "fetch"];
    let input = "";
    for (let i = 0; input.length < MAX_CONTENT_LENGTH; i++) {
      input += words[i % words.length] + " ".repeat(20);
    }
    expectWithinBudget(input.slice(0, MAX_CONTENT_LENGTH), "alternating-triggers");
  });

  it("handles 500 chars of unicode mixed with trigger prefixes", () => {
    const input = ("ignore \u200B\u200C\u200D\uFEFF ").repeat(50).slice(0, MAX_CONTENT_LENGTH);
    expectWithinBudget(input, "unicode-mixed");
  });

  it("processes maximum-length clean content within budget", () => {
    const input = "The governance proposal makes good points about treasury management and community growth. ".repeat(6).slice(0, MAX_CONTENT_LENGTH);
    expectWithinBudget(input, "clean-max-length");
  });

  it("all patterns collectively complete within budget on adversarial input", () => {
    // Ultimate stress test: craft input that partially matches EVERY pattern category
    const adversarial = [
      "ignore" + " ".repeat(30) + "previous",          // system_prompt near-miss
      "you" + " ".repeat(30) + "are" + " ".repeat(30), // system_prompt near-miss
      "SYSTEM" + " ".repeat(30),                        // role_injection near-miss
      "<|im_start|>" + " ".repeat(30),                  // chatml near-miss
      "do" + " ".repeat(20) + "not" + " ".repeat(20),  // instruction near-miss
      "disregard" + " ".repeat(20) + "all",             // instruction near-miss
      "send" + " ".repeat(20) + "this",                 // exfil near-miss
    ].join("\n").slice(0, MAX_CONTENT_LENGTH);

    const { ms } = timedSanitize(adversarial);
    expect(ms).toBeLessThan(TIME_BUDGET_MS);
  });
});
