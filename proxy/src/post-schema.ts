import { z } from "zod";

export const postRequestSchema = z.object({
  content: z.string().min(1).max(5000),
  title: z.string().min(1).max(300).optional(),
  submolt_name: z.string().min(1).max(128).optional(),
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

export const commentRequestSchema = z.object({
  post_id: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .max(128),
  content: z.string().min(1).max(5000),
  parent_id: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .max(128)
    .optional(),
});

export type PostRequest = z.infer<typeof postRequestSchema>;
export type VoteRequest = z.infer<typeof voteRequestSchema>;
export type CommentRequest = z.infer<typeof commentRequestSchema>;
