import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const BUDGETS = ["src/log/budget.test.ts"];

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    css: true,
    pool: "forks",
    setupFiles: ["src/test/setup.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: BUDGETS,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "budget",
          include: BUDGETS,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
