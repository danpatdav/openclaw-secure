import { z } from "zod";

export const postRequestSchema = z.object({
  content: z.string().min(1).max(500),
  thread_id: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .max(128)
    .optional(),
});

export const voteRequestSchema = z.object({
  post_id: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .max(128),
});

export type PostRequest = z.infer<typeof postRequestSchema>;
export type VoteRequest = z.infer<typeof voteRequestSchema>;
