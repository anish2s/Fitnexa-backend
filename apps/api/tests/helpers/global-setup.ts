import type { TestProject } from 'vitest/node';

/**
 * Starts ONE MongoDB for the whole test run.
 *
 *  - MONGO_TEST_URI set        → use that server (CI service container, local mongod, Atlas test cluster)
 *  - otherwise                 → start an in-memory single-node replica set (supports transactions)
 *  - neither possible          → DB-backed suites are SKIPPED with a loud warning,
 *                                unless REQUIRE_DB=1, in which case the run fails.
 *
 * CI must set REQUIRE_DB=1 so a missing database can never turn into a silent pass.
 */
declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

export default async function setup(project: TestProject) {
  if (process.env.MONGO_TEST_URI) {
    project.provide('mongoUri', process.env.MONGO_TEST_URI);
    return;
  }

  try {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    const replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    project.provide('mongoUri', replSet.getUri());
    return async () => {
      await replSet.stop();
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
    if (process.env.REQUIRE_DB === '1') {
      throw new Error(`REQUIRE_DB=1 but no MongoDB could be started: ${reason}`, { cause: err });
    }
    process.stderr.write(
      `\n⚠️  No MongoDB available (${reason}).\n` +
        '   Database-backed integration suites will be SKIPPED.\n' +
        '   Set MONGO_TEST_URI or allow the MongoDB binary download to run them.\n\n',
    );
    project.provide('mongoUri', '');
  }
}
