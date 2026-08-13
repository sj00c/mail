import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./web/src/test/setup.ts"],
    environmentOptions: {
      jsdom: {
        url: "http://localhost/",
      },
    },
    include: ["web/src/**/*.test.{ts,tsx}", "server/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
