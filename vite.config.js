// vite.config.js
import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// IMPORTANT: set base to your repo name so GitHub Pages serves assets correctly
export default defineConfig({
  base: '/cadVariables/',
  plugins: [
    nodePolyfills({
      protocolImports: true,
    }),
  ],
  build: {
    // Build as a library to produce a single IIFE file (safe for script tag loading)
    lib: {
      entry: 'src/cad-variables-widget.js',
      name: 'CadVariablesWidget',
      formats: ['iife'],
      fileName: () => 'cad-variables-widget.js',
    },
    rollupOptions: {
      output: {
        // Keep file names deterministic (no hashing)
        entryFileNames: 'cad-variables-widget.js',
        assetFileNames: '[name].[ext]',
        chunkFileNames: '[name].js',
      },
    },
  },
})
