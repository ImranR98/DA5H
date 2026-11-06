import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import path from 'node:path'
import { launchBrowser, tempDir } from '@dscpln/test-kit'
import { createDa5hApp } from '../server.mjs'

const presets = [
  {
    id: 'public-web',
    label: 'Public web',
    short: 'Block public web ports',
    protocol: 'tcp',
    direction: 'input',
    ports: [80, 8443],
    allowIndefinite: true,
    defaultDurationSeconds: 1800,
    confirmation: 'BLOCK PUBLIC',
    danger: false,
    effect: 'Blocks public web ports.',
    warning: 'You may lose this page.',
  },
]

const blockerStatus = {
  ok: true,
  now: Date.now(),
  table: { name: 'da5h_test' },
  presets: { 'public-web': { active: false, ports: [], expiresAt: null, remainingSeconds: null } },
  pending: {},
  limits: { minDurationSeconds: 600, maxDurationSeconds: 86400 },
}

async function fixture(t) {
  const file = path.join(tempDir('da5h-test-'), 'config.json')
  const da5h = createDa5hApp({
    configFile: file,
    log: () => {},
    lockdown: {
      presets,
      blockerUrl: 'http://blocker.test',
      blockerToken: 'test-token',
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(blockerStatus) }),
    },
  })
  await da5h.start()
  const server = da5h.app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { ...da5h, base: `http://127.0.0.1:${server.address().port}` }
}

async function mockNtfy(t, { status = 200 } = {}) {
  const received = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      received.push({ headers: req.headers, body })
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(status === 200 ? '{}' : '{"error":"denied"}')
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { url: `http://127.0.0.1:${server.address().port}/topic`, received }
}

const putConfig = (base, body) =>
  fetch(`${base}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

const postNotify = (base, body, route = '/api/notify') =>
  fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

test('DA5H masks the ntfy token and keeps it when the mask is saved back', async (t) => {
  const { base } = await fixture(t)
  const initial = await (await fetch(`${base}/api/config`)).json()
  assert.deepEqual(initial.ntfy, { url: '', token: '' })

  await putConfig(base, { ntfy: { url: 'https://ntfy.example/topic', token: 'tk_secret' } })
  const masked = await (await fetch(`${base}/api/config`)).json()
  assert.equal(masked.ntfy.url, 'https://ntfy.example/topic')
  assert.equal(masked.ntfy.token, '••••••••')

  await putConfig(base, { ntfy: { url: 'https://ntfy.example/topic', token: '••••••••' } })
  const stillMasked = await (await fetch(`${base}/api/config`)).json()
  assert.equal(stillMasked.ntfy.token, '••••••••')

  const rejected = await putConfig(base, { ntfy: { url: 'ftp://bad', token: '' } })
  assert.equal(rejected.status, 400)
})

test('DA5H relays app notifications to the configured ntfy topic', async (t) => {
  const mock = await mockNtfy(t)
  const { base } = await fixture(t)
  await putConfig(base, { ntfy: { url: mock.url, token: 'tk_test' } })

  const response = await postNotify(base, {
    app: 'FL0W',
    message: 'Camera: PXL_1234.jpg processed',
    title: 'FL0W - File Pipelines',
    priority: 'low',
    tags: ['white_check_mark'],
    click: 'https://fl0w.example/',
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(mock.received.length, 1)
  const { headers, body } = mock.received[0]
  assert.equal(headers.title, 'FL0W - File Pipelines')
  assert.equal(headers.priority, 'low')
  assert.equal(headers.tags, 'white_check_mark')
  assert.equal(headers.click, 'https://fl0w.example/')
  assert.equal(headers.authorization, 'Bearer tk_test')
  assert.match(body, /PXL_1234\.jpg/)
})

test('DA5H relay reports missing config, bad payloads and ntfy failures', async (t) => {
  const { base } = await fixture(t)
  const unconfigured = await postNotify(base, { message: 'hello' })
  assert.equal(unconfigured.status, 400)
  assert.match((await unconfigured.json()).error, /not configured/)

  const mock = await mockNtfy(t, { status: 401 })
  await putConfig(base, { ntfy: { url: mock.url, token: '' } })
  const noMessage = await postNotify(base, {})
  assert.equal(noMessage.status, 400)

  const upstream = await postNotify(base, { message: 'hello' })
  assert.equal(upstream.status, 502)
  assert.match((await upstream.json()).error, /ntfy returned 401/)
})

test('DA5H test endpoint accepts a draft URL but refuses other private hosts', async (t) => {
  const mock = await mockNtfy(t)
  const { base } = await fixture(t)
  await putConfig(base, { ntfy: { url: mock.url, token: '' } })

  const sent = await postNotify(base, { url: mock.url, token: 'tk_draft' }, '/api/notify/test')
  assert.equal(sent.status, 200)
  assert.equal(mock.received.length, 1)
  assert.equal(mock.received[0].headers.authorization, 'Bearer tk_draft')
  assert.equal(mock.received[0].body, 'DA5H test notification')

  const ssrf = await postNotify(base, { url: 'http://10.1.2.3:3000/topic', token: 'tk_draft' }, '/api/notify/test')
  assert.equal(ssrf.status, 400)
  assert.match((await ssrf.json()).error, /private address/)
})

test('DA5H renders the service cards and the DA5H brand', async (t) => {
  const browser = await launchBrowser()
  if (!browser) {
    t.skip('chromium not available')
    return
  }
  t.after(() => browser.close())

  const { base } = await fixture(t)
  await putConfig(base, {
    functions: [
      { path: 'dscpln', url: 'https://dscpln.example/', icon: 'dollar', name: 'D$CPLN', description: 'Budget', kind: 'balance' },
      { path: 'watxt', url: 'https://watxt.example/', icon: 'message', name: 'W@TXT', description: 'Chats', kind: 'watxt' },
      { path: 'fl0w', url: 'https://fl0w.example/', icon: 'workflow', name: 'FL0W', description: 'Jobs', kind: 'flow' },
      { path: 'lockdown', url: '/lockdown', icon: 'lock', name: 'Lockdown', description: 'Ports', kind: 'lockdown' },
    ],
  })

  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (err) => errors.push(err.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().includes('Failed to load resource')) errors.push(msg.text())
  })

  await page.goto(`${base}/`)
  await page.waitForSelector('[data-testid="card-lockdown"]')
  const links = await page.$$eval('[data-testid^="card-"]', (cards) => cards.map((card) => card.getAttribute('href')))
  assert.deepEqual(links, ['https://dscpln.example/', 'https://watxt.example/', 'https://fl0w.example/', '/lockdown'])
  assert.equal(await page.title(), 'DA5H')
  assert.match(await page.textContent('h1'), /DA5H/)
  await page.waitForFunction(() => document.querySelector('[data-testid="theme-toggle"]')?.innerHTML?.includes('<svg'))
  assert.deepEqual(errors, [])
})

test('DA5H serves the Lockdown module and its API', async (t) => {
  const { base } = await fixture(t)
  const pageResponse = await fetch(`${base}/lockdown`)
  assert.equal(pageResponse.status, 200)
  assert.match(await pageResponse.text(), /<div id="app"><\/div>/)

  const status = await (await fetch(`${base}/lockdown/api/status`)).json()
  assert.equal(status.presets.length, 1)
  assert.equal(status.presets[0].id, 'public-web')
})

test('DA5H proxies configured service reads and forwards the identity', async (t) => {
  const seen = []
  const upstream = http.createServer((req, res) => {
    seen.push({ method: req.method, path: req.url, headers: req.headers })
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/secret' }).end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, path: req.url, user: req.headers['remote-user'] ?? null }))
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  t.after(() => new Promise((resolve) => upstream.close(resolve)))
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/`

  const { base } = await fixture(t)
  await putConfig(base, {
    functions: [{ path: 'demo', url: upstreamUrl, icon: 'boxes', name: 'Demo', description: 'Demo', kind: 'scheduled' }],
  })
  const proxied = await fetch(`${base}/api/services/demo/api/health`, {
    headers: { 'Remote-User': 'imranr', Cookie: 'session=secret' },
  })
  assert.equal(proxied.status, 200)
  assert.deepEqual(await proxied.json(), { ok: true, path: '/api/health', user: 'imranr' })
  assert.equal(seen.at(-1).headers.cookie, undefined)

  const unknown = await fetch(`${base}/api/services/missing/api/health`)
  assert.equal(unknown.status, 404)

  const write = await fetch(`${base}/api/services/demo/api/config`, { method: 'POST', body: '{}' })
  assert.equal(write.status, 405)
  assert.equal(seen.length, 1)

  for (const bad of ['%2e%2e%2fsecret', '..%2fsecret', '%5csecret']) {
    const response = await fetch(`${base}/api/services/demo/${bad}`)
    assert.equal(response.status, 400, bad)
  }

  // Redirects are surfaced, never followed by the proxy.
  const redirect = await fetch(`${base}/api/services/demo/redirect`, { redirect: 'manual' })
  assert.equal(redirect.status, 302)
  assert.equal(seen.at(-1).path, '/redirect')
})
