/**
 * dsh-login — integration test: the gate + register/login flows against a
 * real MySQL database, with a minimal fake of the DSH host context.
 *
 * Run:  node --test test/gate.test.mjs
 *
 * The fake server mimics just enough of WebServer (route table, prefix
 * matching, index + /api routes) to exercise the gate the way the real
 * dsh web process would. The inner browser-session secret is a random 32
 * byte value served by a fake credentials provider; a separate check
 * (test/inner-real.spec.mjs) verifies byte-compatibility with the RUNNING
 * dsh web instance using its real stored secret.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { loginPage } from '../lib/page.js'
import {
  COOKIE_NAME,
  LoginLimiter,
  SessionStore,
  hashPassword,
  verifyPassword,
} from '../lib/auth.js'
import { isIpv4, ipv4InCidrs, normalizePeerIp, parseCidrList } from '../lib/cidr.js'
import {
  decodeInnerPayload,
  innerCookieHeader,
  innerCookieName,
  mintHandoffToken,
  mintInnerCookie,
  verifyInnerCookie,
} from '../lib/inner.js'
import { normalizeConfig } from '../lib/config.js'

// DB-backed tests need a MySQL instance you own. Point the suite at it via
// environment variables (the defaults are placeholders; DB tests fail fast
// with a connection error until you set them):
//   DSH_LOGIN_TEST_DB_HOST / _PORT / _USER / _PASSWORD / _DATABASE / _TABLE
const DB_CONFIG = {
  host: process.env.DSH_LOGIN_TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DSH_LOGIN_TEST_DB_PORT ?? '3306'),
  user: process.env.DSH_LOGIN_TEST_DB_USER ?? 'dsh_test',
  password: process.env.DSH_LOGIN_TEST_DB_PASSWORD ?? 'dsh_test_password',
  database: process.env.DSH_LOGIN_TEST_DB_DATABASE ?? 'dsh_login_test',
  table: process.env.DSH_LOGIN_TEST_DB_TABLE ?? 'dsh_login',
}

function b64url(buf) {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/** A stand-in for the dsh web server + host context. */
class FakeWeb {
  constructor() {
    this.routes = []
    this.indexInjectHandlers = []
    this.server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      const route = this.match(pathname)
      if (route === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('fake: not found\n')
        return
      }
      route.handler(req, res)
    })
    const innerSecret = randomBytes(32)
    this.innerSecret = innerSecret
    const ctx = {
      webServer: {
        server: this.server,
        register: (route) => { this.routes.push(route); return () => { this.routes = this.routes.filter(r => r !== route) } },
        registerFallback: () => () => {},
        registerUpgrade: () => () => {},
        tapIndex: () => () => {},
        prefixes: new Map(),
      },
      credentials: {
        readRecord: async (key) => {
          if (key !== 'client-connection/browser-session') return undefined
          return { kind: 'grant', payload: { version: 1, secret: b64url(innerSecret) } }
        },
      },
      // Mirrors the real host: hands the caller the target service's ctx,
      // which supports event listening (webserver/index-inject).
      inject: (services, cb) => {
        const svcCtx = {
          on: (event, handler) => {
            if (event === 'webserver/index-inject') this.indexInjectHandlers.push(handler)
          },
        }
        cb(svcCtx)
      },
      logger: { warn: () => {}, error: () => {} },
      effect: (fn) => {
        const disposer = fn()
        if (typeof disposer === 'function') this.disposers.push(disposer)
      },
    }
    ctx.webServer.register({
      kind: 'exact',
      path: '/',
      handler: (req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('index-ok')
      },
    })
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api',
      handler: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true,"api":"fake"}\n')
      },
    })
    this.ctx = ctx
    this.disposers = []
  }

  match(pathname) {
    const exact = this.routes.find(r => r.kind === 'exact' && r.path === pathname)
    if (exact) return exact
    let best
    for (const route of this.routes) {
      if (route.kind !== 'prefix') continue
      if (pathname !== route.path && !pathname.startsWith(`${route.path}/`)) continue
      if (best === undefined || route.path.length > best.path.length) best = route
    }
    return best
  }

  async listen() {
    await new Promise((resolve) => { this.server.listen(0, '127.0.0.1', resolve) })
    this.port = this.server.address().port
    this.baseUrl = `http://127.0.0.1:${String(this.port)}`
    return this
  }

  dispose() {
    for (const d of this.disposers.splice(0)) d()
    return new Promise((resolve) => this.server.close(() => resolve()))
  }

  cookie(res, name) {
    const all = res.headers.getSetCookie?.() ?? []
    const hit = all.find((c) => c.startsWith(`${name}=`))
    return hit === undefined ? undefined : hit.split(';')[0].slice(name.length + 1)
  }

  innerCookie(res) {
    const all = res.headers.getSetCookie?.() ?? []
    return all.find((c) => c.startsWith('dsh-auth-'))?.split(';')[0]
  }

  /** Collect rows from all webserver/index-inject subscribers. */
  collectIndexInjections() {
    const table = []
    for (const handler of this.indexInjectHandlers) handler(table)
    return table
  }
}

/** fetch without redirect following, so tests can assert 302 + Set-Cookie. */
function fetchManual(url, init = {}) {
  return fetch(url, { ...init, redirect: 'manual' })
}

async function startGate(tmpHome, db = DB_CONFIG, extra = {}) {
  mkdirSync(tmpHome, { recursive: true })
  const config = normalizeConfig({ db, allowCidrs: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'], ...extra })
  const { saveConfig } = await import('../lib/config.js')
  saveConfig(tmpHome, config)
  process.env.DSH_HOME = tmpHome
  const { apply } = await import('../index.js')
  const fake = await new FakeWeb().listen()
  apply(fake.ctx)
  return fake
}

describe('dsh-login primitives', () => {
  it('scrypt hash/verify roundtrip and rejection', () => {
    const h = hashPassword('correct-horse-battery')
    assert.match(h, /^scrypt\$16384\$8\$1\$/u)
    assert.equal(verifyPassword('correct-horse-battery', h), true)
    assert.equal(verifyPassword('correct-horse-batter', h), false)
    assert.equal(verifyPassword('x', 'not-a-verifier'), false)
    assert.throws(() => hashPassword('short'))
  })

  it('cidr + peer helpers behave', () => {
    const cidrs = parseCidrList(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'])
    assert.equal(ipv4InCidrs('172.16.50.75', cidrs), true)
    assert.equal(ipv4InCidrs('10.255.0.1', cidrs), true)
    assert.equal(ipv4InCidrs('192.168.9.9', cidrs), true)
    assert.equal(ipv4InCidrs('8.8.8.8', cidrs), false)
    assert.equal(ipv4InCidrs('::1', cidrs), false)
    assert.equal(isIpv4('172.16.50.75'), true)
    assert.equal(normalizePeerIp('::1').kind, 'loopback6')
    assert.equal(normalizePeerIp('127.0.0.1').kind, 'loopback4')
    assert.equal(normalizePeerIp('::ffff:172.16.50.75').kind, 'v4')
    assert.equal(normalizePeerIp(''), undefined)
  })

  it('a new instance starts empty: only the shared signing secret, no inherited models', async () => {
    const { renderInstanceCredentials, INSTANCE_SETTINGS_TEMPLATE } = await import('../lib/instances.js')
    const { parse } = await import('yaml')
    const secret = randomBytes(32)
    const doc = parse(renderInstanceCredentials(secret))
    assert.equal(doc.version, 1)
    assert.deepEqual(
      Object.keys(doc.records),
      ['client-connection/browser-session'],
      'only the browser-session signing record may be shared with the hub',
    )
    const record = doc.records['client-connection/browser-session']
    assert.equal(record.kind, 'grant')
    assert.equal(record.payload.version, 1)
    const expected = secret.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
    assert.equal(record.payload.secret, expected, 'the hub secret must round-trip byte-for-byte')
    assert.deepEqual(doc.refs ?? {}, {}, 'no API keys are inherited: every user brings their own')
    assert.deepEqual(
      parse(INSTANCE_SETTINGS_TEMPLATE),
      { 'llm-deepseek': { models: [] } },
      'a new instance owns no provider and hides the built-in DeepSeek catalog',
    )
  })

  it('model config: validation and the exact write ops sent to a user instance', async () => {
    const { applyModelConfig, providerRefName, providerSettingsValue, summarizeModelConfig, validateModelConfig } =
      await import('../lib/model-config.js')
    assert.equal(providerRefName('my-gw'), 'MY_GW_API_KEY')
    for (const bad of [
      { providerId: 'Bad_ID', baseURL: 'http://x', modelId: 'm' },
      { providerId: 'ok', baseURL: 'ftp://x', modelId: 'm' },
      { providerId: 'ok', baseURL: 'http://x', modelId: '' },
      { providerId: 'ok', baseURL: 'http://x', modelId: 'm', apiKey: 'a\nb' },
    ]) {
      assert.equal(validateModelConfig(bad).ok, false, `${JSON.stringify(bad)} must be rejected`)
    }
    const parsed = validateModelConfig({
      providerId: 'my-gw', baseURL: 'http://10.0.0.17:8000/v1', modelId: 'm1', apiKey: 'sk-x', setDefault: 'true',
    })
    assert.equal(parsed.ok, true)
    assert.equal(parsed.value.api, 'openai-completions', 'api falls back to openai-completions')
    assert.deepEqual(providerSettingsValue(parsed.value), {
      apiKeyEnv: 'MY_GW_API_KEY',
      api: 'openai-completions',
      baseURL: 'http://10.0.0.17:8000/v1',
      models: [{ id: 'm1', name: 'm1' }],
    })
    const calls = []
    await applyModelConfig((method, args) => { calls.push([method, args]); return Promise.resolve(undefined) }, parsed.value)
    assert.deepEqual(calls.map(([method]) => method), ['settings/mutate', 'settings/mutate', 'credentials/set'])
    assert.equal(calls[0][1].ns, 'llm-pi-ai')
    assert.deepEqual(calls[0][1].ops, [
      { op: 'set', path: ['providers', 'my-gw'], value: providerSettingsValue(parsed.value) },
    ])
    assert.equal(calls[1][1].ns, 'agent-default-model')
    assert.deepEqual(calls[1][1].ops, [
      { op: 'set', path: ['provider'], value: 'my-gw' },
      { op: 'set', path: ['model'], value: 'm1' },
      // Regression: a leftover effort from the previous default must be cleared,
      // or the run fails with UNSUPPORTED_REASONING_EFFORT on routes without it.
      { op: 'unset', path: ['reasoningEffort'] },
    ])
    assert.deepEqual(calls[2][1], { ref: 'MY_GW_API_KEY', value: 'sk-x' })
    // Without setDefault and without a key, only the provider write is issued.
    const minimal = validateModelConfig({ providerId: 'p1', baseURL: 'http://x/v1', modelId: 'm' })
    const calls2 = []
    await applyModelConfig((method, args) => { calls2.push([method, args]); return Promise.resolve(undefined) }, minimal.value)
    assert.deepEqual(calls2.map(([method]) => method), ['settings/mutate'])
    assert.deepEqual(summarizeModelConfig({ namespaces: [
      { ns: 'llm-pi-ai', value: { providers: { a: { models: [{ id: 'm' }] } } } },
      { ns: 'agent-default-model', value: { provider: 'a', model: 'm' } },
    ] }), {
      providers: [{ id: 'a', api: '', baseURL: '', apiKeyEnv: '', models: ['m'] }],
      defaultModel: { provider: 'a', model: 'm' },
    })
  })

  it('admin model page: form renders, user list links to it, username is escaped', async () => {
    const { renderUserModelsPage, renderUsersPage } = await import('../lib/account-page.js')
    const page = renderUserModelsPage({
      user: 'tty',
      port: 3100,
      running: true,
      providers: [{ id: 'my-gw', api: 'openai-completions', baseURL: 'http://h/v1', apiKeyEnv: 'MY_GW_API_KEY', models: ['m1'] }],
      defaultModel: { provider: 'my-gw', model: 'm1' },
    })
    assert.match(page, /action="\/dsh-login\/users\/models\?user=tty"/u)
    assert.match(page, /name="providerId"/u)
    assert.match(page, /name="apiKey"/u)
    assert.match(page, /my-gw/u)
    const users = renderUsersPage({
      users: [{ username: 'tty', admin: false, port: 3100, running: true }],
      self: 'admin',
      instanceHost: '127.0.0.1',
    })
    assert.match(users, /\/dsh-login\/users\/models\?user=tty/u, 'the console must link to the model page')
    const evil = renderUserModelsPage({ user: '"><script>alert(1)</script>', port: 0, running: false, providers: [] })
    assert.ok(!evil.includes('<script>alert(1)</script>'), 'the target username must be escaped')
    // A failed save must not throw away what the administrator typed.
    const echoed = renderUserModelsPage({
      user: 'tty',
      port: 0,
      running: false,
      providers: [],
      error: '写入失败：示例',
      form: {
        providerId: 'qwen38-27b',
        baseURL: 'http://10.0.0.17:8000/v1',
        modelId: 'm1',
        modelName: 'Qwen',
        apiKey: 'sk-secret-value',
        setDefault: 'true',
      },
    })
    assert.match(echoed, /value="qwen38-27b"/u, 'provider id must be echoed')
    assert.match(echoed, /value="http:\/\/172\.19\.1\.175:8000\/v1"/u, 'baseURL must be echoed')
    assert.match(echoed, /value="m1"/u, 'model id must be echoed')
    assert.match(echoed, /value="true" checked/u, 'the default checkbox stays ticked')
    assert.ok(!echoed.includes('sk-secret-value'), 'the API key must never be echoed back')
  })

  it('admin model POST takes the target from the body and writes through the instance API', async () => {
    // Regression: the form posts to the bare path, so a handler that only read
    // `?user=` from the query answered "用户名格式不正确" on every save.
    const modelHome = await mkdtemp(join(tmpdir(), 'dsh-login-models-'))
    const modelRoot = await mkdtemp(join(tmpdir(), 'dsh-login-modelsroot-'))
    const adminName = `dsh-itest-adm-${Date.now().toString(36)}`
    const target = `dsh-itest-mdl-${Date.now().toString(36)}`
    const calls = []
    const inst = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      const reply = (payload) => {
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
        res.end(JSON.stringify(payload))
      }
      if (path === '/dsh-login/health') {
        reply({ ok: true, instance: true })
        return
      }
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        calls.push([path, body?.method, body?.payload?.args])
        reply({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {} } })
      })
    })
    await new Promise((resolve) => inst.listen(0, '127.0.0.1', resolve))
    inst.unref()
    const instPort = inst.address().port
    mkdirSync(join(modelRoot, target), { recursive: true })
    await writeFile(
      join(modelRoot, target, 'instance.json'),
      JSON.stringify({ port: instPort, pid: 1, startedAt: 1, provisionedAt: 1 }),
    )
    const { LoginDatabase } = await import('../lib/db.js')
    const db = new LoginDatabase(DB_CONFIG)
    await db.ensureTable()
    await db.register(adminName, hashPassword('Passw0rd-123'))
    await db.register(target, hashPassword('Passw0rd-123'))
    const gate = await startGate(modelHome, DB_CONFIG, {
      adminUsers: [adminName],
      instances: { root: modelRoot, portBase: instPort },
    })
    try {
      const login = await fetchManual(`${gate.baseUrl}/dsh-login/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: adminName, password: 'Passw0rd-123' }),
      })
      assert.equal(login.status, 302, 'the test admin must be able to log in')
      const session = gate.cookie(login, COOKIE_NAME)
      assert.ok(session, 'an admin session cookie must be issued')
      const res = await fetchManual(`${gate.baseUrl}/dsh-login/users/models`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `${COOKIE_NAME}=${session}`,
          origin: gate.baseUrl,
        },
        body: JSON.stringify({
          user: target,
          providerId: 'my-gw',
          baseURL: 'http://10.0.0.17:8000/v1',
          modelId: 'm1',
          apiKey: 'sk-x',
          setDefault: 'true',
        }),
      })
      assert.equal(res.status, 303, 'the body target must be accepted (no username-format error)')
      assert.match(res.headers.get('location') ?? '', new RegExp(`/dsh-login/users/models\\?user=${target}`, 'u'))
      assert.deepEqual(calls.map(([path, method]) => [path, method]), [
        ['/api/settings/mutate', 'settings/mutate'],
        ['/api/settings/mutate', 'settings/mutate'],
        ['/api/credentials/set', 'credentials/set'],
      ])
      assert.equal(calls[0][2].ns, 'llm-pi-ai')
      assert.deepEqual(calls[2][2], { ref: 'MY_GW_API_KEY', value: 'sk-x' })
    } finally {
      inst.closeAllConnections?.()
      inst.unref?.()
      await new Promise((resolve) => { inst.close(resolve) })
      await gate.dispose()
      try {
        await db.remove(adminName)
        await db.remove(target)
      } finally {
        db.close()
      }
      await rm(modelHome, { recursive: true, force: true })
      await rm(modelRoot, { recursive: true, force: true })
    }
  })

  it('a busy port is skipped, and probeHealth reports the serving home identity', async () => {
    const { InstanceManager } = await import('../lib/instances.js')
    const root = await mkdtemp(join(tmpdir(), 'dsh-login-ports-'))
    const busy = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      res.end(path === '/dsh-login/health' ? JSON.stringify({ ok: true, instance: true, identity: 'abc123' }) : '{}')
    })
    await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve))
    busy.unref()
    const busyPort = busy.address().port
    const mgr = new InstanceManager({
      root,
      portBase: busyPort,
      checkout: '/deepseek-harness',
      hubHome: root,
      hubPort: 0,
      hubBase: '',
      allowCidrs: [],
      rejectProxyHeaders: false,
      logger: { warn: () => {}, error: () => {} },
    })
    try {
      assert.equal(
        await mgr.identityOf(root),
        await mgr.identityOf(`${root}/`),
        'identity must ignore a trailing separator',
      )
      assert.notEqual(await mgr.identityOf(root), await mgr.identityOf(join(root, 'other')))
      assert.deepEqual(await mgr.probeHealth(busyPort), { ok: true, identity: 'abc123' })
      assert.equal(await mgr.portBusy(busyPort), true)
      // Regression: this port is held by a stale instance; handing it to a new
      // instance would make that one die with EADDRINUSE.
      const port = await mgr.allocatePort()
      assert.ok(port > busyPort, `allocated ${String(port)} must skip the busy ${String(busyPort)}`)
      assert.equal(await mgr.portBusy(port), false, 'the allocated port must really be free')
    } finally {
      busy.closeAllConnections?.()
      busy.unref?.()
      await new Promise((resolve) => { busy.close(resolve) })
      await rm(root, { recursive: true, force: true })
    }
  })

  it('session store persists hashed tokens across instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-login-sess-'))
    try {
      const path = join(root, 'sessions.json')
      const store = new SessionStore({ ttlSec: 3600, persistPath: path })
      const token = store.issue('alice')
      assert.equal(store.get(token)?.user, 'alice')
      const reloaded = new SessionStore({ ttlSec: 3600, persistPath: path })
      assert.equal(reloaded.get(token)?.user, 'alice')
      assert.equal(reloaded.get('bogus-token-000000000000'), undefined)
      const raw = await import('node:fs/promises').then(m => m.readFile(path, 'utf8'))
      assert.ok(!raw.includes(token), 'raw token must not be persisted')
      store.drop(token)
      assert.equal(store.get(token), undefined)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('login limiter allows then blocks', () => {
    const limiter = new LoginLimiter({ windowMs: 60_000, maxFails: 3 })
    const ip = '1.2.3.4'
    assert.equal(limiter.allow(ip), true)
    limiter.fail(ip)
    limiter.fail(ip)
    limiter.fail(ip)
    assert.equal(limiter.allow(ip), false)
    limiter.succeed(ip)
    assert.equal(limiter.allow(ip), true)
  })

  it('inner cookie mint/verify roundtrip and audience binding', () => {
    const secret = randomBytes(32)
    const minted = mintInnerCookie(secret, '127.0.0.1:3080', 30)
    const header = innerCookieHeader(minted)
    assert.match(header, /^dsh-auth-[A-Za-z0-9_-]+=v1\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+; Max-Age=2592000; Path=\/; Expires=.+; HttpOnly; SameSite=Strict$/u)
    const value = minted.value
    assert.equal(verifyInnerCookie(value, secret, '127.0.0.1:3080'), true)
    assert.equal(verifyInnerCookie(value, secret, '10.0.0.50:3080'), false, 'wrong authority must fail')
    assert.equal(verifyInnerCookie(value, randomBytes(32), '127.0.0.1:3080'), false, 'wrong secret must fail')
    assert.equal(verifyInnerCookie(`v1.${'a'.repeat(20)}.${'b'.repeat(43)}`, secret, '127.0.0.1:3080'), false)
    assert.equal(innerCookieName('127.0.0.1:3080'), minted.name)
  })

  it('login page renders safely (no raw next injection)', () => {
    const page = loginPage({ next: '/', registerOpen: true })
    assert.match(page, /dsh_db_sess|form-login/u)
    assert.match(page, /DeepSeek Harness/u)
    // The submit flow must read the 302 itself (the handoff crosses to another
    // port/origin, where a followed fetch response is unreadable) and open a
    // cross-origin target in a NEW WINDOW, keeping the hub tab.
    assert.match(page, /x-dsh-login-json/u)
    assert.match(page, /openPlaceholder/u)
    assert.match(page, /pop\.location\.href = loc/u)
    assert.doesNotMatch(page, /redirect:\s*'manual'/u, 'manual redirects are opaque; never rely on them')
    const evil = loginPage({ next: '"></script><script>alert(1)</script>' })
    assert.ok(!evil.includes('</script><script>'), 'next must be neutralized in the rendered page')
  })

  it('normalizeConfig enforces required fields', () => {
    assert.throws(() => normalizeConfig({ db: { host: 'h', user: '' } }), /db.host/u)
    assert.throws(() => normalizeConfig({ db: { host: 'h', user: 'u', database: 'd', table: 'bad name`x' } }), /db.table/u)
    const ok = normalizeConfig({ db: { host: 'h', user: 'u', password: 'p', database: 'd' } })
    assert.equal(ok.db.table, 'dsh_login')
    assert.equal(ok.register, 'open')
  })
})

describe('dsh-login tenancy primitives', () => {
  it('handoff token roundtrip, audience binding, and short lifetime', () => {
    const secret = randomBytes(32)
    const token = mintHandoffToken(secret, '10.0.0.50:3100', 600)
    assert.match(token.value, /^v1\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+$/u)
    assert.equal(token.maxAgeSec, 600)
    // A handoff token is just a short-lived cookie: the inner gate accepts it.
    assert.equal(verifyInnerCookie(token.value, secret, '10.0.0.50:3100'), true)
    assert.equal(verifyInnerCookie(token.value, secret, '10.0.0.50:3101'), false, 'wrong port must fail')
    assert.equal(verifyInnerCookie(token.value, secret, '127.0.0.1:3100'), false, 'wrong host must fail')
    assert.equal(verifyInnerCookie(token.value, randomBytes(32), '10.0.0.50:3100'), false)
    const payload = decodeInnerPayload(token.value)
    assert.equal(payload.authority, '10.0.0.50:3100')
    assert.ok(payload.expiresAt - payload.issuedAt <= 600 * 1000 + 1000, 'handoff must be short-lived')
    assert.equal(decodeInnerPayload('garbage'), undefined)
  })

  it('hub config: adminUsers validation and instances defaults', () => {
    const cfg = normalizeConfig({
      db: { host: 'h', user: 'u', password: 'p', database: 'd' },
      adminUsers: ['admin', '研发-01'],
    })
    assert.equal(cfg.mode, 'hub')
    assert.deepEqual(cfg.adminUsers, ['admin', '研发-01'])
    assert.equal(cfg.requireApproval, true, 'new registrations need approval by default')
    assert.equal(
      normalizeConfig({
        db: { host: 'h', user: 'u', password: 'p', database: 'd' },
        requireApproval: false,
      }).requireApproval,
      false,
      'approval can be switched off explicitly',
    )
    assert.throws(() => normalizeConfig({
      db: { host: 'h', user: 'u', password: 'p', database: 'd' },
      requireApproval: 'nope',
    }), /requireApproval/u)
    assert.equal(cfg.instances.root, '/root/dsh-users')
    assert.equal(cfg.instances.portBase, 3100)
    assert.equal(cfg.instances.hubBase, '')
    assert.throws(() => normalizeConfig({
      db: { host: 'h', user: 'u', password: 'p', database: 'd' },
      adminUsers: ['x'],
    }), /adminUsers/u, 'single-char admin name must be rejected')
    assert.throws(() => normalizeConfig({
      db: { host: 'h', user: 'u', password: 'p', database: 'd' },
      adminUsers: ['a/b'],
    }), /adminUsers/u, 'path-separator admin name must be rejected')
    const explicit = normalizeConfig({
      db: { host: 'h', user: 'u', password: 'p', database: 'd' },
      instances: { root: '/data/users', portBase: 4000, hubBase: 'http://10.0.0.50:3080' },
    })
    assert.equal(explicit.instances.root, '/data/users')
    assert.equal(explicit.instances.portBase, 4000)
    assert.equal(explicit.instances.hubBase, 'http://10.0.0.50:3080/')
  })

  it('instance config: normalization, defaults, and saveConfig roundtrip', async () => {
    const cfg = normalizeConfig({ instance: true, hubBase: 'http://10.0.0.50:3080' })
    assert.equal(cfg.mode, 'instance')
    assert.equal(cfg.handoffTtlSec, 600)
    assert.deepEqual(cfg.allowCidrs, ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'])
    assert.equal(cfg.rejectProxyHeaders, true)
    assert.throws(() => normalizeConfig({ instance: true }), /hubBase/u)
    assert.throws(() => normalizeConfig({ instance: true, hubBase: 'ftp://x' }), /http or https/u)
    assert.throws(() => normalizeConfig({ instance: 'yes', hubBase: 'http://x' }), /instance/u)
    // A normalized instance config must re-normalize (saveConfig roundtrip).
    assert.equal(normalizeConfig(cfg).mode, 'instance')
    // A normalized hub config must re-normalize too.
    const hub = normalizeConfig({ db: { host: 'h', user: 'u', password: 'p', database: 'd' } })
    assert.equal(normalizeConfig(hub).mode, 'hub')
  })
})

describe('dsh-login gate end-to-end (real MySQL)', () => {
  let fake
  let home
  const username = `dsh-itest-${Date.now().toString(36)}`
  const password = 'itest-123456789'

  before(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-login-home-'))
    // The test user is an admin so these e2e checks exercise the (unchanged)
    // hub-app path; regular-user handoff is covered by the 3999 rehearsal.
    fake = await startGate(home, DB_CONFIG, { adminUsers: [username] })
    // Warm the table (the real dsh-login startup does the same lazily).
    await new Promise((resolve) => setTimeout(resolve, 300))
  })

  after(async () => {
    const { LoginDatabase } = await import('../lib/db.js')
    const db = new LoginDatabase(DB_CONFIG)
    try {
      await db.remove(username)
    } finally {
      db.close()
    }
    if (fake) await fake.dispose()
    if (home) await rm(home, { recursive: true, force: true })
  })

  it('unauthenticated GET is redirected to the login page', async () => {
    const res = await fetchManual(`${fake.baseUrl}/`)
    assert.equal(res.status, 302)
    assert.match(res.headers.get('location'), /^\/dsh-login\/login/u)
    const api = await fetch(`${fake.baseUrl}/api/ping`, { method: 'POST' })
    assert.equal(api.status, 401)
    assert.match(await api.text(), /unauthorized/u)
  })

  it('login page renders and reports state', async () => {
    const res = await fetch(`${fake.baseUrl}/dsh-login/login`)
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.match(body, /<form id="form-login"/u)
    assert.match(body, /<form id="form-register"/u)
    const state = await (await fetch(`${fake.baseUrl}/dsh-login/state`)).json()
    assert.equal(state.authenticated, false)
    assert.equal(state.db, 'up')
    assert.equal(state.register, 'open')
    const health = await (await fetch(`${fake.baseUrl}/dsh-login/health`)).json()
    assert.equal(health.db, 'up')
  })

  it('rejects proxy-forwarded requests', async () => {
    const res = await fetch(`${fake.baseUrl}/`, { headers: { 'x-forwarded-for': '8.8.8.8' } })
    assert.equal(res.status, 403)
  })

  it('registers a new user into dsh_login and auto-logs-in', async () => {
    const res = await fetchManual(`${fake.baseUrl}/dsh-login/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, password2: password }),
    })
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('location'), '/')
    const session = fake.cookie(res, COOKIE_NAME)
    assert.ok(session, 'gate session cookie must be set')
    const inner = fake.innerCookie(res)
    assert.ok(inner, 'inner dsh-auth cookie must be set')
    assert.equal(verifyInnerCookie(inner.split('=').slice(1).join('='), fake.innerSecret, `127.0.0.1:${String(fake.port)}`), true)
    // The row is really in the database:
    const { LoginDatabase } = await import('../lib/db.js')
    const db = new LoginDatabase(DB_CONFIG)
    try {
      const row = await db.findByUsername(username)
      assert.ok(row)
      assert.match(row.password_hash, /^scrypt\$/u)
    } finally {
      db.close()
    }
  })

  it('gate session passes the gate; inner cookie bridges on demand', async () => {
    const res = await fetch(`${fake.baseUrl}/dsh-login/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, password2: password }),
    })
    // Duplicate registration is 409...
    assert.equal(res.status, 409)
    const login = await fetchManual(`${fake.baseUrl}/dsh-login/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, next: '/api/ping' }),
    })
    assert.equal(login.status, 302)
    assert.equal(login.headers.get('location'), '/api/ping')
    const session = fake.cookie(login, COOKIE_NAME)
    const api = await fetch(`${fake.baseUrl}/api/ping`, { method: 'POST', headers: { cookie: `${COOKIE_NAME}=${session}` } })
    assert.equal(api.status, 200)
    const bridged = fake.innerCookie(api)
    assert.ok(bridged, 'bridge must attach the inner cookie to session-valid responses')
  })

  it('rejects wrong password and validates input', async () => {
    const bad = await fetch(`${fake.baseUrl}/dsh-login/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'wrong-pass-999' }),
    })
    assert.equal(bad.status, 401)
    assert.equal((await bad.json()).error, '用户名或密码错误')
    const shortUser = await fetch(`${fake.baseUrl}/dsh-login/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'a', password: '0123456789' }),
    })
    assert.equal(shortUser.status, 400)
    const mismatch = await fetch(`${fake.baseUrl}/dsh-login/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: `dsh-itest-x${Date.now()}`, password: '0123456789', password2: '01234567890' }),
    })
    assert.equal(mismatch.status, 400)
    assert.equal((await mismatch.json()).error, '两次输入的密码不一致')
  })

  it('login with correct credentials issues both cookies', async () => {
    const res = await fetchManual(`${fake.baseUrl}/dsh-login/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    assert.equal(res.status, 302)
    assert.ok(fake.cookie(res, COOKIE_NAME))
    assert.ok(fake.innerCookie(res))
    const page = await fetch(`${fake.baseUrl}/`, { headers: { cookie: `${COOKIE_NAME}=${fake.cookie(res, COOKIE_NAME)}` } })
    assert.equal(page.status, 200)
    assert.equal(await page.text(), 'index-ok')
  })

  it('JSON login protocol returns the target explicitly (page JS path)', async () => {
    const res = await fetch(`${fake.baseUrl}/dsh-login/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-login-json': '1' },
      body: JSON.stringify({ username, password }),
    })
    // A JS caller cannot read a redirect's Location (a `redirect:'manual'`
    // response is opaque: status 0, no readable headers), so the login page
    // opts into this protocol and receives the target in the body instead.
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.target, '/')
    assert.ok(fake.cookie(res, COOKIE_NAME), 'session cookie is still issued')
    assert.ok(fake.innerCookie(res), 'admin still receives the inner cookie')
  })

  it('JSON login hands a regular user the instance target (no redirect to read)', async () => {
    const regHome = await mkdtemp(join(tmpdir(), 'dsh-login-reg-'))
    const regRoot = await mkdtemp(join(tmpdir(), 'dsh-login-regroot-'))
    const regular = `dsh-itest-reg-${Date.now().toString(36)}`
    // A stand-in instance answering the manager's /dsh-login/health probe, so
    // ensure() returns the recorded port instead of spawning a real child.
    const inst = createServer((_req, res) => {
      // `connection: close` stops the caller from pooling a keep-alive socket
      // that would hold the test process open after the run finishes.
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      res.end('{"ok":true,"instance":true}')
    })
    await new Promise((resolve) => inst.listen(0, '127.0.0.1', resolve))
    inst.unref()
    const instPort = inst.address().port
    mkdirSync(join(regRoot, regular), { recursive: true })
    await writeFile(
      join(regRoot, regular, 'instance.json'),
      JSON.stringify({ port: instPort, pid: 1, startedAt: 1, provisionedAt: 1 }),
    )
    const regFake = await startGate(regHome, DB_CONFIG, {
      adminUsers: ['not-this-user'],
      instances: { root: regRoot, portBase: instPort },
    })
    try {
      const db = new (await import('../lib/db.js')).LoginDatabase(DB_CONFIG)
      try {
        // 1) Registration no longer auto-logs-in: the account lands in the
        //    approval queue and no session cookie is issued.
        const res = await fetch(`${regFake.baseUrl}/dsh-login/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-login-json': '1' },
          body: JSON.stringify({ username: regular, password: 'Passw0rd-123' }),
        })
        assert.equal(res.status, 200, 'the JSON protocol must not answer with a redirect')
        const body = await res.json()
        assert.equal(body.ok, true)
        assert.equal(body.pending, true, 'a self-registered account must wait for approval')
        assert.equal(typeof body.message, 'string')
        assert.equal(regFake.cookie(res, COOKIE_NAME), undefined, 'no session may be issued yet')
        assert.equal((await db.findByUsername(regular))?.status, 'pending')

        // 2) Logging in while pending is refused with a clear message.
        const blocked = await fetch(`${regFake.baseUrl}/dsh-login/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-login-json': '1' },
          body: JSON.stringify({ username: regular, password: 'Passw0rd-123' }),
        })
        assert.equal(blocked.status, 403, 'a pending account must not be able to log in')
        assert.match((await blocked.json()).error, /等待管理员审批/u)

        // 3) After approval the same credentials log in and hand off normally.
        await db.setStatus(regular, 'approved')
        const login = await fetch(`${regFake.baseUrl}/dsh-login/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-login-json': '1' },
          body: JSON.stringify({ username: regular, password: 'Passw0rd-123' }),
        })
        assert.equal(login.status, 200)
        const granted = await login.json()
        assert.equal(granted.ok, true)
        assert.match(
          granted.target,
          new RegExp(`^http://127\\.0\\.0\\.1:${String(instPort)}/\\?handoff=`),
          'target must be the instance URL carrying a handoff token',
        )
        assert.ok(regFake.cookie(login, COOKIE_NAME), 'hub session cookie is issued after approval')

        // 4) A rejected account is refused as well.
        await db.setStatus(regular, 'rejected')
        const rejected = await fetch(`${regFake.baseUrl}/dsh-login/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-login-json': '1' },
          body: JSON.stringify({ username: regular, password: 'Passw0rd-123' }),
        })
        assert.equal(rejected.status, 403)
        assert.match((await rejected.json()).error, /未通过管理员审批/u)
      } finally {
        try { await db.remove(regular) } finally { db.close() }
      }
    } finally {
      inst.closeAllConnections?.()
      inst.unref?.()
      await new Promise((resolve) => { inst.close(resolve) })
      // Dispose the extra gate: it closes the fake web server AND runs the
      // plugin's effect disposers (its MySQL pool), so the run can exit.
      await regFake.dispose()
      const { LoginDatabase } = await import('../lib/db.js')
      const db = new LoginDatabase(DB_CONFIG)
      try { await db.remove(regular) } finally { db.close() }
      await rm(regHome, { recursive: true, force: true })
      await rm(regRoot, { recursive: true, force: true })
    }
  })

  it('logout clears the session', async () => {
    const login = await fetchManual(`${fake.baseUrl}/dsh-login/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const session = fake.cookie(login, COOKIE_NAME)
    const out = await fetchManual(`${fake.baseUrl}/dsh-login/logout`, { headers: { cookie: `${COOKIE_NAME}=${session}` } })
    assert.equal(out.status, 302)
    assert.equal(out.headers.get('location'), '/dsh-login/login')
    const cleared = out.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`))
    assert.match(cleared, /Max-Age=0/u)
    // Full logout: the inner browser cookies are cleared too, so a tab left open
    // on a user instance cannot stay logged in behind the operator's back.
    const clearedInner = out.headers.getSetCookie()
      .find((c) => c.startsWith(`${innerCookieName(`127.0.0.1:${String(fake.port)}`)}=`))
    assert.ok(clearedInner, 'the hub inner cookie must be cleared as well')
    assert.match(clearedInner, /Max-Age=0/u)
    const after = await fetchManual(`${fake.baseUrl}/`, { headers: { cookie: `${COOKIE_NAME}=${session}` } })
    assert.equal(after.status, 302, 'dropped session must no longer pass the gate')
  })

  it('admin approval route: guards, approve/reject, and the console column', async () => {
    const { LoginDatabase } = await import('../lib/db.js')
    const { renderUsersPage } = await import('../lib/account-page.js')
    const db = new LoginDatabase(DB_CONFIG)
    const target = `dsh-itest-appr-${Date.now().toString(36)}`
    await db.ensureTable()
    await db.register(target, hashPassword('Passw0rd-123'), 'pending')
    try {
      const post = (headers, body) => fetch(`${fake.baseUrl}/dsh-login/users/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
      // Anonymous callers are refused (admin routes answer JSON, not a redirect).
      assert.equal((await post({}, { user: target, action: 'approve' })).status, 401)
      const login = await fetchManual(`${fake.baseUrl}/dsh-login/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const cookie = `${COOKIE_NAME}=${fake.cookie(login, COOKIE_NAME)}`
      // Admin session with a foreign Origin is refused.
      assert.equal(
        (await post({ cookie, origin: 'http://evil.example' }, { user: target, action: 'approve' })).status,
        403,
      )
      // Unknown action is rejected.
      assert.equal(
        (await post({ cookie, origin: fake.baseUrl }, { user: target, action: 'explode' })).status,
        400,
      )
      const ok = await post({ cookie, origin: fake.baseUrl }, { user: target, action: 'approve' })
      assert.equal(ok.status, 200)
      assert.equal((await ok.json()).status, 'approved')
      assert.equal((await db.findByUsername(target))?.status, 'approved')
      const rej = await post({ cookie, origin: fake.baseUrl }, { user: target, action: 'reject' })
      assert.equal(rej.status, 200)
      assert.equal((await db.findByUsername(target))?.status, 'rejected')
      // The console renders the status column plus both approval buttons.
      const page = renderUsersPage({
        users: [{ username: target, admin: false, status: 'pending', port: 0, running: false }],
        self: username,
        instanceHost: '127.0.0.1',
      })
      assert.match(page, /待审批/u)
      assert.match(page, /data-status="approve"/u)
      assert.match(page, new RegExp(`data-status="reject" data-user="${target}"`, 'u'))
      assert.match(page, /等待审批/u)
    } finally {
      try { await db.remove(target) } finally { db.close() }
    }
  })

  it('answers 503 with a friendly error when the database is down', async () => {
    const downHome = await mkdtemp(join(tmpdir(), 'dsh-login-down-'))
    const downFake = await startGate(downHome, { ...DB_CONFIG, host: '127.0.0.1', port: 1 })
    try {
      const res = await fetch(`${downFake.baseUrl}/dsh-login/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      assert.equal(res.status, 503)
      assert.match((await res.json()).error, /数据库暂不可用/u)
      const state = await (await fetch(`${downFake.baseUrl}/dsh-login/state`)).json()
      assert.equal(state.db, 'down')
    } finally {
      await downFake.dispose()
      await rm(downHome, { recursive: true, force: true })
    }
  })
})

describe('dsh-login account & user management (real MySQL)', () => {
  let fake
  let home
  const admin = `dsh-amgm-${Date.now().toString(36)}`
  const password = 'amgm-123456789'
  let adminCookie

  before(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-login-mgm-'))
    // Point the instance tenancy at a temp root + nonexistent checkout so a
    // stray provisioning can never run (or spawn) from the unit suite.
    fake = await startGate(home, DB_CONFIG, {
      adminUsers: [admin],
      instances: {
        root: join(home, 'users'),
        portBase: 39400,
        checkout: join(home, 'no-such-checkout'),
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const res = await fetchManual(`${fake.baseUrl}/dsh-login/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: admin, password, password2: password }),
    })
    assert.equal(res.status, 302)
    adminCookie = fake.cookie(res, COOKIE_NAME)
    assert.ok(adminCookie)
  })

  after(async () => {
    const { LoginDatabase } = await import('../lib/db.js')
    const db = new LoginDatabase(DB_CONFIG)
    try {
      await db.remove(admin)
    } finally {
      db.close()
    }
    if (fake) await fake.dispose()
    if (home) await rm(home, { recursive: true, force: true })
  })

  const authHeaders = () => ({ cookie: `${COOKIE_NAME}=${adminCookie}` })

  it('index-inject: the floating account button rows are contributed', () => {
    const rows = fake.collectIndexInjections()
    assert.ok(rows.some((r) => r.kind === 'style' && r.text.includes('dsh-login-acct')))
    const htmlRow = rows.find((r) => r.kind === 'html' && r.placement === 'body')
    assert.ok(htmlRow !== undefined && htmlRow.html.includes('/dsh-login/account'))
  })

  it('account page: anonymous visitors bounce to the login page', async () => {
    const res = await fetchManual(`${fake.baseUrl}/dsh-login/account`)
    assert.equal(res.status, 302)
    assert.match(res.headers.get('location'), /^\/dsh-login\/login\?next=/u)
  })

  it('account page: an admin sees identity + the user-management entry', async () => {
    const res = await fetch(`${fake.baseUrl}/dsh-login/account`, { headers: authHeaders() })
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.ok(body.includes(admin))
    assert.ok(body.includes('用户管理'))
    assert.ok(body.includes('/dsh-login/logout'))
  })

  it('users page: anonymous bounces, admin lists the accounts', async () => {
    const anon = await fetchManual(`${fake.baseUrl}/dsh-login/users`)
    assert.equal(anon.status, 302)
    const res = await fetch(`${fake.baseUrl}/dsh-login/users`, { headers: authHeaders() })
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.ok(body.includes(admin))
    assert.ok(body.includes('实例端口'))
  })

  it('enter: guards (anonymous bounce, admin target 400, bad name 400)', async () => {
    const anon = await fetchManual(`${fake.baseUrl}/dsh-login/enter?user=${encodeURIComponent(admin)}`)
    assert.equal(anon.status, 302)
    const selfTarget = await fetch(`${fake.baseUrl}/dsh-login/enter?user=${encodeURIComponent(admin)}`, { headers: authHeaders() })
    assert.equal(selfTarget.status, 400)
    assert.match(await selfTarget.text(), /没有独立环境/u)
    const bad = await fetch(`${fake.baseUrl}/dsh-login/enter?user=x`, { headers: authHeaders() })
    assert.equal(bad.status, 400)
  })

  it('delete: self-delete blocked, unknown user 404, bad origin 403', async () => {
    const opts = (user) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${adminCookie}`, origin: fake.baseUrl },
      body: JSON.stringify({ user }),
    })
    const selfDel = await fetch(`${fake.baseUrl}/dsh-login/users/delete`, opts(admin))
    assert.equal(selfDel.status, 400)
    const missing = await fetch(`${fake.baseUrl}/dsh-login/users/delete`, opts(`dsh-nosuch-${Date.now().toString(36)}`))
    assert.equal(missing.status, 404)
    const badOrigin = await fetch(`${fake.baseUrl}/dsh-login/users/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${adminCookie}`, origin: 'http://evil.example' },
      body: JSON.stringify({ user: 'whatever-user' }),
    })
    assert.equal(badOrigin.status, 403)
  })

  it('delete: removes the DB row, the instance dir, and instance state', async () => {
    const victim = `dsh-victm-${Date.now().toString(36)}`
    const { LoginDatabase } = await import('../lib/db.js')
    const db = new LoginDatabase(DB_CONFIG)
    try {
      await db.ensureTable()
      await db.register(victim, hashPassword('victim-12345678'))
    } finally {
      db.close()
    }
    // Fabricate a provisioned instance dir (no real process behind it).
    const dir = join(home, 'users', victim)
    mkdirSync(dir, { recursive: true })
    await writeFile(join(dir, 'instance.json'), JSON.stringify({ port: 39400, pid: null, startedAt: 0, provisionedAt: Date.now() }))
    const res = await fetch(`${fake.baseUrl}/dsh-login/users/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${adminCookie}`, origin: fake.baseUrl },
      body: JSON.stringify({ user: victim }),
    })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })
    const db2 = new LoginDatabase(DB_CONFIG)
    try {
      assert.equal(await db2.findByUsername(victim), undefined)
    } finally {
      db2.close()
    }
    await assert.rejects(import('node:fs/promises').then((m) => m.access(dir)))
  })
})

describe('dsh-login instance-mode account page', () => {
  it('anonymous bounces to the hub login; inner-cookie users see port + logout', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-login-inst-'))
    try {
      const fake = await startGate(home, DB_CONFIG, {
        instance: true,
        hubBase: 'http://127.0.0.1:3999/',
        port: 39410,
      })
      await new Promise((resolve) => setTimeout(resolve, 200))
      const anon = await fetchManual(`${fake.baseUrl}/dsh-login/account`)
      assert.equal(anon.status, 302)
      assert.match(anon.headers.get('location'), /^http:\/\/127\.0\.0\.1:3999\/dsh-login\/login/u)
      // A built-in cookie for this authority passes the gate.
      const minted = mintInnerCookie(fake.innerSecret, `127.0.0.1:${String(fake.port)}`, 30)
      const cookiePart = innerCookieHeader(minted).split(';')[0]
      const res = await fetch(`${fake.baseUrl}/dsh-login/account`, { headers: { cookie: cookiePart } })
      assert.equal(res.status, 200)
      const body = await res.text()
      assert.ok(body.includes('独立环境'))
      assert.ok(body.includes('39410'))
      assert.ok(body.includes('/dsh-login/logout'))
      // Logging out of an instance chains to the hub logout: the hub session and
      // the instance cookie are separate sessions, and leaving the hub one alive
      // made the login page keep reporting "已登录" right after a logout.
      const out = await fetchManual(`${fake.baseUrl}/dsh-login/logout`, { headers: { cookie: cookiePart } })
      assert.equal(out.status, 302)
      assert.equal(
        out.headers.get('location'),
        'http://127.0.0.1:3999/dsh-login/logout',
        'instance logout must chain to the hub logout',
      )
      const clearedInstance = out.headers.getSetCookie()
        .find((c) => c.startsWith(`${innerCookieName(`127.0.0.1:${String(fake.port)}`)}=`))
      assert.ok(clearedInstance, 'the instance cookie must be cleared')
      await fake.dispose()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

