import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import { validateMemory, MAX_MEMORY_SIZE_BYTES } from "./memory-schema";
import { log as proxyLog } from "./logger";
import type { Socket } from "node:net";

const STORAGE_ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const CONTAINER_NAME = process.env.MEMORY_CONTAINER_NAME || "agent-memory";

function getBlobServiceClient(): BlobServiceClient {
  if (!STORAGE_ACCOUNT) {
    throw new Error("AZURE_STORAGE_ACCOUNT_NAME not configured");
  }
  const url = `https://${STORAGE_ACCOUNT}.blob.core.windows.net`;
  return new BlobServiceClient(url, new DefaultAzureCredential());
}

function sendResponse(socket: Socket, status: number, statusText: string, body: string): void {
  const bodyBytes = new TextEncoder().encode(body);
  socket.write(
    `HTTP/1.1 ${status} ${statusText}\r\nContent-Type: application/json\r\nContent-Length: ${bodyBytes.byteLength}\r\nConnection: close\r\n\r\n`
  );
  socket.write(bodyBytes);
  socket.end();
}

export async function handleMemoryRequest(
  socket: Socket,
  method: string,
  path: string,
  body?: Buffer
): Promise<void> {
  try {
    if (method === "POST" && path === "/memory") {
      await handlePost(socket, body);
    } else if (method === "GET" && path === "/memory/latest") {
      await handleGetLatest(socket);
    } else {
      sendResponse(socket, 404, "Not Found", JSON.stringify({ error: "Not Found" }));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    proxyLog({
      timestamp: new Date().toISOString(),
      method,
      hostname: "localhost",
      port: 3128,
      path,
      allowed: true,
      sanitized: false,
      duration_ms: 0,
    });
    sendResponse(socket, 500, "Internal Server Error", JSON.stringify({ error: message }));
  }
}

async function handlePost(socket: Socket, body?: Buffer): Promise<void> {
  if (!body || body.length === 0) {
    sendResponse(socket, 400, "Bad Request", JSON.stringify({ error: "Empty body" }));
    return;
  }

  // Size check
  if (body.length > MAX_MEMORY_SIZE_BYTES) {
    sendResponse(socket, 413, "Payload Too Large", JSON.stringify({
      error: "Memory file exceeds 1MB limit",
      size: body.length,
      max: MAX_MEMORY_SIZE_BYTES
    }));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf-8"));
  } catch {
    sendResponse(socket, 400, "Bad Request", JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const validation = validateMemory(parsed);
  if (!validation.success) {
    sendResponse(socket, 400, "Bad Request", JSON.stringify({
      error: "Schema validation failed",
      details: validation.error
    }));
    return;
  }

  const data = validation.data;
  const blobName = `memory/${data.run_id}.json`;

  const client = getBlobServiceClient();
  const containerClient = client.getContainerClient(CONTAINER_NAME);
  const blobClient = containerClient.getBlockBlobClient(blobName);

  // Check if blob already exists (append-only: never overwrite)
  const exists = await blobClient.exists();
  if (exists) {
    sendResponse(socket, 409, "Conflict", JSON.stringify({
      error: "Memory blob already exists for this run_id",
      run_id: data.run_id
    }));
    return;
  }

  await blobClient.upload(body, body.length, {
    blobHTTPHeaders: { blobContentType: "application/json" },
    metadata: {
      run_id: data.run_id,
      run_start: data.run_start,
      analyzed: "false",
      approved: "false"
    },
  });

  sendResponse(socket, 200, "OK", JSON.stringify({
    ok: true,
    blob: blobName,
    run_id: data.run_id
  }));
}

async function handleGetLatest(socket: Socket): Promise<void> {
  const client = getBlobServiceClient();
  const containerClient = client.getContainerClient(CONTAINER_NAME);

  let latestBlob: { name: string; lastModified: Date } | null = null;

  for await (const blob of containerClient.listBlobsFlat({ prefix: "memory/", includeMetadata: true })) {
    if (blob.metadata?.approved === "true") {
      if (!latestBlob || blob.properties.lastModified! > latestBlob.lastModified) {
        latestBlob = { name: blob.name, lastModified: blob.properties.lastModified! };
      }
    }
  }

  if (!latestBlob) {
    sendResponse(socket, 200, "OK", JSON.stringify({ ok: true, data: null, message: "No approved memory found" }));
    return;
  }

  const blobClient = containerClient.getBlockBlobClient(latestBlob.name);
  const download = await blobClient.download(0);
  const chunks: Buffer[] = [];
  for await (const chunk of download.readableStreamBody as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  const content = Buffer.concat(chunks).toString("utf-8");

  sendResponse(socket, 200, "OK", JSON.stringify({ ok: true, data: JSON.parse(content) }));
}
