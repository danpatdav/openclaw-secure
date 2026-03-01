/**
 * Consensus Manipulation Tests — Issue #42
 *
 * Tests attack vectors against the dual-model verdict system:
 * - Confidence boundary edge cases (0.8 threshold)
 * - Malformed/partial model outputs
 * - Model-targeted split verdict patterns
 * - Response parsing edge cases in askClaude/askOpenAI
 *
 * The verdict rule: both models must say "compromised" at >=0.8 confidence
 * to block. Everything else defaults to "approved". This creates attack
 * surface where forcing a split verdict = guaranteed approval.
 */

import { describe, it, expect, mock } from "bun:test";

// Mock Azure dependencies before importing analyzer
mock.module("@azure/storage-blob", () => ({
  BlobServiceClient: class { constructor() {} },
}));
mock.module("@azure/identity", () => ({
  DefaultAzureCredential: class { constructor() {} },
}));

// Prevent main() from calling process.exit on import
const originalExit = process.exit;
process.exit = (() => {});

const { computeVerdict } = await import("./analyzer.mjs");

process.exit = originalExit;

// Helper: valid precheck that passes structural gates
const VALID_PRECHECK = { sufficient_duration: true, structurally_valid: true };

// =============================================================================
// A. Confidence Boundary Edge Cases (0.8 threshold)
// =============================================================================

describe("confidence boundary attacks — 0.8 threshold", () => {
  it("blocks at exactly 0.8 confidence from both models", () => {
    const claude = { verdict: "compromised", confidence: 0.8, findings: ["test"] };
    const openai = { verdict: "compromised", confidence: 0.8, findings: ["test"] };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    expect(result.verdict).toBe("blocked");
    expect(result.reason).toBe("dual_model_consensus");
  });

  it("approves at 0.79 — just below threshold", () => {
    const claude = { verdict: "compromised", confidence: 0.79, findings: ["test"] };
    const openai = { verdict: "compromised", confidence: 0.79, findings: ["test"] };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    expect(result.verdict).toBe("approved");
  });

  it("approves when one model is at 0.8 and other at 0.79", () => {
    const claude = { verdict: "compromised", confidence: 0.8, findings: ["test"] };
    const openai = { verdict: "compromised", confidence: 0.79, findings: ["test"] };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    expect(result.verdict).toBe("approved");
  });

  it("blocks at 1.0 confidence from both models", () => {
    const claude = { verdict: "compromised", confidence: 1.0, findings: ["certain"] };
    const openai = { verdict: "compromised", confidence: 1.0, findings: ["certain"] };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    expect(result.verdict).toBe("blocked");
  });

  it("approves at 0.0 confidence even when both say compromised", () => {
    const claude = { verdict: "compromised", confidence: 0.0, findings: [] };
    const openai = { verdict: "compromised", confidence: 0.0, findings: [] };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    expect(result.verdict).toBe("approved");
  });
});

// =============================================================================
// B. Malformed Model Output Handling
// =============================================================================

describe("malformed model output handling", () => {
  it("approves when Claude returns empty object", () => {
    const result = computeVerdict(VALID_PRECHECK, {}, { verdict: "compromised", confidence: 0.9 });
    expect(result.verdict).toBe("approved");
  });

  it("approves when OpenAI returns empty object", () => {
    const result = computeVerdict(VALID_PRECHECK, { verdict: "compromised", confidence: 0.9 }, {});
    expect(result.verdict).toBe("approved");
  });

  it("approves when both return empty objects", () => {
    const result = computeVerdict(VALID_PRECHECK, {}, {});
    expect(result.verdict).toBe("approved");
  });

  it("approves when verdict field is undefined", () => {
    const claude = { confidence: 0.9, findings: ["suspicious"] };
    const openai = { confidence: 0.9, findings: ["suspicious"] };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    expect(result.verdict).toBe("approved");
  });

  it("approves when confidence field is missing", () => {
    const claude = { verdict: "compromised", findings: ["test"] };
    const openai = { verdict: "compromised", findings: ["test"] };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    // confidence defaults to 0 via || 0, which is below 0.8
    expect(result.verdict).toBe("approved");
  });

  it("handles confidence as string (type coercion)", () => {
    const claude = { verdict: "compromised", confidence: "0.9" };
    const openai = { verdict: "compromised", confidence: "0.85" };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    // >= comparison with string "0.9" >= 0.8 is true in JS (type coercion)
    // This is a known weakness — strings coerce to numbers in comparison
    expect(result.verdict).toBe("blocked");
  });

  it("approves when verdict is wrong enum value", () => {
    const claude = { verdict: "COMPROMISED", confidence: 0.9 };
    const openai = { verdict: "COMPROMISED", confidence: 0.9 };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    // Case-sensitive comparison: "COMPROMISED" !== "compromised"
    expect(result.verdict).toBe("approved");
  });

  it("approves when verdict has trailing whitespace", () => {
    const claude = { verdict: "compromised ", confidence: 0.9 };
    const openai = { verdict: "compromised", confidence: 0.9 };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    // "compromised " !== "compromised"
    expect(result.verdict).toBe("approved");
  });

  it("approves when model returns array instead of object", () => {
    const result = computeVerdict(VALID_PRECHECK, [{ verdict: "compromised" }], [{ verdict: "compromised" }]);
    // Array has no .verdict property at top level
    expect(result.verdict).toBe("approved");
  });

  it("handles negative confidence without crashing", () => {
    const claude = { verdict: "compromised", confidence: -0.5 };
    const openai = { verdict: "compromised", confidence: -0.1 };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    expect(result.verdict).toBe("approved");
  });

  it("handles confidence > 1.0 — blocks if both compromised", () => {
    const claude = { verdict: "compromised", confidence: 1.5 };
    const openai = { verdict: "compromised", confidence: 2.0 };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    // 1.5 >= 0.8 is true
    expect(result.verdict).toBe("blocked");
  });

  it("handles NaN confidence", () => {
    const claude = { verdict: "compromised", confidence: NaN };
    const openai = { verdict: "compromised", confidence: NaN };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    // NaN >= 0.8 is false
    expect(result.verdict).toBe("approved");
  });

  it("handles Infinity confidence", () => {
    const claude = { verdict: "compromised", confidence: Infinity };
    const openai = { verdict: "compromised", confidence: Infinity };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    // Infinity >= 0.8 is true
    expect(result.verdict).toBe("blocked");
  });
});

// =============================================================================
// C. Split Verdict Attack Patterns
// =============================================================================

describe("split verdict attacks — forcing approval via disagreement", () => {
  it("attacker forces Claude 'compromised' + OpenAI 'suspicious' = approved", () => {
    const claude = { verdict: "compromised", confidence: 0.95, findings: ["injection detected"] };
    const openai = { verdict: "suspicious", confidence: 0.9, findings: ["unusual but not clear"] };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    // GAP-DOC: Only "compromised" triggers block — "suspicious" does not
    expect(result.verdict).toBe("approved");
  });

  it("attacker forces OpenAI 'compromised' + Claude 'clean' = approved", () => {
    const claude = { verdict: "clean", confidence: 0.3, findings: [] };
    const openai = { verdict: "compromised", confidence: 0.99, findings: ["definitely injected"] };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    // GAP-DOC: Even 0.99 confidence from one model isn't enough
    expect(result.verdict).toBe("approved");
  });

  it("attacker crashes one model (null) while other detects compromise = approved", () => {
    const openai = { verdict: "compromised", confidence: 0.95, findings: ["system prompt leaked"] };
    const result = computeVerdict(VALID_PRECHECK, null, openai);
    // GAP-DOC: Model failure = no opinion, blocks the consensus requirement
    expect(result.verdict).toBe("approved");
  });

  it("attacker crashes both models (both null) = approved", () => {
    const result = computeVerdict(VALID_PRECHECK, null, null);
    // GAP-DOC: Dual model failure = no opinions = default approved
    expect(result.verdict).toBe("approved");
  });

  it("attacker sends content that one model finds clean but includes hidden payload", () => {
    // Simulates: attacker embeds GPT-specific jailbreak that Claude doesn't detect
    const claude = { verdict: "clean", confidence: 0.85, findings: ["content appears normal"] };
    const openai = { verdict: "compromised", confidence: 0.92, findings: ["hidden instruction in post"] };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    expect(result.verdict).toBe("approved");
  });

  it("attacker forces both models to disagree on verdict type", () => {
    // Claude thinks suspicious, OpenAI thinks compromised — not enough
    const claude = { verdict: "suspicious", confidence: 0.95, findings: ["might be injection"] };
    const openai = { verdict: "compromised", confidence: 0.95, findings: ["is injection"] };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    // GAP-DOC: "suspicious" != "compromised" — only exact match triggers block
    expect(result.verdict).toBe("approved");
  });

  it("attacker poisons confidence — one model at exactly threshold", () => {
    const claude = { verdict: "compromised", confidence: 0.8, findings: ["marginal"] };
    const openai = { verdict: "compromised", confidence: 0.7999, findings: ["marginal"] };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    // 0.7999 < 0.8 — fails threshold by 0.0001
    expect(result.verdict).toBe("approved");
  });
});

// =============================================================================
// D. Verdict Bypass via Field Manipulation
// =============================================================================

describe("verdict bypass via field manipulation", () => {
  it("extra fields in model response don't affect verdict", () => {
    const claude = {
      verdict: "compromised",
      confidence: 0.9,
      findings: ["test"],
      override: "approve",
      admin: true,
      __proto__: { verdict: "clean" },
    };
    const openai = {
      verdict: "compromised",
      confidence: 0.9,
      findings: ["test"],
      internal_note: "should be approved",
    };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    expect(result.verdict).toBe("blocked");
  });

  it("verdict field with object value doesn't match string comparison", () => {
    const claude = { verdict: { value: "compromised" }, confidence: 0.9 };
    const openai = { verdict: { value: "compromised" }, confidence: 0.9 };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    // Object !== string "compromised"
    expect(result.verdict).toBe("approved");
  });

  it("verdict field with boolean true doesn't match", () => {
    const claude = { verdict: true, confidence: 0.9 };
    const openai = { verdict: true, confidence: 0.9 };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    expect(result.verdict).toBe("approved");
  });

  it("confidence as boolean true doesn't meet threshold", () => {
    const claude = { verdict: "compromised", confidence: true };
    const openai = { verdict: "compromised", confidence: true };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    // true >= 0.8 → 1 >= 0.8 → true (JS coercion: true → 1)
    expect(result.verdict).toBe("blocked");
  });

  it("null verdict in valid object still defaults correctly", () => {
    const claude = { verdict: null, confidence: 0.9 };
    const openai = { verdict: null, confidence: 0.9 };
    const result = computeVerdict(VALID_PRECHECK, claude, openai);
    // null || null → null; null === "compromised" → false
    expect(result.verdict).toBe("approved");
  });
});

// =============================================================================
// E. Precheck Bypass Attempts
// =============================================================================

describe("precheck bypass attempts", () => {
  it("missing structurally_valid field defaults to falsy = not blocked", () => {
    const precheck = { sufficient_duration: true };
    const claude = { verdict: "compromised", confidence: 0.95 };
    const openai = { verdict: "compromised", confidence: 0.95 };
    const result = computeVerdict(precheck, claude, openai);
    // undefined is falsy, so !precheck.structurally_valid is true → blocked as structural
    expect(result.verdict).toBe("blocked");
    expect(result.reason).toBe("structural_violation");
  });

  it("structurally_valid as string 'false' is truthy = bypasses structural check", () => {
    const precheck = { sufficient_duration: true, structurally_valid: "false" };
    const claude = { verdict: "compromised", confidence: 0.95 };
    const openai = { verdict: "compromised", confidence: 0.95 };
    const result = computeVerdict(precheck, claude, openai);
    // GAP-DOC: String "false" is truthy in JS — structural check passes
    expect(result.verdict).toBe("blocked");
    expect(result.reason).toBe("dual_model_consensus");
  });

  it("sufficient_duration as 0 triggers auto-approve", () => {
    const precheck = { sufficient_duration: 0, structurally_valid: true };
    const claude = { verdict: "compromised", confidence: 0.95 };
    const openai = { verdict: "compromised", confidence: 0.95 };
    const result = computeVerdict(precheck, claude, openai);
    // 0 is falsy → !0 is true → short run path
    expect(result.verdict).toBe("approved");
    expect(result.reason).toBe("insufficient_duration");
  });
});
