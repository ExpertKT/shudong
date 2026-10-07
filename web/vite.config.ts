import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port: 5173,
    proxy: {
      // SSE 也走这条代理，所以不要给 /api 设 ws，也别开 buffer
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
});
