import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "server",
          environment: "node",
          include: ["server/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "web",
          environment: "jsdom",
          setupFiles: ["./web/src/test/setup.ts"],
          environmentOptions: { jsdom: { url: "http://localhost/" } },
          include: ["web/src/**/*.test.{ts,tsx}"],
        },
      },
    ],
    clearMocks: true,
    restoreMocks: true,
  },
});
