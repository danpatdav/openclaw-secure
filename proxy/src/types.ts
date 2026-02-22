export interface AllowlistEntry {
  domain: string;
  methods: string[];
  paths?: string[];
}

export interface AllowlistConfig {
  allowedDomains: AllowlistEntry[];
}

export interface ProxyLogEntry {
  timestamp: string;
  method: string;
  hostname: string;
  port: number;
  path: string;
  allowed: boolean;
  blocked_reason?: string;
  sanitized: boolean;
  injection_patterns?: string[];
  response_status?: number;
  duration_ms: number;
}

export interface SanitizeResult {
  content: string;
  sanitized: boolean;
  patterns: string[];
}

export interface MemoryFile {
  version: number;
  run_id: string;
  run_start: string;
  run_end: string;
  entries: MemoryEntry[];
  stats: MemoryStats;
}

export type MemoryEntry = PostSeenEntry | PostMadeEntry | ThreadTrackedEntry;

export interface PostSeenEntry {
  type: "post_seen";
  post_id: string;
  timestamp: string;
  topic_label: string;
  sentiment: string;
}

export interface PostMadeEntry {
  type: "post_made";
  post_id: string;
  thread_id: string;
  timestamp: string;
  action: string;
}

export interface ThreadTrackedEntry {
  type: "thread_tracked";
  thread_id: string;
  topic_label: string;
  first_seen: string;
  last_interaction: string;
}

export interface MemoryStats {
  posts_read: number;
  posts_made: number;
  upvotes: number;
  threads_tracked: number;
}

export interface PostRequest {
  content: string;
  thread_id?: string;
}

export interface VoteRequest {
  post_id: string;
}

export interface PostLogEntry {
  timestamp: string;
  action: "post" | "vote";
  allowed: boolean;
  blocked_reason?: string;
  content_length?: number;
  thread_id?: string;
  post_id?: string;
  moltbook_status?: number;
  duration_ms: number;
}
