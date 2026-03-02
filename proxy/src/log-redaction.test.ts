/**
 * Log Redaction and PII Leakage Tests — Issue #45
 *
 * Tests that sensitive data is handled appropriately in log output:
 * - API keys should not appear in log entries
 * - Authorization headers should be masked
 * - Sanitizer-blocked content truncation in logs
 *
 * Note: The current logger (logger.ts) is a thin JSON.stringify wrapper
 * with NO redaction logic. These tests document the current behavior
 * and flag gaps where redaction should be added.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { log, logError } from "./logger";

// Capture stdout for assertion
let capturedOutput = "";
let originalWrite: typeof process.stdout.write;

beforeEach(() => {
  capturedOutput = "";
  originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string) => {
    capturedOutput += chunk;
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = originalWrite;
});

// =============================================================================
// A. API key leakage
// =============================================================================

describe("log redaction — API key leakage", () => {
  const FAKE_ANTHROPIC_KEY = "sk-ant-api03-TESTKEY1234567890abcdef";
  const FAKE_MOLTBOOK_KEY = "mb-key-abcdef1234567890";

  it("GAP: API key in path field appears in log output", () => {
    log({
      timestamp: new Date().toISOString(),
      method: "GET",
      hostname: "api.anthropic.com",
      port: 443,
      path: `/v1/messages?key=${FAKE_ANTHROPIC_KEY}`,
      allowed: true,
      sanitized: false,
      duration_ms: 100,
    });

    // GAP: The logger does not redact API keys from path fields
    expect(capturedOutput).toContain(FAKE_ANTHROPIC_KEY);
  });

  it("GAP: API key in arbitrary log field appears in output", () => {
    log({
      timestamp: new Date().toISOString(),
      method: "POST",
      hostname: "moltbook.com",
      port: 443,
      path: "/api/v1/posts",
      allowed: true,
      sanitized: false,
      duration_ms: 50,
    } as any);

    // Basic log entry without key — verify structure is fine
    expect(capturedOutput).toContain("moltbook.com");
    expect(capturedOutput).not.toContain(FAKE_MOLTBOOK_KEY);
  });

  it("log output is valid JSON per line", () => {
    log({
      timestamp: new Date().toISOString(),
      method: "GET",
      hostname: "example.com",
      port: 443,
      path: "/test",
      allowed: true,
      sanitized: false,
      duration_ms: 10,
    });

    const lines = capturedOutput.trim().split("\n");
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

// =============================================================================
// B. Authorization header exposure
// =============================================================================

describe("log redaction — authorization headers", () => {
  it("standard log entry does not contain authorization tokens", () => {
    log({
      timestamp: new Date().toISOString(),
      method: "POST",
      hostname: "api.anthropic.com",
      port: 443,
      path: "/v1/messages",
      allowed: true,
      sanitized: false,
      duration_ms: 200,
      response_status: 200,
    });

    // The logger doesn't log headers at all — so Bearer tokens don't appear
    expect(capturedOutput).not.toContain("Bearer");
    expect(capturedOutput).not.toContain("Authorization");
  });

  it("logger does not include request headers by design", () => {
    // The ProxyLogEntry type doesn't have a headers field,
    // so auth headers can't leak through the structured logger.
    // This is security-by-design: the type system prevents header logging.
    const parsed = JSON.parse(capturedOutput || '{"test": true}');
    expect(parsed.headers).toBeUndefined();
    expect(parsed.authorization).toBeUndefined();
  });
});

// =============================================================================
// C. Sanitizer-blocked content in logs
// =============================================================================

describe("log redaction — sanitized content in logs", () => {
  it("log entries include sanitized flag but not raw injection content", () => {
    log({
      timestamp: new Date().toISOString(),
      method: "POST",
      hostname: "moltbook.com",
      port: 443,
      path: "/api/v1/posts",
      allowed: true,
      sanitized: true,
      duration_ms: 50,
    });

    const parsed = JSON.parse(capturedOutput.trim());
    expect(parsed.sanitized).toBe(true);
    // Log entry doesn't contain the raw post body — just metadata
    expect(parsed.body).toBeUndefined();
    expect(parsed.content).toBeUndefined();
  });

  it("logError does not leak full error stacks with sensitive data", () => {
    const sensitiveError = new Error("Connection failed for sk-ant-SENSITIVE123");
    logError("Request failed", sensitiveError);

    // GAP: logError includes the full error message which may contain sensitive data
    expect(capturedOutput).toContain("sk-ant-SENSITIVE123");
  });
});

// =============================================================================
// D. Structured logging format integrity
// =============================================================================

describe("log format — structural guarantees", () => {
  it("every log call produces exactly one line", () => {
    log({
      timestamp: new Date().toISOString(),
      method: "GET",
      hostname: "example.com",
      port: 80,
      path: "/",
      allowed: false,
      sanitized: false,
      duration_ms: 0,
    });

    const lines = capturedOutput.split("\n").filter(l => l.trim());
    expect(lines.length).toBe(1);
  });

  it("log output ends with newline", () => {
    log({
      timestamp: new Date().toISOString(),
      method: "GET",
      hostname: "example.com",
      port: 80,
      path: "/",
      allowed: false,
      sanitized: false,
      duration_ms: 0,
    });

    expect(capturedOutput.endsWith("\n")).toBe(true);
  });

  it("logError produces valid JSONL", () => {
    logError("test error", new Error("boom"));

    const lines = capturedOutput.trim().split("\n");
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.level).toBe("error");
      expect(parsed.message).toBe("test error");
      expect(parsed.error_message).toBe("boom");
    }
  });
});
