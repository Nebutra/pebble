/// <reference types="vitest/config" />

import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'

const packageDir = import.meta.dirname
const repoRoot = resolve(packageDir, '../..')
const rendererSource = resolve(repoRoot, 'packages/product-core/renderer/src')
const rootNodeModules = resolve(repoRoot, 'node_modules')

function createBundleBoundaryAudit(): Plugin | null {
  if (process.env.PEBBLE_BUNDLE_BOUNDARY_AUDIT !== '1') {
    return null
  }
  return {
    name: 'pebble-bundle-boundary-audit',
    generateBundle(_options, bundle) {
      const moduleChunkNames = new Map<string, string[]>()
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') {
          continue
        }
        for (const id of Object.keys(output.modules)) {
          moduleChunkNames.set(id, [...(moduleChunkNames.get(id) ?? []), output.name])
        }
      }
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk' || !['renderer-entry', 'vendor-monaco'].includes(output.name)) {
          continue
        }
        if (output.name === 'renderer-entry') {
          const largestModules = Object.entries(output.modules)
            .sort(([, left], [, right]) => right.renderedLength - left.renderedLength)
            .slice(0, 80)
            .map(([id, details]) => `${details.renderedLength}\t${id}`)
          console.log(`[bundle-boundary-largest] ${output.name}\n${largestModules.join('\n')}`)
        }
        const modules = Object.keys(output.modules).filter(
          (id) => output.name === 'renderer-entry' || id.includes('monaco')
        )
        console.log(`[bundle-boundary] ${output.name}\n${modules.join('\n')}`)
        if (output.name === 'vendor-monaco') {
          for (const id of modules) {
            const info = this.getModuleInfo(id)
            const staticImporters = info?.importers.filter((importer) =>
              importer.includes('/packages/product-core/renderer/src/')
            )
            if (staticImporters?.length) {
              const importerLines = staticImporters.map(
                (importer) =>
                  `${moduleChunkNames.get(importer)?.join(',') ?? 'unknown'} ${importer}`
              )
              console.log(`[bundle-boundary-importers] ${id}\n${importerLines.join('\n')}`)
            }
          }
        }
      }
    }
  }
}

function enforceBootstrapChunkIsolation(): Plugin {
  return {
    name: 'pebble-bootstrap-chunk-isolation',
    generateBundle(_options, bundle) {
      const bootstrap = Object.values(bundle).find(
        (output) => output.type === 'chunk' && output.isEntry
      )
      if (bootstrap?.type !== 'chunk') {
        this.error('Could not identify the Tauri bootstrap chunk.')
      }
      const vendorImport = bootstrap.imports.find((file) => file.includes('vendor-'))
      if (vendorImport) {
        // Why: bootstrap diagnostics must run before heavyweight renderer code;
        // a Monaco cycle here otherwise turns startup errors into a blank window.
        this.error(`Tauri bootstrap must not statically import ${vendorImport}.`)
      }
    }
  }
}

export default defineConfig({
  base: './',
  clearScreen: false,
  root: packageDir,
  plugins: [
    react(),
    tailwindcss(),
    enforceBootstrapChunkIsolation(),
    createBundleBoundaryAudit()
  ].filter((plugin): plugin is Plugin => plugin !== null),
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
    watch: {
      // Rust rebuilds write high-churn binary artifacts under src-tauri/target;
      // those must never drive renderer HMR or the app appears to reload forever.
      ignored: ['**/src-tauri/target/**']
    },
    fs: {
      allow: [repoRoot, packageDir]
    }
  },
  build: {
    // Why: Vite's preload helper can be absorbed by an arbitrary manual vendor
    // chunk, making the diagnostics bootstrap execute that vendor first.
    modulePreload: false,
    outDir: resolve(packageDir, 'dist'),
    emptyOutDir: true,
    // Why: manual vendor chunks can absorb Rollup's dynamic-import helper and
    // force bootstrap to execute app code before its startup diagnostics.
    rollupOptions: { output: {} }
  },
  worker: {
    format: 'es'
  },
  test: {
    setupFiles: [resolve(packageDir, 'src/vitest-browser-storage.ts')]
  }
})
