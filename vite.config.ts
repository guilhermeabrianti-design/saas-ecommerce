/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Only VITE_-prefixed variables reach the browser bundle. Server secrets
  // (service role, OAuth secrets, OpenAI key) must never use this prefix.
  envPrefix: 'VITE_',
  server: {
    host: '127.0.0.1',
    port: 3001,
    strictPort: true,
  },
  build: {
    sourcemap: false,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Tests never talk to a real Supabase project, whatever .env.local says.
    env: { VITE_APP_ENV: 'development', VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    // The first PGlite (Postgres WASM) boot per file can take >10s on slow machines.
    hookTimeout: 60_000,
  },
});
