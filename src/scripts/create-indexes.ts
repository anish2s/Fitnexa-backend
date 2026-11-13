import mongoose from 'mongoose';
import '../db/models.js';

/**
 * Release step: create any missing indexes. autoIndex is off in production.
 * Uses createIndexes (additive only). It never drops an index; removing one is a manual,
 * reviewed operation.
 */
async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(uri);
  try {
    for (const model of Object.values(mongoose.models)) {
      await model.createIndexes();
      process.stdout.write(`indexes ok: ${model.collection.collectionName}\n`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
