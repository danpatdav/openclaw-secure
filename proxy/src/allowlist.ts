import { readFileSync } from "node:fs";
import type { AllowlistConfig } from "./types";
import { logError } from "./logger";

let cachedConfig: AllowlistConfig | null = null;
let configPath: string = "";

export function loadAllowlist(path: string): AllowlistConfig {
  configPath = path;
  const raw = readFileSync(path, "utf-8");
  const config: AllowlistConfig = JSON.parse(raw);
  cachedConfig = config;
  return config;
}

export function getConfig(): AllowlistConfig {
  if (!cachedConfig) {
    throw new Error("Allowlist not loaded. Call loadAllowlist() first.");
  }
  return cachedConfig;
}

export function isAllowed(
  hostname: string,
  method: string,
  path: string,
  config: AllowlistConfig
): { allowed: boolean; reason?: string } {
  const entry = config.allowedDomains.find((d) => d.domain === hostname);

  if (!entry) {
    return { allowed: false, reason: `Domain not in allowlist: ${hostname}` };
  }

  const upperMethod = method.toUpperCase();
  if (!entry.methods.includes(upperMethod)) {
    return {
      allowed: false,
      reason: `Method ${upperMethod} not allowed for ${hostname}`,
    };
  }

  if (entry.paths && entry.paths.length > 0) {
    const pathAllowed = entry.paths.some((allowed) => path.startsWith(allowed));
    if (!pathAllowed) {
      return {
        allowed: false,
        reason: `Path ${path} not in allowed paths for ${hostname}`,
      };
    }
  }

  return { allowed: true };
}

// Hot-reload on SIGHUP
process.on("SIGHUP", () => {
  if (configPath) {
    try {
      loadAllowlist(configPath);
      process.stdout.write(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "info",
          message: "Allowlist reloaded via SIGHUP",
          config_path: configPath,
        }) + "\n"
      );
    } catch (err) {
      logError("Failed to reload allowlist on SIGHUP", err as Error);
    }
  }
});
