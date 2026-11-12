import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { Errors } from '../lib/errors.js';
import { formatZodIssues } from './error-handler.js';

interface Schemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Parsed, validated and stripped input. Handlers read from here, never from req.body directly. */
    valid: { body: unknown; query: unknown; params: unknown };
  }
}

/**
 * Validates request parts with Zod. Object schemas strip unknown keys by default, which is
 * also why a client-supplied `tenantId` in a body is silently dropped: no schema declares it.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    const valid = {
      body: undefined as unknown,
      query: undefined as unknown,
      params: undefined as unknown,
    };
    for (const part of ['body', 'query', 'params'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (!result.success) throw Errors.validation(formatZodIssues(result.error));
      valid[part] = result.data;
    }
    req.valid = valid;
    next();
  };
}
