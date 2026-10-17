import { defineConfig, searchForWorkspaceRoot } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

/**
 * O commit de que este build saiu, para o rodapé do menu. `release.json` só
 * muda quando se corta uma versão, então sem isto dois builds diferentes
 * mostravam o mesmo "v1.17.0" e não havia como saber se o servidor já tinha
 * rodado o `skygenpanel update`. Vazio quando não há git (imagem Docker, que
 * não copia `.git`) — o rodapé então mostra só a versão.
 */
function buildCommit(): string {
  const fromEnv = process.env.SKYGP_COMMIT || process.env.GITHUB_SHA
  if (fromEnv) return fromEnv.slice(0, 7)
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_COMMIT__: JSON.stringify(buildCommit()),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 3000,
    // Os manuais de cobrança moram em `../docs` e entram por `?raw`
    // (src/lib/help-docs.ts). O build lê de qualquer lugar; o servidor de
    // desenvolvimento só serve o que está liberado aqui.
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), fileURLToPath(new URL('../docs', import.meta.url))],
    },
    proxy: {
      '/api': {
        target: process.env.API_URL || 'http://127.0.0.1:5890',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2020',
    rollupOptions: {
      input: {
        panel: fileURLToPath(new URL('./index.html', import.meta.url)),
        portal: fileURLToPath(new URL('./portal.html', import.meta.url)),
      },
    },
  },
})
