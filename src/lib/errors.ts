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
  /** A real import with any bad row writes nothing; `details` is the full row report. */
  importInvalid: (report: unknown) =>
    new AppError(
      422,
      'IMPORT_INVALID',
      'Fix the rows listed and upload again. Nothing was imported.',
      report,
    ),
  gatewayNotConfigured: () =>
    new AppError(
      503,
      'PAYMENT_GATEWAY_NOT_CONFIGURED',
      'Online payments are not set up on this server',
    ),
  gatewayNotConnected: () =>
    new AppError(409, 'PAYMENT_GATEWAY_NOT_CONNECTED', 'Razorpay is not connected for this gym'),
  gatewayError: (message: string) => new AppError(502, 'PAYMENT_GATEWAY_ERROR', message),
  invalidSignature: () =>
    new AppError(400, 'INVALID_SIGNATURE', 'Payment signature could not be verified'),
  passInvalid: () =>
    new AppError(400, 'PASS_INVALID', 'This QR code is not a valid member pass for this gym'),
  passExpired: () =>
    new AppError(
      400,
      'PASS_EXPIRED',
      'This QR code has expired. Ask the member to refresh the pass.',
    ),
  uploadsNotConfigured: () =>
    new AppError(503, 'UPLOADS_NOT_CONFIGURED', 'Image uploads are not configured yet'),
  tenantRequired: () =>
    new AppError(400, 'TENANT_REQUIRED', 'This endpoint must be called on a gym domain'),
  tenantSuspended: () =>
    new AppError(403, 'TENANT_SUSPENDED', 'This gym account is suspended. Contact support.'),

  // --- authentication ---
  /** Same response for unknown user and wrong password: no account enumeration. */
  invalidCredentials: () =>
    new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email/phone or password'),
  loginLocked: (minutes: number) =>
    new AppError(
      429,
      'LOGIN_LOCKED',
      `Too many failed attempts. Try again in ${minutes} minutes or reset your password.`,
    ),
  accountDisabled: () =>
    new AppError(403, 'ACCOUNT_DISABLED', 'This account has been disabled. Contact your gym.'),
  tokenExpired: () => new AppError(401, 'TOKEN_EXPIRED', 'Access token expired'),
  invalidLink: () =>
    new AppError(400, 'INVALID_LINK', 'This link is invalid or has expired. Request a new one.'),
  invalidRefresh: () =>
    new AppError(401, 'INVALID_REFRESH', 'Session expired. Please sign in again.'),
  refreshRace: () =>
    new AppError(401, 'REFRESH_RACE', 'Session was refreshed by another tab. Retry the request.'),
  csrfRejected: () => new AppError(403, 'CROSS_ORIGIN_REJECTED', 'Cross-origin request rejected'),
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
