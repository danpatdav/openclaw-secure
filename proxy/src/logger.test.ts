import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { log, logError } from "./logger";
import type { ProxyLogEntry } from "./types";

describe("logger", () => {
  let writeSpy: ReturnType<typeof spyOn>;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    writeSpy = spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      captured.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  describe("log()", () => {
    it("outputs valid JSON terminated by newline", () => {
      const entry: Omit<ProxyLogEntry, "timestamp"> = {
        method: "CONNECT",
        hostname: "api.anthropic.com",
        port: 443,
        path: "/",
        allowed: true,
        sanitized: false,
        duration_ms: 42,
      };
      log(entry as ProxyLogEntry);

      expect(captured).toHaveLength(1);
      expect(captured[0]).toEndWith("\n");

      const parsed = JSON.parse(captured[0]);
      expect(parsed).toBeDefined();
    });

    it("always includes a timestamp field in ISO format", () => {
      const entry: Omit<ProxyLogEntry, "timestamp"> = {
        method: "CONNECT",
        hostname: "api.anthropic.com",
        port: 443,
        path: "/",
        allowed: true,
        sanitized: false,
        duration_ms: 10,
      };
      log(entry as ProxyLogEntry);

      const parsed = JSON.parse(captured[0]);
      expect(parsed.timestamp).toBeDefined();
      // Verify ISO 8601 format
      expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
    });

    it("preserves caller-provided timestamp if present", () => {
      const ts = "2026-01-15T10:00:00.000Z";
      const entry: ProxyLogEntry = {
        timestamp: ts,
        method: "GET",
        hostname: "example.com",
        port: 443,
        path: "/test",
        allowed: false,
        sanitized: false,
        duration_ms: 5,
      };
      log(entry);

      const parsed = JSON.parse(captured[0]);
      expect(parsed.timestamp).toBe(ts);
    });

    it("includes method, hostname, allowed, and sanitized fields", () => {
      const entry: ProxyLogEntry = {
        timestamp: new Date().toISOString(),
        method: "POST",
        hostname: "api.anthropic.com",
        port: 443,
        path: "/v1/messages",
        allowed: true,
        sanitized: true,
        injection_patterns: ["system_prompt_override"],
        duration_ms: 150,
      };
      log(entry);

      const parsed = JSON.parse(captured[0]);
      expect(parsed.method).toBe("POST");
      expect(parsed.hostname).toBe("api.anthropic.com");
      expect(parsed.allowed).toBe(true);
      expect(parsed.sanitized).toBe(true);
      expect(parsed.injection_patterns).toEqual(["system_prompt_override"]);
      expect(parsed.duration_ms).toBe(150);
    });

    it("includes blocked_reason when request is denied", () => {
      const entry: ProxyLogEntry = {
        timestamp: new Date().toISOString(),
        method: "CONNECT",
        hostname: "evil.com",
        port: 443,
        path: "/",
        allowed: false,
        blocked_reason: "Domain not in allowlist: evil.com",
        sanitized: false,
        duration_ms: 1,
      };
      log(entry);

      const parsed = JSON.parse(captured[0]);
      expect(parsed.allowed).toBe(false);
      expect(parsed.blocked_reason).toBe("Domain not in allowlist: evil.com");
    });

    it("each call produces exactly one line (JSONL format)", () => {
      for (let i = 0; i < 3; i++) {
        log({
          timestamp: new Date().toISOString(),
          method: "GET",
          hostname: "api.anthropic.com",
          port: 443,
          path: "/",
          allowed: true,
          sanitized: false,
          duration_ms: i,
        });
      }

      expect(captured).toHaveLength(3);
      for (const line of captured) {
        // Each captured chunk is one JSON object + newline
        const trimmed = line.trim();
        expect(() => JSON.parse(trimmed)).not.toThrow();
        expect(line.split("\n").filter(Boolean)).toHaveLength(1);
      }
    });
  });

  describe("logError()", () => {
    it("outputs structured JSON error with level field", () => {
      logError("something broke");

      const parsed = JSON.parse(captured[0]);
      expect(parsed.level).toBe("error");
      expect(parsed.message).toBe("something broke");
      expect(parsed.timestamp).toBeDefined();
    });

    it("includes error details when Error is provided", () => {
      const err = new Error("connection refused");
      logError("upstream failure", err);

      const parsed = JSON.parse(captured[0]);
      expect(parsed.error_name).toBe("Error");
      expect(parsed.error_message).toBe("connection refused");
      expect(parsed.stack).toBeDefined();
    });
  });
});
