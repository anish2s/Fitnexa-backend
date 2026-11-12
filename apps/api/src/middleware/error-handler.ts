import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { AppError, TenantIsolationError } from '../lib/errors.js';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `No route for ${req.method} ${req.path}`,
      requestId: req.id,
    },
  });
};

function isDuplicateKey(err: unknown): err is { code: 11000; keyValue?: Record<string, unknown> } {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/**
 * Single place where errors become HTTP responses.
 * Known errors map to their status/code; everything else is a 500 with no internals exposed.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = req.id;
  const send = (status: number, code: string, message: string, details?: unknown) =>
    res.status(status).json({
      success: false,
      error: { code, message, ...(details === undefined ? {} : { details }), requestId },
    });

  if (err instanceof AppError) {
    if (err.status >= 500) req.log?.error({ err }, err.message);
    return send(err.status, err.code, err.message, err.details);
  }

  if (err instanceof ZodError) {
    return send(422, 'VALIDATION_ERROR', 'Request validation failed', formatZodIssues(err));
  }

  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.values(err.errors).map((e) => ({ path: e.path, message: e.message }));
    return send(422, 'VALIDATION_ERROR', 'Request validation failed', details);
  }

  if (err instanceof mongoose.Error.CastError) {
    return send(400, 'BAD_REQUEST', `Invalid value for ${err.path}`);
  }

  if (isDuplicateKey(err)) {
    // Never echo the conflicting value back (it may belong to another tenant's record).
    const fields = Object.keys(err.keyValue ?? {}).filter((f) => f !== 'tenantId');
    return send(409, 'DUPLICATE', 'A record with these details already exists', { fields });
  }

  // Malformed JSON body from express.json()
  if ((err as { type?: string }).type === 'entity.parse.failed') {
    return send(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
  if ((err as { type?: string }).type === 'entity.too.large') {
    return send(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }

  if (err instanceof TenantIsolationError) {
    // A bug in our code, not the client's fault. Log loudly; reveal nothing.
    req.log?.fatal({ err }, 'TENANT ISOLATION VIOLATION BLOCKED');
  } else {
    req.log?.error({ err }, 'Unhandled error');
  }
  return send(500, 'INTERNAL_ERROR', 'Something went wrong');
};

export function formatZodIssues(err: ZodError) {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}
