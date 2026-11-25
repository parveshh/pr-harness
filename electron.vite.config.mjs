import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  main: {
    build: {
      minify: command === 'build',
      externalizeDeps: false,
      outDir: 'dist/main',
      lib: { entry: 'desktop/main.ts', formats: ['es'], fileName: () => 'main.js' },
    },
  },
  preload: {
    build: {
      minify: command === 'build',
      outDir: 'dist/preload',
      externalizeDeps: false,
      lib: { entry: 'desktop/preload.ts', formats: ['cjs'], fileName: () => 'preload.cjs' },
    },
  },
  renderer: {
    root: 'client',
    plugins: [
      react(),
      {
        name: 'react-refresh-development-policy',
        apply: 'serve',
        transformIndexHtml(html) {
          // Vite injects an inline React Refresh bootstrap in development.
          return html
            .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
            .replace("connect-src 'self'", "connect-src 'self' ws://127.0.0.1:*");
        },
      },
    ],
    server: {
      host: '127.0.0.1',
      fs: { allow: ['client', 'shared', 'node_modules'].map((path) => resolve(path)) },
    },
    build: {
      minify: command === 'build',
      outDir: resolve('dist/renderer'),
      rollupOptions: { input: resolve('client/index.html') },
    },
  },
}));
