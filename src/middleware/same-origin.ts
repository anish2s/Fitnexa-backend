import type { RequestHandler } from 'express';
import { Errors } from '../lib/errors.js';

/**
 * CSRF guard for endpoints authenticated by the refresh cookie (refresh, logout).
 *
 * The cookie is host-only and SameSite=Lax, but Lax still sends it on requests between sibling
 * gym subdomains (fitzone.yourapp.in → powerhouse.yourapp.in are "same site"). So when a browser
 * says where the request came from, it must be this exact host (or an explicitly configured
 * development origin). Non-browser clients send no Origin and are allowed.
 */
export function sameOriginOnly(explicitOrigins: readonly string[]): RequestHandler {
  const exact = explicitOrigins.filter((o) => !o.includes('*'));
  return (req, _res, next) => {
    if (req.get('sec-fetch-site') === 'cross-site') throw Errors.csrfRejected();
    const origin = req.get('origin');
    if (!origin) return next();
    let host: string;
    try {
      host = new URL(origin).hostname.toLowerCase();
    } catch {
      throw Errors.csrfRejected();
    }
    if (host === req.hostname || exact.includes(origin.toLowerCase())) return next();
    throw Errors.csrfRejected();
  };
}
