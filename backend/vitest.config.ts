import 'dotenv/config';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    globalSetup: ['src/test/global-setup.ts'],             // resets and migrates TEST_DATABASE_URL
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',    // the app under test never touches your dev database
      UPLOAD_DIR: join(tmpdir(), 'ageless-test-uploads'),   // test receipts never land in backend/uploads
      GEOCODING_PROVIDER: 'none',                            // tests never call a real geocoder (the geocoding test runs its own)
      TRUST_PROXY: 'loopback',                               // the sign-in limit test sends X-Forwarded-For from 127.0.0.1
      EMAIL_PROVIDER: 'memory',                         // sign-in codes are kept in memory, never emailed (read with sentMail())
      SMS_PROVIDER: 'memory',                           // sign-in codes by SMS are kept in memory (sentSms())
      DEV_SHOW_CODES: 'false',                         // codes never appear in answers in tests
    },
  },
});
