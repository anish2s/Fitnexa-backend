import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

/**
 * From package.json (works from src/ under tsx and from dist/ in production). Never fatal: an image
 * that ships only dist/ must still boot, it just reports an unknown version.
 */
export const PACKAGE_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0-unknown';
  } catch {
    return '0.0.0-unknown';
  }
})();

/** Swagger UI ships in node_modules (pinned in package.json), so the docs page needs no CDN. */
export const SWAGGER_UI_DIR = dirname(
  createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'),
);

/** No inline script, so the page runs under `script-src 'self'`. */
export const SWAGGER_INIT_JS = `window.ui = SwaggerUIBundle({ url: '/api/v1/openapi.json', dom_id: '#ui', persistAuthorization: false });\n`;

export const SWAGGER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Gym SaaS API</title>
  <link rel="stylesheet" href="/api/docs/swagger-ui.css" />
</head>
<body>
  <div id="ui"></div>
  <script src="/api/docs/swagger-ui-bundle.js"></script>
  <script src="/api/docs/init.js"></script>
</body>
</html>`;
