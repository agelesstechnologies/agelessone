import 'dotenv/config';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    globalSetup: ['src/test/global-setup.ts'],             // resets and migrates TEST_DATABASE_URL
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? '' }, // the app under test never touches your dev database
  },
});
