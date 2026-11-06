#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { asyncRoute, createApp } from '@dscpln/server-kit'
import { createDashboard } from './dashboard.mjs'
import { createLockdownApp } from './lockdown/server.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const STATIC_DIR = path.join(here, '..', 'static')

// The dashboard only needs a handful of read endpoints from each sibling.
// Everything else (notably credential/token routes) stays unreachable through
// the proxy even though DA5H itself can route to the service.
const SERVICE_PATHS = {
  scheduled: ['/api/health', '/api/state'],
  watxt: ['/api/health', '/api/state'],
  flow: ['/api/health', '/api/jobs'],
  balance: ['/api/health', '/status'],
  lockdown: ['/api/health', '/api/status'],
}
const allowedServicePaths = (kind) => SERVICE_PATHS[kind] ?? ['/api/health']

// DA5H is one Express app: the dashboard shell, the notification relay and the
// Lockdown module. Lockdown keeps its own server/blocker split so the
// privileged nftables process remains separate from the web tier.
export function createDa5hApp(options = {}) {
  const log = options.log ?? ((line) => console.log(line))
  const dashboard = createDashboard({ configFile: options.configFile, log })
  const lockdown = createLockdownApp({
    ...(options.lockdown ?? {}),
    basePath: '',
    staticDir: null,
    auth: null,
    log,
    configFile: options.lockdownConfigFile
      ?? process.env.LOCKDOWN_CONFIG
      ?? path.resolve('config/lockdown.json'),
  })

  const app = createApp({
    title: 'Dashboard',
    brand: 'DA5H',
    basePath: options.basePath ?? '',
    staticDir: STATIC_DIR,
    config: dashboard.config,
    jsonBody: true,
    routes: (router) => {
      dashboard.routes(router)

      // Same-origin service reads for the dashboard. The browser cannot call
      // the sibling subdomains directly (CORS), so DA5H proxies the small set
      // of health/summary endpoints to the configured service URLs and forwards
      // the Authelia identity. Only configured function paths are reachable.
      //
      // This is a read-only proxy: it never forwards cookies or the request
      // body, never follows an upstream redirect, and caps the response size.
      // Without those limits a misconfigured (or compromised) sibling could
      // turn the dashboard into an open write path or a memory sink.
      router.use('/api/services/:path', asyncRoute(async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.set('Allow', 'GET, HEAD')
          return res.status(405).json({ error: 'Service reads are read-only' })
        }
        const functions = dashboard.config.get()?.functions ?? []
        const fn = functions.find((entry) => entry.path === req.params.path)
        if (!fn) return res.status(404).json({ error: 'Unknown service' })

        const suffix = String(req.path ?? '/')
        let decoded
        try {
          decoded = decodeURIComponent(suffix)
        } catch {
          return res.status(400).json({ error: 'Invalid service path' })
        }
        const hasControl = [...decoded].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)
        if (!decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('..') || hasControl) {
          return res.status(400).json({ error: 'Invalid service path' })
        }
        if (!allowedServicePaths(fn.kind).includes(decoded.replace(/\/+$/, ''))) {
          return res.status(404).json({ error: 'Unknown service endpoint' })
        }

        const host = req.headers.host ?? '127.0.0.1:8080'
        const source = fn.internalUrl || fn.url
        let base
        try {
          base = new URL(source, `http://${host}`)
        } catch {
          return res.status(502).json({ error: 'Service URL is invalid' })
        }
        if (!base.pathname.endsWith('/')) base.pathname += '/'
        const target = new URL(decoded.replace(/^\/+/, ''), base)

        const headers = { Accept: 'application/json' }
        if (req.headers['remote-user']) headers['Remote-User'] = String(req.headers['remote-user'])
        let upstream
        try {
          upstream = await fetch(target, {
            method: req.method,
            headers,
            redirect: 'manual',
            signal: AbortSignal.timeout(8000),
          })
        } catch (err) {
          return res.status(502).json({ error: `service unavailable: ${err.message}` })
        }

        const MAX_BYTES = 2 * 1024 * 1024
        const declared = Number(upstream.headers.get('content-length') ?? 0)
        if (Number.isFinite(declared) && declared > MAX_BYTES) {
          await upstream.body?.cancel().catch(() => {})
          return res.status(502).json({ error: 'service response is too large' })
        }
        let body = Buffer.alloc(0)
        if (req.method !== 'HEAD' && upstream.body) {
          const chunks = []
          let total = 0
          for await (const chunk of upstream.body) {
            total += chunk.length
            if (total > MAX_BYTES) {
              await upstream.body.cancel().catch(() => {})
              return res.status(502).json({ error: 'service response is too large' })
            }
            chunks.push(Buffer.from(chunk))
          }
          body = Buffer.concat(chunks)
        }

        res.set('Cache-Control', 'no-store')
        const type = upstream.headers.get('content-type')
        if (type) res.type(type)
        res.status(upstream.status).send(req.method === 'HEAD' ? undefined : body)
      }))

      // Serve the single-page UI for the Lockdown module. This route must come
      // before the mounted lockdown app so the exact /lockdown path is the UI,
      // while /lockdown/api/* reaches the module server.
      router.get(['/lockdown', '/lockdown/'], (req, res) => {
        res.type('html').send(fs.readFileSync(path.join(STATIC_DIR, 'index.html')))
      })

      router.use('/lockdown', lockdown.app)
    },
    log,
  })

  const start = async () => {
    await dashboard.start()
    await lockdown.start()
    return { config: dashboard.config, lockdown: lockdown.config }
  }

  return { app, config: dashboard.config, lockdown, start }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const da5h = createDa5hApp()
  await da5h.start()
  const port = Number(process.env.PORT ?? 8080)
  const host = process.env.HOST ?? '0.0.0.0'
  da5h.app.listen(port, host, () => {
    console.log(`DA5H listening on http://${host}:${port}`)
  })
}
