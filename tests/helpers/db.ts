import mongoose from 'mongoose';
import { describe, inject } from 'vitest';

export const mongoUri = inject('mongoUri');
export const hasDb = Boolean(mongoUri);

/** describe() when a database is available, otherwise describe.skip() (see global-setup). */
export const describeWithDb = hasDb ? describe : describe.skip;

export async function connectTestDb(dbName: string) {
  await mongoose.connect(mongoUri, { dbName });
  // Make sure unique indexes exist before tests rely on them.
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
}

export async function dropAndDisconnect() {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
  }
  await mongoose.disconnect();
}
