import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests share one physical Postgres database (hcm_test); concurrent
    // TRUNCATEs between files would race. Sequence files, keep tests within
    // a file sequential by default.
    fileParallelism: false,
  },
});
