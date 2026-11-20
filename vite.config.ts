import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

const nodePolyfillsConfig = {
  globals: {
    Buffer: true,
    global: true,
    process: true,
  },
  protocolImports: true,
} as const

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    nodePolyfills(nodePolyfillsConfig),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/service-worker',
      filename: 'service-worker.ts',
      injectManifest: {
        globPatterns: [], // Don't precache anything
        injectionPoint: undefined, // We don't use injection
        // Use IIFE format to avoid CommonJS/ESM interop issues
        // IIFE wraps everything in a function scope, avoiding bare exports references
        rollupFormat: 'iife',
        buildPlugins: {
          vite: [nodePolyfills(nodePolyfillsConfig)],
        },
      },
      injectRegister: null, // Don't auto-inject registration
      manifest: false, // Don't generate web manifest
      devOptions: {
        enabled: true, // Enable service worker in dev mode
        type: 'module',
      },
    }),
  ],
  build: {
    // Ensure CommonJS modules are properly transformed
    commonjsOptions: {
      transformMixedEsModules: true,
      // Ensure exports/module are available
      requireReturnsDefault: 'auto',
    },
  },
  // Worker-specific configuration for service worker builds
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        entryFileNames: '[name].js',
      },
    },
  },
})
