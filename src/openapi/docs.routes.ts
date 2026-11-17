import { Router } from 'express';
import { join } from 'node:path';
import { SWAGGER_HTML, SWAGGER_INIT_JS, SWAGGER_UI_DIR } from './assets.js';

/**
 * Routes outside the documented API, kept in routers so the route audit can still see them.
 *
 * contract: GET /api/v1/openapi.json, public on purpose: it describes routes, never data, and
 *   gym-saas-web generates its client types from it.
 * ui: GET /api/docs (+ its three assets), Swagger UI served from node_modules. Mounted only outside
 *   production, or in production when ENABLE_API_DOCS=true.
 */
export function openApiRouter(getSpec: () => unknown) {
  const contract = Router();
  contract.get('/openapi.json', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(getSpec());
  });
  return contract;
}

// Only scripts and styles from this server; Swagger UI sets inline styles, and data: images.
const DOCS_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export function swaggerUiRouter() {
  const ui = Router();
  ui.use((_req, res, next) => {
    res.set('Content-Security-Policy', DOCS_CSP);
    next();
  });
  ui.get('/', (_req, res) => {
    res.type('html').send(SWAGGER_HTML);
  });
  ui.get('/init.js', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').type('js').send(SWAGGER_INIT_JS);
  });
  // A fixed list, never a path from the request: nothing else in node_modules is reachable.
  for (const file of ['swagger-ui.css', 'swagger-ui-bundle.js'] as const) {
    ui.get(`/${file}`, (_req, res) => {
      res.set('Cache-Control', 'public, max-age=86400');
      res.sendFile(join(SWAGGER_UI_DIR, file));
    });
  }
  return ui;
}
