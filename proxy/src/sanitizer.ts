import type { SanitizeResult } from "./types";

const REPLACEMENT = "[SANITIZED: injection pattern detected]";

const INJECTION_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  // System prompt overrides
  {
    name: "system_prompt_override",
    regex: /ignore\s+(?:all\s+)?previous\s+instructions/gi,
  },
  {
    name: "system_prompt_override",
    regex: /you\s+are\s+now\s+(?:a|an|the)\b/gi,
  },
  {
    name: "system_prompt_override",
    regex: /new\s+system\s+prompt/gi,
  },

  // Role injection
  {
    name: "role_injection",
    regex: /^SYSTEM\s*:/gim,
  },
  {
    name: "role_injection",
    regex: /^ASSISTANT\s*:/gim,
  },
  {
    name: "role_injection",
    regex: /<\|im_start\|>\s*system/gi,
  },

  // Instruction injection
  {
    name: "instruction_injection",
    regex: /do\s+not\s+follow\s+(?:your|the|any)\s+(?:previous|original|initial)/gi,
  },
  {
    name: "instruction_injection",
    regex: /disregard\s+(?:all\s+)?(?:your|the|previous|prior)\s+(?:instructions|rules|guidelines)/gi,
  },
  {
    name: "instruction_injection",
    regex: /forget\s+your\s+instructions/gi,
  },

  // Data exfiltration
  {
    name: "data_exfiltration",
    regex: /send\s+(?:this\s+)?to\s+https?:\/\//gi,
  },
  {
    name: "data_exfiltration",
    regex: /fetch\s+from\s+https?:\/\//gi,
  },
  {
    name: "data_exfiltration",
    regex: /\bcurl\s+/gi,
  },
  {
    name: "data_exfiltration",
    regex: /\bwget\s+/gi,
  },
];

// Known base64-encoded injection phrases to detect encoding evasion
const BASE64_PAYLOADS = [
  "ignore previous instructions",
  "you are now",
  "new system prompt",
  "forget your instructions",
  "disregard your instructions",
];

function buildBase64Patterns(): Array<{ name: string; regex: RegExp }> {
  return BASE64_PAYLOADS.map((phrase) => {
    const encoded = btoa(phrase);
    return {
      name: "encoding_evasion",
      regex: new RegExp(escapeRegex(encoded), "gi"),
    };
  });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ALL_PATTERNS = [...INJECTION_PATTERNS, ...buildBase64Patterns()];

export function sanitize(content: string): SanitizeResult {
  let sanitized = false;
  const foundPatterns: Set<string> = new Set();
  let result = content;

  for (const { name, regex } of ALL_PATTERNS) {
    // Reset lastIndex for global regexes
    regex.lastIndex = 0;
    if (regex.test(result)) {
      foundPatterns.add(name);
      sanitized = true;
      regex.lastIndex = 0;
      result = result.replace(regex, REPLACEMENT);
    }
  }

  return {
    content: result,
    sanitized,
    patterns: Array.from(foundPatterns),
  };
}
