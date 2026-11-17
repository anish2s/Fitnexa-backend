import { Schema, model } from 'mongoose';

/**
 * One document per scheduled job (platform-level, not per gym). A job runs only while holding the
 * lease, so with several API instances each run happens once. A crashed holder's lease simply
 * expires. No Redis needed.
 */
const jobLockSchema = new Schema(
  {
    _id: { type: String, required: true },
    lockedUntil: { type: Date, default: null },
    owner: { type: String, maxlength: 200 },
    lastStartedAt: { type: Date },
    lastFinishedAt: { type: Date },
    lastError: { type: String, maxlength: 1000 },
    lastSummary: { type: Schema.Types.Mixed },
  },
  { versionKey: false },
);
export const JobLock = model('JobLock', jobLockSchema);
