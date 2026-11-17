import { Schema, model, type ClientSession } from 'mongoose';
import { tenantScopePlugin } from '../../tenancy/tenant-scope.plugin.js';

/**
 * Per-gym sequences (member codes now; receipt numbers in M6). One document per key, incremented
 * atomically, so two front desks registering at the same moment never get the same number.
 */
const counterSchema = new Schema(
  {
    key: { type: String, required: true, maxlength: 64 },
    seq: { type: Number, required: true, default: 0 },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
);
counterSchema.plugin(tenantScopePlugin);
counterSchema.index({ tenantId: 1, key: 1 }, { unique: true });

export const Counter = model('Counter', counterSchema);

/** Next value for `key` in the current gym. Pass the transaction session when inside one. */
export async function nextSequence(key: string, session?: ClientSession): Promise<number> {
  const doc = await Counter.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', session },
  ).lean();
  return doc!.seq;
}
