import { createServer as createNetServer, Socket } from "node:net";
import { loadAllowlist, isAllowed, getConfig } from "./allowlist";
import { log, logError } from "./logger";
import { sanitize } from "./sanitizer";
import type { ProxyLogEntry } from "./types";

const PORT = parseInt(process.env.PORT || "3128", 10);
const ALLOWLIST_PATH =
  process.env.ALLOWLIST_CONFIG || "./config/allowlist.mvp0.json";

// Load allowlist at startup
const config = loadAllowlist(ALLOWLIST_PATH);

process.stdout.write(
  JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "info",
    message: "Proxy starting",
    port: PORT,
    allowlist_path: ALLOWLIST_PATH,
    allowlist_domains: config.allowedDomains.length,
  }) + "\n"
);

function buildLogEntry(
  method: string,
  hostname: string,
  port: number,
  path: string
): ProxyLogEntry {
  return {
    timestamp: new Date().toISOString(),
    method,
    hostname,
    port,
    path,
    allowed: false,
    sanitized: false,
    duration_ms: 0,
  };
}

function parseHostPort(hostHeader: string): { hostname: string; port: number } {
  const parts = hostHeader.split(":");
  const hostname = parts[0];
  const port = parts.length > 1 ? parseInt(parts[1], 10) : 443;
  return { hostname, port };
}

// Unified TCP proxy server handling both CONNECT and HTTP requests
const server = createNetServer((clientSocket) => {
  let buffer = Buffer.alloc(0);

  const onData = (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1 && buffer.length < 65536) {
      return; // Wait for complete headers
    }

    clientSocket.removeListener("data", onData);

    const headerStr = buffer.subarray(0, headerEnd).toString("utf-8");
    const firstLine = headerStr.split("\r\n")[0];
    const [method, target] = firstLine.split(" ");

    if (method === "CONNECT") {
      handleConnect(clientSocket, target);
    } else {
      handleHttp(clientSocket, buffer, method, target, headerStr);
    }
  };

  clientSocket.on("data", onData);
  clientSocket.on("error", (err) => {
    logError("Client connection error", err);
  });
});

function handleConnect(clientSocket: Socket, target: string): void {
  const { hostname, port } = parseHostPort(target);
  const start = performance.now();
  const entry = buildLogEntry("CONNECT", hostname, port, "/");
  const currentConfig = getConfig();

  const domainEntry = currentConfig.allowedDomains.find(
    (d) => d.domain === hostname
  );

  if (!domainEntry) {
    entry.allowed = false;
    entry.blocked_reason = `Domain not in allowlist: ${hostname}`;
    entry.duration_ms = performance.now() - start;
    log(entry);
    clientSocket.write(
      "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\n\r\n" +
        JSON.stringify({
          error: "Forbidden",
          reason: `Domain not in allowlist: ${hostname}`,
        })
    );
    clientSocket.end();
    return;
  }

  entry.allowed = true;

  const targetSocket = new Socket();
  targetSocket.connect(port, hostname, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    entry.duration_ms = performance.now() - start;
    log(entry);

    clientSocket.pipe(targetSocket);
    targetSocket.pipe(clientSocket);
  });

  targetSocket.on("error", (err) => {
    entry.duration_ms = performance.now() - start;
    entry.response_status = 502;
    log(entry);
    logError(`CONNECT tunnel error to ${hostname}:${port}`, err);
    clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    clientSocket.end();
  });

  clientSocket.on("error", () => targetSocket.end());
  clientSocket.on("close", () => targetSocket.end());
  targetSocket.on("close", () => clientSocket.end());
}

async function handleHttp(
  clientSocket: Socket,
  rawData: Buffer,
  method: string,
  target: string,
  headerStr: string
): Promise<void> {
  const start = performance.now();

  let targetUrl: URL;
  try {
    if (target.startsWith("http://") || target.startsWith("https://")) {
      targetUrl = new URL(target);
    } else {
      const hostMatch = headerStr.match(/^Host:\s*(.+)$/im);
      const host = hostMatch ? hostMatch[1].trim() : "localhost";

      // Health check endpoint
      if (target === "/health") {
        const currentConfig = getConfig();
        const body = JSON.stringify({
          status: "healthy",
          uptime: process.uptime(),
          allowlist_domains: currentConfig.allowedDomains.length,
        });
        clientSocket.write(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
        );
        clientSocket.end();
        return;
      }

      targetUrl = new URL(target, `http://${host}`);
    }
  } catch {
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\nBad Request\r\n");
    clientSocket.end();
    return;
  }

  const hostname = targetUrl.hostname;
  const port = parseInt(targetUrl.port, 10) || 80;
  const path = targetUrl.pathname;

  const entry = buildLogEntry(method, hostname, port, path);
  const currentConfig = getConfig();
  const check = isAllowed(hostname, method, path, currentConfig);

  if (!check.allowed) {
    entry.allowed = false;
    entry.blocked_reason = check.reason;
    entry.duration_ms = performance.now() - start;
    log(entry);
    const body = JSON.stringify({ error: "Forbidden", reason: check.reason });
    clientSocket.write(
      `HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
    );
    clientSocket.end();
    return;
  }

  entry.allowed = true;

  try {
    // Parse headers for forwarding
    const headerLines = headerStr.split("\r\n").slice(1);
    const headers = new Headers();
    for (const line of headerLines) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.substring(0, colonIdx).trim().toLowerCase();
        const value = line.substring(colonIdx + 1).trim();
        if (key !== "proxy-connection" && key !== "proxy-authorization") {
          headers.set(key, value);
        }
      }
    }

    // Extract body if present
    const headerEndIdx = rawData.indexOf("\r\n\r\n");
    const bodyData =
      headerEndIdx >= 0 ? rawData.subarray(headerEndIdx + 4) : undefined;

    const fetchOpts: RequestInit = {
      method,
      headers,
      redirect: "follow",
    };

    if (
      method !== "GET" &&
      method !== "HEAD" &&
      bodyData &&
      bodyData.length > 0
    ) {
      fetchOpts.body = new Uint8Array(bodyData);
    }

    const response = await fetch(targetUrl.toString(), fetchOpts);
    entry.response_status = response.status;

    const responseBody = await response.text();
    const sanitizeResult = sanitize(responseBody);

    entry.sanitized = sanitizeResult.sanitized;
    if (sanitizeResult.sanitized) {
      entry.injection_patterns = sanitizeResult.patterns;
    }

    entry.duration_ms = performance.now() - start;
    log(entry);

    // Build raw HTTP response
    const responseBytes = new TextEncoder().encode(sanitizeResult.content);
    let responseStr = `HTTP/1.1 ${response.status} ${response.statusText}\r\n`;

    response.headers.forEach((value, key) => {
      if (
        key.toLowerCase() !== "transfer-encoding" &&
        key.toLowerCase() !== "content-length"
      ) {
        responseStr += `${key}: ${value}\r\n`;
      }
    });

    responseStr += `Content-Length: ${responseBytes.byteLength}\r\n`;
    responseStr += "Connection: close\r\n";
    responseStr += "\r\n";

    clientSocket.write(responseStr);
    clientSocket.write(responseBytes);
    clientSocket.end();
  } catch (err) {
    entry.duration_ms = performance.now() - start;
    entry.response_status = 502;
    log(entry);
    logError("Proxy request failed", err as Error);
    const body = JSON.stringify({
      error: "Bad Gateway",
      message: (err as Error).message,
    });
    clientSocket.write(
      `HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
    );
    clientSocket.end();
  }
}

server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      message: `Proxy listening on port ${PORT}`,
      port: PORT,
    }) + "\n"
  );
});

// Graceful shutdown on SIGTERM
process.on("SIGTERM", () => {
  process.stdout.write(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      message: "Received SIGTERM, shutting down gracefully",
    }) + "\n"
  );
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
});
