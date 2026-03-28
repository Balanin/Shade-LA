import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs/promises'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/compute': {
        target: 'http://localhost:6500',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/compute/, ''),
        configure: (proxy) => {
          const key =
            process.env.VITE_COMPUTE_KEY ||
            process.env.COMPUTE_KEY ||
            process.env.RHINO_COMPUTE_KEY ||
            'shadela-local'

          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('RhinoComputeKey', key)
          })
        },
      },
    },
  },
  plugins: [
    react({
      babel: {
        plugins: [['babel-plugin-react-compiler']],
      },
    }),
    {
      name: 'gh-debug-log-writer',
      configureServer(server) {
        server.middlewares.use('/gh-geojson-upload', async (req, res, next) => {
          try {
            if (req.method !== 'POST') return next()

            let body = ''
            req.setEncoding('utf-8')
            req.on('data', (chunk) => {
              body += chunk
            })
            req.on('end', async () => {
              try {
                const payload = body ? JSON.parse(body) : {}
                const geojsonText = String(payload?.geojsonText ?? '')
                if (!geojsonText) {
                  res.statusCode = 400
                  res.setHeader('Content-Type', 'application/json')
                  res.end(JSON.stringify({ ok: false, error: 'geojsonText missing' }))
                  return
                }

                const root = server.config.root || process.cwd()
                const outDir = path.resolve(root, 'public', 'gh')
                await fs.mkdir(outDir, { recursive: true })

                const ts = Date.now()
                const fileName = `osm-geojson-${ts}.geojson`
                const outPath = path.resolve(outDir, fileName)
                await fs.writeFile(outPath, geojsonText, 'utf-8')

                const url = `/gh/${fileName}`
                res.statusCode = 200
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ ok: true, url, path: outPath }))
              } catch (e) {
                res.statusCode = 500
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }))
              }
            })
          } catch (e) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }))
          }
        })

        server.middlewares.use('/gh-debug-log', async (req, res, next) => {
          try {
            if (req.method !== 'POST') return next()

            let body = ''
            req.setEncoding('utf-8')
            req.on('data', (chunk) => {
              body += chunk
            })
            req.on('end', async () => {
              try {
                const payload = body ? JSON.parse(body) : {}
                const ts = Number(payload?.ts) || Date.now()
                const out = {
                  ts,
                  rawRhOut: payload?.rawRhOut ?? null,
                  rawBlank: payload?.rawBlank ?? null,
                }

                const root = server.config.root || process.cwd()
                const outDir = path.resolve(root, 'public', 'gh')
                await fs.mkdir(outDir, { recursive: true })
                const outPath = path.resolve(outDir, 'gh-debug-latest.txt')
                await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf-8')

                res.statusCode = 200
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ ok: true, path: outPath }))
              } catch (e) {
                res.statusCode = 500
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }))
              }
            })
          } catch (e) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }))
          }
        })

        server.middlewares.use('/gh-debug-request', async (req, res, next) => {
          try {
            if (req.method !== 'POST') return next()

            let body = ''
            req.setEncoding('utf-8')
            req.on('data', (chunk) => {
              body += chunk
            })
            req.on('end', async () => {
              try {
                const payload = body ? JSON.parse(body) : null

                const root = server.config.root || process.cwd()
                const outDir = path.resolve(root, 'public', 'gh')
                await fs.mkdir(outDir, { recursive: true })
                const outPath = path.resolve(outDir, 'gh-request-latest.txt')
                await fs.writeFile(
                  outPath,
                  JSON.stringify({ ts: Date.now(), payload }, null, 2),
                  'utf-8'
                )

                res.statusCode = 200
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ ok: true, path: outPath }))
              } catch (e) {
                res.statusCode = 500
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }))
              }
            })
          } catch (e) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }))
          }
        })
      },
    },
  ],
})
