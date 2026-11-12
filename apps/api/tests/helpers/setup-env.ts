// Baseline env for tests. Individual tests override via parseEnv() rather than mutating globals.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/gym-test-unused';
process.env.BASE_DOMAINS ??= 'yourapp.in,localhost';
process.env.CORS_ORIGINS ??= 'http://localhost:3000,https://*.yourapp.in';
