import { z } from 'zod';
import type { PageMeta } from './response.js';

/** `?page=&limit=` for every list endpoint. A hard cap keeps one request from dumping a collection. */
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PageQuery = z.infer<typeof pageQuery>;

export function pageMeta({ page, limit }: PageQuery, total: number): PageMeta {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

export const skipFor = ({ page, limit }: PageQuery) => (page - 1) * limit;

/** Escapes user text for use inside a RegExp (search boxes must never become regex injection). */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
