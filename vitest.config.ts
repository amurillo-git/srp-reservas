import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "web/src/lib/**/*.test.ts"],
    globals: false,
  },
});
