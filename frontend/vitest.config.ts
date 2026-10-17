import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Separate from `vite.config.ts` on purpose: that file describes the app that
 * ships, and nothing about how it is tested belongs in the bundle's
 * configuration. Vitest reads this one instead, and the `@` alias is repeated
 * here rather than imported so a change to the build config cannot silently
 * change what the tests resolve.
 *
 * The environment is `node`, not `jsdom`. Everything covered so far is pure
 * logic — the permission matrix, locale negotiation, translation fallback,
 * formatting — and none of it touches the DOM. The two functions that read
 * `window` are exercised by stubbing the globals, which is both faster and
 * honest about what they actually need. A DOM only earns its place here when a
 * component test does.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Tests live beside the app they guard rather than inside `src`, mirroring
    // `backend/test/`, so the build input stays exactly the two HTML entries.
    root: fileURLToPath(new URL('.', import.meta.url))
  }
})
