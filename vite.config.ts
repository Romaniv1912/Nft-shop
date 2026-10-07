import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// TonConnect manifest must be an absolute, publicly reachable URL.
// APP_URL — the public URL of the deployed app (e.g. https://user.github.io/nft-shop/).
function tonconnectManifest(): Plugin {
  const manifest = (url: string) =>
    JSON.stringify(
      {
        url: url.replace(/\/$/, ''),
        name: 'NFT Shop (Getgems FixPrice v4 demo)',
        iconUrl: new URL('icon.png', url.endsWith('/') ? url : url + '/').toString(),
      },
      null,
      2,
    )
  return {
    name: 'tonconnect-manifest',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.endsWith('/tonconnect-manifest.json')) return next()
        const host = req.headers.host ?? 'localhost:5173'
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.end(manifest(process.env.APP_URL ?? `http://${host}/`))
      })
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'tonconnect-manifest.json',
        source: manifest(process.env.APP_URL ?? 'http://localhost:4173/'),
      })
    },
  }
}

export default defineConfig({
  base: process.env.BASE_PATH ?? './',
  plugins: [react(), tonconnectManifest()],
  define: { global: 'globalThis' },
})
