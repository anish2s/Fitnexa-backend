// Baseline env for tests. Individual tests override via parseEnv() rather than mutating globals.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/gym-test-unused';
process.env.BASE_DOMAINS ??= 'yourapp.in,localhost';
process.env.CORS_ORIGINS ??= 'http://localhost:3000,https://*.yourapp.in';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-that-is-long-enough-for-hs256-signing-0123456789';
process.env.MAIL_TRANSPORT ??= 'memory';
process.env.GYM_APP_URL_TEMPLATE ??= 'http://{slug}.localhost:3000';
