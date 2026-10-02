import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: '*.spec.js', workers: 1,
  use: { baseURL: 'http://localhost:8788', headless: true },
});
