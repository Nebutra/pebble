import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: resolve('packages/product-core/renderer'),
  // Why: pairing URLs may live under a reverse-proxy path prefix like
  // /pebble/web-index.html, so built assets must resolve relative to the page.
  base: './',
  plugins: [react(), tailwindcss()],
  define: {
    PEBBLE_FEATURE_WALL_ENABLED: 'true'
  },
  resolve: {
    alias: {
      '@renderer': resolve('packages/product-core/renderer/src'),
      '@': resolve('packages/product-core/renderer/src')
    }
  },
  build: {
    outDir: resolve('out/web'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve('packages/product-core/renderer/web-index.html')
    }
  },
  worker: {
    format: 'es'
  }
})
