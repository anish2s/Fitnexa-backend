import mongoose from 'mongoose';
import type { Logger } from '../lib/logger.js';

// Strict query filters: unknown fields in a filter are dropped instead of silently matching nothing.
mongoose.set('strictQuery', true);
// Never auto-build indexes in production at startup; run `npm run db:indexes` during deploys.
mongoose.set('autoIndex', process.env.NODE_ENV !== 'production');

export async function connectDatabase(uri: string, logger: Logger) {
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}

export function isDatabaseReady(): boolean {
  return mongoose.connection.readyState === 1;
}
