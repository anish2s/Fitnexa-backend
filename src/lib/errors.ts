/**
 * Every error the API intentionally returns is an AppError with a stable machine-readable code.
 * Anything else reaching the error handler is treated as an unexpected 500 and its details are hidden.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const Errors = {
  badRequest: (message = 'Bad request', details?: unknown) =>
    new AppError(400, 'BAD_REQUEST', message, details),
  validation: (details: unknown) =>
    new AppError(422, 'VALIDATION_ERROR', 'Request validation failed', details),
  unauthorized: (message = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', message),
  forbidden: (message = 'You do not have permission to perform this action') =>
    new AppError(403, 'FORBIDDEN', message),
  notFound: (entity = 'Resource') => new AppError(404, 'NOT_FOUND', `${entity} not found`),
  conflict: (message: string, details?: unknown) => new AppError(409, 'CONFLICT', message, details),
  tenantNotFound: () => new AppError(404, 'TENANT_NOT_FOUND', 'Gym not found'),
  tenantRequired: () =>
    new AppError(400, 'TENANT_REQUIRED', 'This endpoint must be called on a gym domain'),
  tenantSuspended: () =>
    new AppError(403, 'TENANT_SUSPENDED', 'This gym account is suspended. Contact support.'),
};

/**
 * Raised when tenant-owned data is touched without a tenant in context, or with a conflicting one.
 * This is a programming error, never a client error: it maps to a 500 and is logged loudly.
 */
export class TenantIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantIsolationError';
  }
}
