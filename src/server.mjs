#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { asyncRoute, createApp } from '@dscpln/server-kit'
import { createDashboard } from './dashboard.mjs'
import { createLockdownApp } from './lockdown/server.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const STATIC_DIR = path.join(here, '..', 'static')

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
      router.use('/api/services/:path', asyncRoute(async (req, res) => {
        const functions = dashboard.config.get()?.functions ?? []
        const fn = functions.find((entry) => entry.path === req.params.path)
        if (!fn) return res.status(404).json({ error: 'Unknown service' })
        const host = req.headers.host ?? '127.0.0.1:8080'
        const source = fn.internalUrl || fn.url
        const base = /^https?:\/\//i.test(source) ? source : new URL(source, `http://${host}`).toString()
        const target = `${base.replace(/\/+$/, '')}${req.path.startsWith('/') ? req.path : `/${req.path}`}`
        const headers = {}
        if (req.headers['remote-user']) headers['Remote-User'] = req.headers['remote-user']
        let upstream
        try {
          upstream = await fetch(target, { headers, signal: AbortSignal.timeout(8000) })
        } catch (err) {
          return res.status(502).json({ error: `service unavailable: ${err.message}` })
        }
        const body = Buffer.from(await upstream.arrayBuffer())
        const type = upstream.headers.get('content-type')
        if (type) res.type(type)
        res.status(upstream.status).send(body)
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
