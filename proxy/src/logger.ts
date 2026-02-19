import type { ProxyLogEntry } from "./types";

/**
 * Writes a structured JSONL log line to stdout for Azure Monitor ingestion.
 * Auto-stamps timestamp if not provided by caller.
 */
export function log(entry: ProxyLogEntry): void {
  const stamped: ProxyLogEntry = {
    ...entry,
    timestamp: entry.timestamp || new Date().toISOString(),
  };
  process.stdout.write(JSON.stringify(stamped) + "\n");
}

/**
 * Writes a structured JSONL error line to stdout.
 */
export function logError(message: string, error?: Error): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level: "error" as const,
    message,
    ...(error && {
      error_name: error.name,
      error_message: error.message,
      stack: error.stack,
    }),
  };
  process.stdout.write(JSON.stringify(entry) + "\n");
}
