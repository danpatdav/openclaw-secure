import { z } from "zod";

// ID validation: alphanumeric + underscore/hyphen, max 128 chars
const idField = z.string().regex(/^[a-zA-Z0-9_-]+$/).max(128);

// Run ID field: UUID or UUID-cpN for checkpoint saves
const runIdField = z.string().regex(/^[a-f0-9-]+(-(cp|checkpoint)\d+)?$/).max(128);

// ISO8601 timestamp
const timestampField = z.string().datetime();

// Fixed enums
const topicLabel = z.enum(["ai_safety", "agent_design", "moltbook_meta", "social", "technical", "other"]);
const sentiment = z.enum(["positive", "neutral", "negative"]);
const action = z.enum(["reply", "new_post", "upvote"]);

// Entry types
const postSeenEntry = z.object({
  type: z.literal("post_seen"),
  post_id: idField,
  timestamp: timestampField,
  topic_label: topicLabel,
  sentiment: sentiment,
});

const postMadeEntry = z.object({
  type: z.literal("post_made"),
  post_id: idField,
  thread_id: idField,
  timestamp: timestampField,
  action: action,
});

const threadTrackedEntry = z.object({
  type: z.literal("thread_tracked"),
  thread_id: idField,
  topic_label: topicLabel,
  first_seen: timestampField,
  last_interaction: timestampField,
});

const memoryEntry = z.discriminatedUnion("type", [
  postSeenEntry,
  postMadeEntry,
  threadTrackedEntry,
]);

const statsSchema = z.object({
  posts_read: z.number().int().nonnegative(),
  posts_made: z.number().int().nonnegative(),
  upvotes: z.number().int().nonnegative(),
  threads_tracked: z.number().int().nonnegative(),
});

export const memoryFileSchema = z.object({
  version: z.literal(1),
  run_id: runIdField,
  run_start: timestampField,
  run_end: timestampField,
  entries: z.array(memoryEntry).max(10000),
  stats: statsSchema,
});

export type MemoryFile = z.infer<typeof memoryFileSchema>;
export type MemoryEntry = z.infer<typeof memoryEntry>;

export const MAX_MEMORY_SIZE_BYTES = 1_048_576; // 1MB

export function validateMemory(data: unknown): { success: true; data: MemoryFile } | { success: false; error: string } {
  const result = memoryFileSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
}
