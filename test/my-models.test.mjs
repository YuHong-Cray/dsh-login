/**
 * dsh-login — tests for the user self-service Models page
 * (`/dsh-login/models`, instance mode):
 *
 *   - unit: the preset table, key/model/id validation, the write-op builders,
 *     the apply sequences (mock rpc), and the page renderer (no key echo,
 *     escaping, account entry);
 *   - integration: the instance gate + the page's JSON actions against a fake
 *     host whose /api mimics the DSH settings/credentials/llm remotes. The
 *     fake server listens on the CONFIGURED port because the plugin's
 *     selfRpc talks to `127.0.0.1:<cfg.port>/api` (its own loopback).
 *
 * No MySQL is needed: instance mode has no database, and the fake /api is a
 * scriptable in-memory stand-in (gate.test.mjs covers the hub + DB flows).
 *
 * Run:  node --test test/my-models.test.mjs
 */
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  KNOWN_APIS, PROVIDER_PRESETS, listPresets, presetById,
} from '../lib/provider-presets.js'
import {
  apiKeyError,
  applyMyModelDelete,
  applyMyModels,
  isProviderId,
  parseModelIds,
  providerRefName,
  setDefaultOps,
  summarizeModelConfig,
  validateMyModels,
} from '../lib/model-config.js'
import { renderAccountPage, renderMyModelsPage } from '../lib/account-page.js'
import { innerCookieName, mintInnerCookie } from '../lib/inner.js'
import { normalizeConfig, saveConfig } from '../lib/config.js'

// ---------------------------------------------------------------------------
// unit: presets
// ---------------------------------------------------------------------------

describe('provider presets', () => {
  it('every preset is well-formed and unique', () => {
    const ids = new Set()
    for (const p of PROVIDER_PRESETS) {
      assert.ok(!ids.has(p.id), `duplicate preset id ${p.id}`)
      ids.add(p.id)
      assert.ok(typeof p.id === 'string' && isProviderId(p.id), `bad preset id ${String(p.id)}`)
      assert.ok(typeof p.name === 'string' && p.name !== '', `preset ${p.id} needs a name`)
      assert.ok(KNOWN_APIS.includes(p.api), `preset ${p.id} names unknown api ${p.api}`)
      assert.ok(/^https?:\/\/\S+$/.test(p.baseUrl), `preset ${p.id} needs an http(s) baseUrl`)
      assert.ok(typeof p.model === 'string' && p.model !== '', `preset ${p.id} needs a default model`)
      assert.equal(typeof p.common, 'boolean')
      if (p.keyUrl !== undefined) assert.ok(/^https?:\/\//.test(p.keyUrl))
    }
  })

  it('the common row and listPresets stay in step', () => {
    const all = listPresets()
    assert.equal(all.length, PROVIDER_PRESETS.length)
    assert.ok(all.filter((p) => p.common).length >= 4, 'the common row should offer the main companies')
    for (const p of all) assert.equal(presetById(p.id), p)
  })
})

// ---------------------------------------------------------------------------
// unit: validation helpers
// ---------------------------------------------------------------------------

describe('self-service validation helpers', () => {
  it('parseModelIds splits on commas, semicolons, CJK separators, and whitespace', () => {
    assert.deepEqual(parseModelIds('a, b\nc'), ['a', 'b', 'c'])
    assert.deepEqual(parseModelIds('a，b；c d'), ['a', 'b', 'c', 'd'])
    assert.deepEqual(parseModelIds('   '), [])
    assert.deepEqual(parseModelIds(''), [])
    assert.deepEqual(parseModelIds(undefined), [])
  })

  it('isProviderId enforces the 2-32 lowercase id rule', () => {
    assert.ok(isProviderId('ab'))
    assert.ok(isProviderId('a-b-c1'))
    assert.ok(isProviderId('ab-'), 'the plugin pattern (shared with the admin page) allows a trailing hyphen')
    assert.ok(!isProviderId('a'))
    assert.ok(!isProviderId('-ab'))
    assert.ok(!isProviderId('a_b'))
    assert.ok(!isProviderId('AB'))
    assert.ok(!isProviderId('a'.repeat(33)))
    assert.ok(!isProviderId(42))
  })

  it('providerRefName derives the conventional credential ref', () => {
    assert.equal(providerRefName('my-gw'), 'MY_GW_API_KEY')
    assert.equal(providerRefName('moonshotai-cn'), 'MOONSHOTAI_CN_API_KEY')
  })

  it('apiKeyError mirrors the DSH-native key rules', () => {
    assert.equal(apiKeyError('sk-abc123'), undefined)
    assert.equal(apiKeyError(' sk-abc123 '), undefined, 'outer whitespace is trimmed')
    assert.equal(apiKeyError(''), '请输入 API 密钥', 'required: blank')
    assert.equal(apiKeyError('   '), 'API 密钥不能只包含空白字符', 'whitespace only')
    assert.equal(apiKeyError('', false), undefined, 'optional: blank is fine')
    assert.match(apiKeyError('a b'), /格式错误/, 'inner space is not printable-ASCII-legal')
    assert.match(apiKeyError('"sk-abc"'), /格式错误/, 'quoted wrap')
    assert.match(apiKeyError("'sk-abc'"), /格式错误/, 'single-quoted wrap')
    assert.match(apiKeyError('FOO=bar'), /格式错误/, 'environment line')
    assert.equal(apiKeyError('a'.repeat(4097)), 'API 密钥过长')
  })

  it('setDefaultOps clears a stale reasoningEffort', () => {
    assert.deepEqual(setDefaultOps('p', 'm'), [
      { op: 'set', path: ['provider'], value: 'p' },
      { op: 'set', path: ['model'], value: 'm' },
      { op: 'unset', path: ['reasoningEffort'] },
    ])
  })
})

// ---------------------------------------------------------------------------
// unit: validateMyModels
// ---------------------------------------------------------------------------

describe('validateMyModels', () => {
  it('rejects a missing kind', () => {
    const out = validateMyModels({}, undefined)
    assert.equal(out.ok, false)
  })

  it('preset: key required, profile carries only the reference and the label', () => {
    const out = validateMyModels(
      { kind: 'preset', presetId: 'deepseek', apiKey: '  sk-ds-1 ' },
      undefined,
    )
    assert.equal(out.ok, true)
    assert.equal(out.value.providerId, 'deepseek')
    assert.deepEqual(out.value.profile, { apiKeyEnv: 'DEEPSEEK_API_KEY', displayName: 'DeepSeek' })
    assert.equal(out.value.apiKey, 'sk-ds-1')
    assert.equal(out.value.setDefault, undefined)
  })

  it('preset: unknown preset and blank key are refused', () => {
    assert.equal(validateMyModels({ kind: 'preset', presetId: 'nope', apiKey: 'k' }).ok, false)
    assert.equal(validateMyModels({ kind: 'preset', presetId: 'deepseek', apiKey: '' }).ok, false)
    assert.equal(validateMyModels({ kind: 'preset', presetId: 'deepseek', apiKey: '' }).error, '请输入 API 密钥')
  })

  it('preset: setDefault requires a chosen model and rides the value through', () => {
    const out = validateMyModels(
      { kind: 'preset', presetId: 'openai', apiKey: 'sk-1', setDefault: 'on', defaultModel: 'gpt-5.4-mini' },
      undefined,
    )
    assert.equal(out.ok, true)
    assert.deepEqual(out.value.setDefault, { provider: 'openai', model: 'gpt-5.4-mini' })
    const none = validateMyModels(
      { kind: 'preset', presetId: 'openai', apiKey: 'sk-1', setDefault: 'on' },
      undefined,
    )
    assert.equal(none.ok, false)
  })

  it('custom: a full valid form writes api/baseURL/models and the conventional ref', () => {
    const out = validateMyModels({
      kind: 'custom',
      providerId: 'my-gw',
      displayName: 'My GW',
      api: '',
      baseURL: 'https://gw.example/v1',
      models: 'm1, m2\nm3',
      apiKey: 'sk-abc',
    }, undefined)
    assert.equal(out.ok, true)
    assert.deepEqual(out.value.profile, {
      displayName: 'My GW',
      api: 'openai-completions',
      baseURL: 'https://gw.example/v1',
      models: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
      apiKeyEnv: 'MY_GW_API_KEY',
    })
    assert.equal(out.value.apiKey, 'sk-abc')
  })

  it('custom: every field rule is enforced', () => {
    const base = {
      kind: 'custom',
      providerId: 'my-gw',
      api: 'openai-completions',
      baseURL: 'https://gw.example/v1',
      models: 'm1',
      apiKey: 'sk-1',
    }
    assert.equal(validateMyModels({ ...base, providerId: 'My_Gw' }, undefined).ok, false)
    assert.equal(validateMyModels({ ...base, providerId: 'my-gw', api: 'carrier-pigeon' }, undefined).ok, false)
    assert.equal(validateMyModels({ ...base, baseURL: 'ftp://gw.example/v1' }, undefined).ok, false)
    assert.equal(validateMyModels({ ...base, models: '   ' }, undefined).ok, false)
    assert.equal(validateMyModels({ ...base, models: 'm1, m1' }, undefined).ok, false)
    assert.equal(validateMyModels({ ...base, apiKey: '"sk-1"' }, undefined).ok, false)
    assert.equal(
      validateMyModels({ ...base, setDefault: true, defaultModel: 'not-listed' }, undefined).ok,
      false,
      'the default must be one of the typed models',
    )
  })

  it('custom: a blank key keeps the existing reference, or names none for a new route', () => {
    const withExisting = validateMyModels({
      kind: 'custom', providerId: 'my-gw', baseURL: 'https://gw.example/v1', models: 'm1', apiKey: '',
    }, { id: 'my-gw', api: 'openai-completions', baseURL: 'https://old', apiKeyEnv: 'MY_GW_API_KEY', models: ['m0'] })
    assert.equal(withExisting.ok, true)
    assert.equal(withExisting.value.profile.apiKeyEnv, 'MY_GW_API_KEY')
    assert.equal(withExisting.value.apiKey, undefined)

    const fresh = validateMyModels({
      kind: 'custom', providerId: 'my-gw', baseURL: 'https://gw.example/v1', models: 'm1', apiKey: '',
    }, undefined)
    assert.equal(fresh.ok, true)
    assert.equal(fresh.value.profile.apiKeyEnv, undefined, 'a brand-new keyless route authenticates natively')
    assert.equal(fresh.value.apiKey, undefined)

    const nativeExisting = validateMyModels({
      kind: 'custom', providerId: 'my-gw', baseURL: 'https://gw.example/v1', models: 'm1', apiKey: '',
    }, { id: 'my-gw', api: 'openai-completions', baseURL: 'https://old', apiKeyEnv: '', models: ['m0'] })
    assert.equal(nativeExisting.value.profile.apiKeyEnv, undefined, 'a keyless route stays keyless')
  })
})

// ---------------------------------------------------------------------------
// unit: apply sequences (mock rpc)
// ---------------------------------------------------------------------------

function mockRpc(fail = {}) {
  const calls = []
  const rpc = async (method, args) => {
    calls.push({ method, args })
    if (fail[method] !== undefined) throw new Error(fail[method])
    return undefined
  }
  return { calls, rpc }
}

describe('applyMyModels / applyMyModelDelete sequences', () => {
  it('writes profile, then key, then default — and skips absent steps', async () => {
    const { calls, rpc } = mockRpc()
    await applyMyModels(rpc, {
      providerId: 'deepseek',
      displayName: 'DeepSeek',
      profile: { apiKeyEnv: 'DEEPSEEK_API_KEY', displayName: 'DeepSeek' },
      apiKey: 'sk-1',
      setDefault: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    })
    assert.deepEqual(calls.map((c) => c.method), ['settings/mutate', 'credentials/set', 'settings/mutate'])
    assert.deepEqual(calls[0].args, {
      ns: 'llm-pi-ai',
      ops: [{ op: 'set', path: ['providers', 'deepseek'], value: { apiKeyEnv: 'DEEPSEEK_API_KEY', displayName: 'DeepSeek' } }],
      expectedRevision: undefined,
    })
    assert.deepEqual(calls[1].args, { ref: 'DEEPSEEK_API_KEY', value: 'sk-1' })
    assert.equal(calls[2].args.ns, 'agent-default-model')
    assert.deepEqual(calls[2].args.ops, setDefaultOps('deepseek', 'deepseek-v4-flash'))
  })

  it('a keyless value issues exactly one write', async () => {
    const { calls, rpc } = mockRpc()
    await applyMyModels(rpc, {
      providerId: 'my-gw',
      displayName: undefined,
      profile: { api: 'openai-completions', baseURL: 'https://gw.example/v1', models: [{ id: 'm1' }] },
      apiKey: undefined,
      setDefault: undefined,
    })
    assert.deepEqual(calls.map((c) => c.method), ['settings/mutate'])
  })

  it('delete removes the conventional ref first, then the profile — and never a hand-written ref', async () => {
    const a = mockRpc()
    await applyMyModelDelete(a.rpc, 'my-gw', { apiKeyEnv: 'MY_GW_API_KEY' })
    assert.deepEqual(a.calls.map((c) => c.method), ['credentials/unset', 'settings/mutate'])
    assert.deepEqual(a.calls[0].args, { ref: 'MY_GW_API_KEY' })
    assert.deepEqual(a.calls[1].args, {
      ns: 'llm-pi-ai',
      ops: [{ op: 'unset', path: ['providers', 'my-gw'] }],
      expectedRevision: undefined,
    })

    const b = mockRpc()
    await applyMyModelDelete(b.rpc, 'my-gw', { apiKeyEnv: 'HAND_WRITTEN_ENV' })
    assert.deepEqual(b.calls.map((c) => c.method), ['settings/mutate'], 'a non-conventional ref is managed elsewhere')

    const c = mockRpc()
    await applyMyModelDelete(c.rpc, 'my-gw', undefined)
    assert.deepEqual(c.calls.map((c2) => c2.method), ['settings/mutate'], 'an already-gone route is one unset')
  })

  it('a failed key write still surfaces (the profile stays, the retry re-sends the key)', async () => {
    const { rpc } = mockRpc({ 'credentials/set': 'credential store refused the write' })
    await assert.rejects(
      () => applyMyModels(rpc, {
        providerId: 'deepseek',
        displayName: 'DeepSeek',
        profile: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
        apiKey: 'sk-1',
        setDefault: undefined,
      }),
      /credential store refused/,
    )
  })
})

// ---------------------------------------------------------------------------
// unit: summarize + page rendering
// ---------------------------------------------------------------------------

describe('summarizeModelConfig + renderMyModelsPage', () => {
  const describeValue = {
    writable: true,
    namespaces: [
      {
        ns: 'llm-pi-ai',
        value: {
          providers: {
            'my-gw': {
              apiKeyEnv: 'MY_GW_API_KEY',
              api: 'openai-completions',
              baseURL: 'https://gw.example/v1',
              models: [{ id: 'm1' }, { id: 'm2' }],
            },
            deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY', displayName: 'DeepSeek' },
          },
        },
      },
      { ns: 'agent-default-model', value: { provider: 'my-gw', model: 'm1' } },
    ],
  }

  it('joins the pi-ai section and the default selection', () => {
    const { providers, defaultModel } = summarizeModelConfig(describeValue)
    assert.equal(providers.length, 2)
    const gw = providers.find((p) => p.id === 'my-gw')
    assert.deepEqual(gw.models, ['m1', 'm2'])
    assert.equal(gw.apiKeyEnv, 'MY_GW_API_KEY')
    assert.deepEqual(defaultModel, { provider: 'my-gw', model: 'm1' })
  })

  it('the page lists rows with key state and default badge', () => {
    const { providers, defaultModel } = summarizeModelConfig(describeValue)
    for (const p of providers) p.keyConfigured = p.apiKeyEnv === 'MY_GW_API_KEY'
    const html = renderMyModelsPage({ port: 3100, providers, defaultModel })
    assert.match(html, /我的模型/)
    assert.match(html, /DeepSeek/)
    assert.match(html, /自定义（其他 \/ 自建 \/ 中转）/)
    assert.match(html, /已配置/)
    assert.match(html, /<span class="badge ok">默认<\/span>/)
    assert.match(html, /action="\/dsh-login\/models"/) // the add form posts to the page
    assert.match(html, /data-df="deepseek"/)
    assert.match(html, /data-del="my-gw"/)
  })

  it('the page never contains a key, and user data is escaped', () => {
    const html = renderMyModelsPage({
      port: 3100,
      providers: [{
        id: 'x-gw',
        displayName: '<img src=x onerror=alert(1)>',
        apiKeyEnv: 'X_GW_API_KEY',
        keyConfigured: false,
        api: 'openai-completions',
        baseURL: 'https://x.example/v1',
        models: ['m1'],
      }],
      defaultModel: undefined,
      form: { kind: 'custom', providerId: 'x-gw', models: 'm1', setDefault: 'on', defaultModel: 'm1' },
    })
    assert.ok(!html.includes('sk-'))
    assert.ok(!html.includes('<img src=x'))
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
    assert.match(html, /checked/)
  })

  it('the instance account page links to the models page', () => {
    const html = renderAccountPage({ mode: 'instance', port: 3100 })
    assert.match(html, /href="\/dsh-login\/models"/)
    assert.match(html, /我的模型/)
  })
})

// ---------------------------------------------------------------------------
// integration: the instance gate + the models routes
// ---------------------------------------------------------------------------

function b64url(buf) {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/** Find a free loopback TCP port (the fake /api must listen on cfg.port). */
async function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
}

/**
 * A fake host whose /api mimics the DSH settings/credentials/llm remotes the
 * plugin speaks over selfRpc. `state` is the in-memory "settings.yaml +
 * .credentials.yaml"; every call is recorded for sequence assertions.
 */
class FakeInstance {
  constructor() {
    this.state = {
      providers: {},
      default: null,
      creds: {},
    }
    /** catalog fixture: route id -> discovered models (the local answer). */
    this.catalog = {
      deepseek: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
      openai: [{ id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' }],
    }
    this.calls = []
    this.routes = []
    this.disposers = []
    this.server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      const route = this.routes.find((r) => r.kind === 'prefix'
        && (pathname === r.path || pathname.startsWith(`${r.path}/`)))
      if (route === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('fake: not found\n')
        return
      }
      route.handler(req, res)
    })
    const innerSecret = randomBytes(32)
    this.innerSecret = innerSecret
    this.ctx = {
      webServer: {
        server: this.server,
        register: (route) => { this.routes.push(route); return () => { this.routes = this.routes.filter((r) => r !== route) } },
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
      inject: () => {},
      logger: { warn: () => {}, error: () => {} },
      // The gate installs itself through ctx.effect — run the callback and
      // keep the disposer, exactly like the real host does.
      effect: (fn) => {
        const disposer = fn()
        if (typeof disposer === 'function') this.disposers.push(disposer)
      },
    }
    this.ctx.webServer.register({ kind: 'prefix', path: '/api', handler: (req, res) => { this.handleApi(req, res) } })
  }

  async handleApi(req, res) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let envelope
    try {
      envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ result: { ok: false, error: { message: 'bad json' } } }))
      return
    }
    const { method, rpcId, payload } = envelope ?? {}
    const args = payload?.args ?? {}
    this.calls.push({ method, args })
    const result = this.dispatch(method, args)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
  }

  dispatch(method, args) {
    const s = this.state
    switch (method) {
      case 'settings/describe':
        return {
          ok: true,
          value: {
            writable: true,
            namespaces: [
              { ns: 'llm-pi-ai', value: { providers: s.providers } },
              { ns: 'agent-default-model', value: s.default },
            ],
          },
        }
      case 'settings/mutate': {
        const section = args.ns === 'llm-pi-ai'
          ? { providers: s.providers }
          : (args.ns === 'agent-default-model' ? (s.default = s.default ?? {}) : {})
        for (const op of args.ops ?? []) {
          const parent = op.path.slice(0, -1).reduce((node, key) => node[key], section)
          if (parent === undefined || typeof parent !== 'object') return { ok: false, error: { message: `bad path ${JSON.stringify(op.path)}` } }
          if (op.op === 'set') parent[op.path[op.path.length - 1]] = op.value
          else if (op.op === 'unset') delete parent[op.path[op.path.length - 1]]
        }
        return { ok: true, value: {} }
      }
      case 'credentials/set':
        s.creds[args.ref] = args.value
        return { ok: true, value: undefined }
      case 'credentials/unset':
        delete s.creds[args.ref]
        return { ok: true, value: undefined }
      case 'credentials/describe':
        return {
          ok: true,
          value: Object.fromEntries((args.refs ?? []).map((ref) => [ref, {
            configured: s.creds[ref] !== undefined,
            writable: true,
          }])),
        }
      case 'llm/discoverModels': {
        const provider = args.request?.provider
        if (provider !== undefined && this.catalog[provider] !== undefined) {
          return { ok: true, value: this.catalog[provider] }
        }
        return { ok: false, error: { message: `pi-ai ships no catalog for provider "${String(provider)}"` } }
      }
      default:
        return { ok: false, error: { message: `fake: unknown method ${String(method)}` } }
    }
  }

  async listenOn(port) {
    await new Promise((resolve, reject) => {
      const err = (e) => reject(e)
      this.server.once('error', err)
      this.server.listen(port, '127.0.0.1', () => {
        this.server.removeListener('error', err)
        resolve()
      })
    })
    this.baseUrl = `http://127.0.0.1:${String(port)}`
  }

  cookieHeader() {
    const authority = new URL(this.baseUrl).host
    const minted = mintInnerCookie(this.innerSecret, authority, 30)
    return `${minted.name}=${minted.value}`
  }

  dispose() {
    for (const d of this.disposers.splice(0)) d()
    return new Promise((resolve) => this.server.close(() => resolve()))
  }
}

async function startInstance() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-login-my-'))
  const port = await getFreePort()
  const config = normalizeConfig({ instance: true, hubBase: 'http://127.0.0.1:3999/', port })
  saveConfig(home, config)
  process.env.DSH_HOME = home
  const fake = new FakeInstance()
  await fake.listenOn(port)
  const { apply } = await import('../index.js')
  apply(fake.ctx)
  // The secret read is async; give it a beat before the first gated request.
  await new Promise((resolve) => setTimeout(resolve, 50))
  return { fake, home, port }
}

const cleanups = []
after(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function formPost(url, fields, headers = {}) {
  const body = new URLSearchParams(fields).toString()
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body,
    redirect: 'manual',
  })
}

function jsonPost(url, obj, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(obj),
    redirect: 'manual',
  })
}

/** Read-only calls the handlers may legitimately issue before writing. */
const READ_METHODS = new Set(['settings/describe', 'credentials/describe', 'llm/discoverModels'])
const writesOf = (fake) => fake.calls.filter((c) => !READ_METHODS.has(c.method))

describe('instance /dsh-login/models (self-service)', () => {
  it('anonymous bounces; an inner-cookie user gets the page without any key in it', async () => {
    const { fake, home } = await startInstance()
    cleanups.push(async () => { await fake.dispose(); await rm(home, { recursive: true, force: true }) })

    const anon = await fetch(`${fake.baseUrl}/dsh-login/models`, { redirect: 'manual' })
    assert.equal(anon.status, 302)
    assert.match(anon.headers.get('location') ?? '', /\/dsh-login\/login\?next=/)

    const page = await fetch(`${fake.baseUrl}/dsh-login/models`, {
      headers: { cookie: fake.cookieHeader() },
    })
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /我的模型/)
    assert.match(html, /data-preset="deepseek"/)
    assert.match(html, /data-preset="openrouter"/)
    assert.match(html, /更多内置提供方/)
    assert.match(html, /data-preset="__custom__"/)
    assert.ok(!html.includes('sk-'))
  })

  it('preset add: profile + key + default land in order, and the key is never echoed', async () => {
    const { fake, home } = await startInstance()
    cleanups.push(async () => { await fake.dispose(); await rm(home, { recursive: true, force: true }) })
    const cookie = { cookie: fake.cookieHeader() }

    const res = await formPost(`${fake.baseUrl}/dsh-login/models`, {
      kind: 'preset',
      presetId: 'deepseek',
      apiKey: 'sk-fake-deepseek-1',
      setDefault: 'on',
      defaultModel: 'deepseek-v4-flash',
    }, { ...cookie, origin: fake.baseUrl })
    assert.equal(res.status, 303)
    assert.match(res.headers.get('location') ?? '', /\/dsh-login\/models\?ok=/)

    const writes = writesOf(fake)
    assert.deepEqual(writes.map((c) => c.method), ['settings/mutate', 'credentials/set', 'settings/mutate'])
    // expectedRevision: undefined is dropped by JSON on the wire — absent
    // means "no optimistic-concurrency guard", exactly what was requested.
    assert.deepEqual(writes[0].args, {
      ns: 'llm-pi-ai',
      ops: [{
        op: 'set',
        path: ['providers', 'deepseek'],
        value: { apiKeyEnv: 'DEEPSEEK_API_KEY', displayName: 'DeepSeek' },
      }],
    })
    assert.deepEqual(writes[1].args, { ref: 'DEEPSEEK_API_KEY', value: 'sk-fake-deepseek-1' })
    assert.equal(writes[2].args.ns, 'agent-default-model')
    assert.deepEqual(fake.state.default, { provider: 'deepseek', model: 'deepseek-v4-flash' })

    const page = await fetch(`${fake.baseUrl}/dsh-login/models`, { headers: cookie })
    const html = await page.text()
    assert.ok(!html.includes('sk-fake-deepseek-1'), 'the saved key must never be echoed')
    assert.match(html, /已配置/)
    assert.match(html, /<span class="badge ok">默认<\/span>/)
  })

  it('preset add without a key is refused and writes nothing', async () => {
    const { fake, home } = await startInstance()
    cleanups.push(async () => { await fake.dispose(); await rm(home, { recursive: true, force: true }) })
    const res = await formPost(`${fake.baseUrl}/dsh-login/models`, {
      kind: 'preset',
      presetId: 'deepseek',
      apiKey: '',
    }, { cookie: fake.cookieHeader(), origin: fake.baseUrl })
    assert.equal(res.status, 400)
    assert.match(await res.text(), /请输入 API 密钥/)
    assert.equal(writesOf(fake).length, 0, 'a refused save must not write anything')
  })

  it('a cross-origin POST is refused', async () => {
    const { fake, home } = await startInstance()
    cleanups.push(async () => { await fake.dispose(); await rm(home, { recursive: true, force: true }) })
    const res = await formPost(`${fake.baseUrl}/dsh-login/models`, {
      kind: 'preset',
      presetId: 'deepseek',
      apiKey: 'sk-1',
    }, { cookie: fake.cookieHeader(), origin: 'http://evil.example' })
    assert.equal(res.status, 403)
    assert.equal(fake.calls.length, 0)
  })

  it('custom add: multi-model profile, key, and a default inside the typed list', async () => {
    const { fake, home } = await startInstance()
    cleanups.push(async () => { await fake.dispose(); await rm(home, { recursive: true, force: true }) })
    const res = await formPost(`${fake.baseUrl}/dsh-login/models`, {
      kind: 'custom',
      providerId: 'my-gw',
      displayName: 'My GW',
      api: 'openai-completions',
      baseURL: 'https://gw.example/v1',
      models: 'm1, m2\nm3',
      apiKey: 'sk-gw-1',
      setDefault: 'on',
      defaultModel: 'm2',
    }, { cookie: fake.cookieHeader(), origin: fake.baseUrl })
    assert.equal(res.status, 303)
    assert.deepEqual(fake.state.providers['my-gw'], {
      displayName: 'My GW',
      api: 'openai-completions',
      baseURL: 'https://gw.example/v1',
      models: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
      apiKeyEnv: 'MY_GW_API_KEY',
    })
    assert.equal(fake.state.creds.MY_GW_API_KEY, 'sk-gw-1')
    assert.deepEqual(fake.state.default, { provider: 'my-gw', model: 'm2' })
  })

  it('re-saving a custom provider with a blank key keeps the stored reference', async () => {
    const { fake, home } = await startInstance()
    cleanups.push(async () => { await fake.dispose(); await rm(home, { recursive: true, force: true }) })
    fake.state.providers['my-gw'] = {
      api: 'openai-completions',
      baseURL: 'https://old.example/v1',
      models: [{ id: 'm0' }],
      apiKeyEnv: 'MY_GW_API_KEY',
    }
    fake.state.creds.MY_GW_API_KEY = 'sk-kept'
    const before = fake.calls.length
    const res = await formPost(`${fake.baseUrl}/dsh-login/models`, {
      kind: 'custom',
      providerId: 'my-gw',
      api: 'openai-completions',
      baseURL: 'https://new.example/v1',
      models: 'm9',
      apiKey: '',
    }, { cookie: fake.cookieHeader(), origin: fake.baseUrl })
    assert.equal(res.status, 303)
    assert.equal(fake.state.providers['my-gw'].apiKeyEnv, 'MY_GW_API_KEY')
    assert.equal(fake.state.creds.MY_GW_API_KEY, 'sk-kept')
    assert.ok(!fake.calls.slice(before).some((c) => c.method === 'credentials/set'), 'no key write on a blank re-save')
  })

  it('delete removes the conventional credential first, then the profile', async () => {
    const { fake, home } = await startInstance()
    cleanups.push(async () => { await fake.dispose(); await rm(home, { recursive: true, force: true }) })
    fake.state.providers['my-gw'] = {
      api: 'openai-completions',
      baseURL: 'https://gw.example/v1',
      models: [{ id: 'm1' }],
      apiKeyEnv: 'MY_GW_API_KEY',
    }
    fake.state.creds.MY_GW_API_KEY = 'sk-1'

    const res = await jsonPost(`${fake.baseUrl}/dsh-login/models/delete`, { id: 'my-gw' },
      { cookie: fake.cookieHeader(), origin: fake.baseUrl })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, removed: true })
    const writes = fake.calls
      .filter((c) => c.method === 'credentials/unset' || c.method === 'settings/mutate')
      .map((c) => c.method)
    assert.deepEqual(writes, ['credentials/unset', 'settings/mutate'], 'the credential goes first, the profile second')
    assert.deepEqual(fake.state.providers, {})
    assert.equal(fake.state.creds.MY_GW_API_KEY, undefined)

    // deleting again is an idempotent no-op
    const again = await jsonPost(`${fake.baseUrl}/dsh-login/models/delete`, { id: 'my-gw' },
      { cookie: fake.cookieHeader(), origin: fake.baseUrl })
    assert.deepEqual(await again.json(), { ok: true, removed: false })
  })

  it('delete refuses a cross-origin POST and a malformed id', async () => {
    const { fake, home } = await startInstance()
    cleanups.push(async () => { await fake.dispose(); await rm(home, { recursive: true, force: true }) })
    const evil = await jsonPost(`${fake.baseUrl}/dsh-login/models/delete`, { id: 'x' },
      { cookie: fake.cookieHeader(), origin: 'http://evil.example' })
    assert.equal(evil.status, 403)
    const bad = await jsonPost(`${fake.baseUrl}/dsh-login/models/delete`, { id: '../etc' },
      { cookie: fake.cookieHeader(), origin: fake.baseUrl })
    assert.equal(bad.status, 400)
  })

  it('set-default writes the selection and clears a stale reasoningEffort', async () => {
    const { fake, home } = await startInstance()
    cleanups.push(async () => { await fake.dispose(); await rm(home, { recursive: true, force: true }) })
    fake.state.providers['my-gw'] = {
      api: 'openai-completions',
      baseURL: 'https://gw.example/v1',
      models: [{ id: 'm1' }, { id: 'm2' }],
    }
    fake.state.default = { provider: 'other', model: 'x', reasoningEffort: 'high' }

    const res = await jsonPost(`${fake.baseUrl}/dsh-login/models/default`,
      { provider: 'my-gw', model: 'm2' },
      { cookie: fake.cookieHeader(), origin: fake.baseUrl })
    assert.equal(res.status, 200)
    const mutate = fake.calls.find((c) => c.method === 'settings/mutate')
    assert.deepEqual(mutate.args.ops, setDefaultOps('my-gw', 'm2'))
    assert.deepEqual(fake.state.default, { provider: 'my-gw', model: 'm2' })

    const unknown = await jsonPost(`${fake.baseUrl}/dsh-login/models/default`,
      { provider: 'ghost', model: 'm2' },
      { cookie: fake.cookieHeader(), origin: fake.baseUrl })
    assert.equal(unknown.status, 400)
  })

  it('models-of answers from the local catalog and refuses unknown routes', async () => {
    const { fake, home } = await startInstance()
    cleanups.push(async () => { await fake.dispose(); await rm(home, { recursive: true, force: true }) })
    const ok = await fetch(`${fake.baseUrl}/dsh-login/models/models-of?id=deepseek`, {
      headers: { cookie: fake.cookieHeader() },
    })
    assert.equal(ok.status, 200)
    assert.deepEqual(await ok.json(), {
      ok: true,
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
    })

    const missing = await fetch(`${fake.baseUrl}/dsh-login/models/models-of?id=my-gw`, {
      headers: { cookie: fake.cookieHeader() },
    })
    assert.equal(missing.status, 503)
    const missingBody = await missing.json()
    assert.equal(missingBody.ok, false)
    assert.match(missingBody.error, /no catalog/)

    const bad = await fetch(`${fake.baseUrl}/dsh-login/models/models-of?id=../x`, {
      headers: { cookie: fake.cookieHeader() },
    })
    assert.equal(bad.status, 400)
  })
})
