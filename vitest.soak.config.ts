// Config for the balance harness ONLY — see `scripts/soak.ts`.
//
// It exists so `npm run soak` and `npm test` can never run each other's files.
// The harness plays hundreds of full matches and takes seconds to minutes; the
// unit suite must stay fast enough to run on every save. Keeping them apart is
// one `include` line rather than a naming convention someone has to remember,
// and `scripts/soak.ts` is deliberately not named `*.test.ts` so Vitest's
// default include cannot pick it up either.
//
// `silent: false` is required: Vitest swallows console output by default, and
// the harness's entire product is what it prints.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/soak.ts'],
    silent: false,
    // Let the report go straight to the terminal instead of being captured and
    // re-printed by the reporter, which is what hides it under the default setup.
    disableConsoleIntercept: true,
    // Hundreds of full matches; the 5s default would kill the run partway.
    testTimeout: 10 * 60 * 1000,
    // One match at a time, in one process. The harness is a measuring
    // instrument — interleaved reports from parallel workers would be unreadable
    // and the numbers are not sensitive to wall-clock time.
    fileParallelism: false,
  },
});
