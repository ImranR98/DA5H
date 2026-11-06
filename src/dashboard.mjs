import path from 'node:path'
import {
  asyncRoute,
  configStore,
  isPrivateHost,
  Notifier,
  SECRET_MASK,
  ValidationError,
} from '@dscpln/server-kit'

// DA5H dashboard settings and notification relay. The dashboard is the only
// component that knows the ntfy URL/token; the other apps post to /api/notify.

const env = (name, fallback) => String(process.env[name] ?? fallback).trim()

export const DEFAULT_FUNCTIONS = [
  {
    path: 'dscpln',
    url: env('DSCPLN_URL', 'http://localhost:3300/'),
    icon: 'dollar',
    name: 'D$CPLN',
    description: 'Budget dashboard backed by the live workbook',
    kind: 'balance',
  },
  {
    path: 'watxt',
    url: env('WATXT_URL', 'http://localhost:8787/'),
    icon: 'message',
    name: 'W@TXT',
    description: 'Browse, import and merge WhatsApp chat exports',
    kind: 'watxt',
  },
  {
    path: 'fl0w',
    url: env('FL0W_URL', 'http://localhost:8085/'),
    icon: 'workflow',
    name: 'FL0W',
    description: 'Scheduled tasks and file pipelines',
    kind: 'flow',
  },
  {
    path: 'lockdown',
    url: '/lockdown',
    icon: 'lock',
    name: 'Lockdown',
    description: 'Temporarily block configured host ports',
    kind: 'lockdown',
  },
]

export const DEFAULT_CONFIG = {
  ntfy: { url: '', token: '' },
  functions: DEFAULT_FUNCTIONS,
}

const MAX_MESSAGE = 4096
const MAX_TITLE = 200
const MAX_TAGS = 10
const PRIORITIES = new Set(['max', 'urgent', 'high', 'default', 'low', 'min'])
const FUNCTION_KINDS = new Set(['scheduled', 'flow', 'watxt', 'balance', 'lockdown'])

export function normalizeFunctions(value) {
  if (!Array.isArray(value)) return DEFAULT_FUNCTIONS
  return value
    .map((entry) => (entry && typeof entry === 'object' ? entry : null))
    .filter(Boolean)
    .map((entry) => {
      const fnPath = String(entry.path ?? '').replace(/^\/+|\/+$/g, '')
      return {
        path: fnPath,
        url: String(entry.url ?? '').trim() || `/${fnPath}`,
        icon: String(entry.icon ?? 'boxes'),
        name: String(entry.name ?? entry.path ?? ''),
        description: String(entry.description ?? ''),
        kind: FUNCTION_KINDS.has(entry.kind) ? entry.kind : 'scheduled',
      }
    })
}

export function normalizeConfig(raw) {
  return {
    ...raw,
    ntfy: { url: '', token: '', ...(raw?.ntfy ?? {}) },
    functions: normalizeFunctions(raw?.functions),
  }
}

export function validateConfig(cfg) {
  const url = String(cfg.ntfy?.url ?? '').trim()
  if (url && !/^https?:\/\//i.test(url)) {
    throw new ValidationError('ntfy URL must start with http:// or https://')
  }
  const seen = new Set()
  for (const fn of cfg.functions ?? []) {
    if (!fn.path || !fn.name) throw new ValidationError('every function needs a path and a name')
    if (!/^[A-Za-z0-9._-]+$/.test(fn.path)) throw new ValidationError(`function path is invalid: ${fn.path}`)
    if (fn.url && !/^https?:\/\//i.test(fn.url) && !fn.url.startsWith('/')) {
      throw new ValidationError(`function ${fn.path}: url must be absolute or start with /`)
    }
    if (seen.has(fn.path)) throw new ValidationError(`duplicate function path: ${fn.path}`)
    seen.add(fn.path)
  }
}

function normalizePriority(value) {
  const priority = String(value ?? '').trim().toLowerCase()
  return PRIORITIES.has(priority) ? priority : 'default'
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((tag) => String(tag).trim().slice(0, 32))
    .filter(Boolean)
    .slice(0, MAX_TAGS)
}

export function createDashboard(options = {}) {
  const configFile = options.configFile ?? process.env.DA5H_CONFIG ?? path.resolve('config/config.json')
  const log = options.log ?? ((line) => console.log(line))
  const config = configStore(configFile, {
    defaults: DEFAULT_CONFIG,
    normalize: normalizeConfig,
    validate: validateConfig,
    secrets: ['ntfy.token'],
  })

  const dispatch = async (payload, { draft = null } = {}) => {
    const message = String(payload?.message ?? '').trim()
    if (!message) return { status: 400, body: { error: 'message is required' } }
    if (message.length > MAX_MESSAGE) {
      return { status: 400, body: { error: `message must be at most ${MAX_MESSAGE} characters` } }
    }
    const stored = config.get()?.ntfy ?? {}
    const url = String(draft?.url ?? '').trim() || String(stored.url ?? '').trim()
    let token = String(draft?.token ?? '').trim()
    if (!token || token === SECRET_MASK) token = String(stored.token ?? '').trim()
    if (!url) return { status: 400, body: { error: 'ntfy URL is not configured' } }
    if (!/^https?:\/\//i.test(url)) {
      return { status: 400, body: { error: 'ntfy URL must start with http:// or https://' } }
    }
    const title = String(payload.title ?? '').trim().slice(0, MAX_TITLE) || 'DA5H'
    const result = await new Notifier({ ntfy: { url, token }, click: payload.click }).notify(message, {
      title,
      priority: normalizePriority(payload.priority),
      tags: normalizeTags(payload.tags),
    })
    if (!result.ok) {
      log(`notification failed: ${result.error}`)
      return { status: 502, body: { error: result.error } }
    }
    return { status: 200, body: { ok: true } }
  }

  const routes = (router) => {
    router.get('/api/functions', (req, res) => {
      res.json({ functions: config.get()?.functions ?? DEFAULT_FUNCTIONS })
    })

    router.post('/api/notify', asyncRoute(async (req, res) => {
      const { status, body } = await dispatch(req.body ?? {})
      res.status(status).json(body)
    }))

    router.post('/api/notify/test', asyncRoute(async (req, res) => {
      const body = req.body ?? {}
      const draftUrl = String(body.url ?? '').trim()
      if (draftUrl) {
        let draftHost
        let configuredHost
        try {
          draftHost = new URL(draftUrl).hostname
        } catch {
          res.status(400).json({ error: 'ntfy URL is not a valid URL' })
          return
        }
        try {
          configuredHost = new URL(config.get()?.ntfy?.url ?? '').hostname
        } catch {
          configuredHost = ''
        }
        if (isPrivateHost(draftHost) && draftHost !== configuredHost) {
          res.status(400).json({ error: 'ntfy URL must not target a private address' })
          return
        }
      }
      const { status, body: result } = await dispatch(
        { message: 'DA5H test notification', title: 'DA5H - test', priority: 'low', tags: ['white_check_mark'] },
        { draft: { url: body.url, token: body.token } },
      )
      res.status(status).json(result)
    }))
  }

  const start = async () => {
    await config.load()
    return { config }
  }

  return { config, routes, start }
}
