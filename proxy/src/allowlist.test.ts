import { describe, it, expect, beforeAll } from "bun:test";
import { loadAllowlist, isAllowed, getConfig } from "./allowlist";
import type { AllowlistConfig } from "./types";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("allowlist", () => {
  let tmpDir: string;
  let config: AllowlistConfig;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "allowlist-test-"));
    const testConfig: AllowlistConfig = {
      allowedDomains: [
        {
          domain: "api.anthropic.com",
          methods: ["GET", "POST"],
          paths: ["/v1/messages", "/v1/complete"],
        },
        {
          domain: "api.openai.com",
          methods: ["POST"],
        },
      ],
    };
    const configPath = join(tmpDir, "allowlist.json");
    writeFileSync(configPath, JSON.stringify(testConfig));
    config = loadAllowlist(configPath);
  });

  describe("loadAllowlist()", () => {
    it("loads and parses a valid config file", () => {
      expect(config.allowedDomains).toHaveLength(2);
    });

    it("throws on missing file", () => {
      expect(() => loadAllowlist("/nonexistent/path.json")).toThrow();
    });

    it("makes config available via getConfig()", () => {
      const retrieved = getConfig();
      expect(retrieved).toEqual(config);
    });
  });

  describe("isAllowed()", () => {
    it("allows matching domain, method, and path", () => {
      const result = isAllowed("api.anthropic.com", "POST", "/v1/messages", config);
      expect(result.allowed).toBe(true);
    });

    it("blocks unlisted domains", () => {
      const result = isAllowed("evil.com", "GET", "/", config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not in allowlist");
    });

    it("blocks disallowed methods", () => {
      const result = isAllowed("api.anthropic.com", "DELETE", "/v1/messages", config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Method DELETE not allowed");
    });

    it("blocks disallowed paths when paths are specified", () => {
      const result = isAllowed("api.anthropic.com", "GET", "/v1/admin", config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not in allowed paths");
    });

    it("allows any path when domain has no path restrictions", () => {
      const result = isAllowed("api.openai.com", "POST", "/anything/here", config);
      expect(result.allowed).toBe(true);
    });

    it("handles case-insensitive method matching", () => {
      const result = isAllowed("api.anthropic.com", "post", "/v1/messages", config);
      expect(result.allowed).toBe(true);
    });
  });
});
