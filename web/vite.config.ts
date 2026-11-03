import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@ageless/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) } },
  server: { port: 5173 },
  build: { outDir: 'dist' },
});
