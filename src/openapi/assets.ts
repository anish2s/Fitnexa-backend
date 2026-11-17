import { readFileSync } from 'node:fs';

/** From package.json (works from src/ under tsx and from dist/ in production). */
export const PACKAGE_VERSION: string = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

const SWAGGER = 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14';

export const SWAGGER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Gym SaaS API</title>
  <link rel="stylesheet" href="${SWAGGER}/swagger-ui.css" />
</head>
<body>
  <div id="ui"></div>
  <script src="${SWAGGER}/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({ url: '/api/v1/openapi.json', dom_id: '#ui', persistAuthorization: false });
  </script>
</body>
</html>`;
