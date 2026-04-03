import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs/promises'
import path from 'node:path'
 import { PNG } from 'pngjs'

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

        server.middlewares.use('/terrain-grid', async (req, res, next) => {
          try {
            if (req.method !== 'GET') return next()

            const url = new URL(req.url || '', 'http://localhost')
            const west = Number(url.searchParams.get('west'))
            const south = Number(url.searchParams.get('south'))
            const east = Number(url.searchParams.get('east'))
            const north = Number(url.searchParams.get('north'))
            const w = Number(url.searchParams.get('w') || '128')
            const h = Number(url.searchParams.get('h') || '128')
            const z = Number(url.searchParams.get('z') || '12')

            if (![west, south, east, north].every((n) => Number.isFinite(n))) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: false, error: 'Missing/invalid west,south,east,north' }))
              return
            }
            if (!Number.isFinite(w) || !Number.isFinite(h) || w < 2 || h < 2 || w > 512 || h > 512) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: false, error: 'Invalid w/h (2..512)' }))
              return
            }
            if (!Number.isFinite(z) || z < 0 || z > 15) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: false, error: 'Invalid z (0..15)' }))
              return
            }

            const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

            const lon2tileX = (lon: number, zoom: number) => ((lon + 180) / 360) * Math.pow(2, zoom)
            const lat2tileY = (lat: number, zoom: number) => {
              const latRad = (lat * Math.PI) / 180
              return (
                (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2
              ) * Math.pow(2, zoom)
            }

            const metersPerPixelAtLat = (lat: number, zoom: number) => {
              const earthCirc = 40075016.686
              return (earthCirc * Math.cos((lat * Math.PI) / 180)) / (256 * Math.pow(2, zoom))
            }

            const sampleLon = (i: number) => west + (east - west) * (i / (w - 1))
            const sampleLat = (j: number) => north + (south - north) * (j / (h - 1))

            const centerLat = (south + north) / 2
            const cellSize = metersPerPixelAtLat(centerLat, z)

            const tileCache = new Map<string, PNG>()

            const fetchTile = async (tx: number, ty: number, zoom: number) => {
              const max = Math.pow(2, zoom)
              const x = ((tx % max) + max) % max
              const y = clamp(ty, 0, max - 1)
              const key = `${zoom}/${x}/${y}`
              const existing = tileCache.get(key)
              if (existing) return existing
              const tileUrl = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${x}/${y}.png`
              const r = await fetch(tileUrl)
              if (!r.ok) throw new Error(`Failed to fetch tile ${key}: ${r.status}`)
              const buf = Buffer.from(await r.arrayBuffer())
              const png = PNG.sync.read(buf)
              tileCache.set(key, png)
              return png
            }

            const heights: number[] = new Array(w * h)

            for (let j = 0; j < h; j++) {
              const lat = sampleLat(j)
              const tyFloat = lat2tileY(lat, z)
              const ty = Math.floor(tyFloat)
              const py = Math.floor((tyFloat - ty) * 256)

              for (let i = 0; i < w; i++) {
                const lon = sampleLon(i)
                const txFloat = lon2tileX(lon, z)
                const tx = Math.floor(txFloat)
                const px = Math.floor((txFloat - tx) * 256)

                const png = await fetchTile(tx, ty, z)
                const idx = (py * png.width + px) << 2
                const r = png.data[idx]
                const g = png.data[idx + 1]
                const b = png.data[idx + 2]
                const elev = r * 256 + g + b / 256 - 32768
                heights[j * w + i] = elev
              }
            }

            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                ok: true,
                w,
                h,
                z,
                cellSize,
                heights,
                bbox: { west, south, east, north },
              })
            )
          } catch (e) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: String((e as any)?.message || e) }))
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
