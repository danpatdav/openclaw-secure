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
