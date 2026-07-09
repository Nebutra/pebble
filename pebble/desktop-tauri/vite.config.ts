import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const packageDir = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(packageDir, '../..')
const rendererSource = resolve(repoRoot, 'src/renderer/src')
const rootNodeModules = resolve(repoRoot, 'node_modules')

export default defineConfig({
  base: './',
  clearScreen: false,
  root: packageDir,
  plugins: [react(), tailwindcss()],
  define: {
    PEBBLE_BUILD_IDENTITY: 'null',
    PEBBLE_POSTHOG_WRITE_KEY: 'null',
    PEBBLE_DIAGNOSTICS_TOKEN_URL: 'null',
    PEBBLE_FEATURE_WALL_ENABLED: 'true'
  },
  resolve: {
    alias: {
      react: resolve(rootNodeModules, 'react'),
      'react-dom': resolve(rootNodeModules, 'react-dom'),
      '@renderer': rendererSource,
      '@': rendererSource
    },
    dedupe: ['react', 'react-dom']
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    fs: {
      allow: [repoRoot, packageDir]
    }
  },
  build: {
    outDir: resolve(packageDir, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split stable framework/UI vendors into their own long-cached chunks so
        // the entry chunk carries app code only — app edits stop re-parsing/
        // re-downloading react-dom and the radix/floating-ui primitives.
        manualChunks(id) {
          if (!id.includes('/node_modules/')) {
            return undefined
          }
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return 'vendor-react'
          }
          if (/[\\/]node_modules[\\/](@radix-ui|@floating-ui|react-remove-scroll|cmdk)[\\/]/.test(id)) {
            return 'vendor-ui'
          }
          return undefined
        }
      }
    }
  },
  worker: {
    format: 'es'
  }
})
