import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 10_000, hookTimeout: 60_000, teardownTimeout: 10_000, pool: "forks", poolOptions: { forks: { singleFork: true } } } });
