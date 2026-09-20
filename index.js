/**
 * dsh-login — DB-backed login gate for the DeepSeek Harness Web GUI.
 *
 * Composition: this bundle patch (cordis.patch.yml) inserts one plugin row;
 * no webserver config is set here (dsh-lan-access owns the 0.0.0.0 bind).
 * Runtime: the plugin wraps the HTTP server the same way dsh-lan-gate did —
 * every request and socket upgrade passes the admission decision first — and
 * serves its own register/login surface under /dsh-login.
 *
 * Admission (per request):
 *   1. peer must be a real socket address; proxy-forwarding headers are
 *      refused (no spoofed clients behind a forwarding proxy);
 *   2. non-loopback peers must be IPv4 inside the configured CIDR allowlist;
 *   3. /dsh-login/* is the auth surface and always reaches the route;
 *   4. a valid dsh-login session cookie passes everything else through;
 *   5. otherwise GET/HEAD gets a 302 to the login page and every other
 *      request (including /api and upgrades) gets a 401.
 *
 * After a database-verified login the response also mints the Web GUI's
 * built-in browser-session cookie (same signed format as client-connection's
 * BrowserAuth, same signing secret read from the credentials service), so a
 * dsh-login account is enough to use the app — no launch-token URL needed.
 * A response-level bridge re-mints that cookie whenever a session-valid
 * request arrives without one for the current authority.
 *
 * Deployment settings live in $DSH_HOME/dsh-login.json (see lib/config.js).
 * Sessions persist in $DSH_HOME/dsh-login-sessions.json (tokens stored hashed).
 */
import { createHash } from 'node:crypto'
import { loadConfig } from './lib/config.js'
import {
  COOKIE_NAME,
  LoginLimiter,
  SessionStore,
  hashPassword,
  originMatchesHost,
  parseCookies,
  requestHasProxyHeaders,
  verifyPassword,
  cookieHeader,
  clearCookieHeader,
} from './lib/auth.js'
import { isLoopbackPeer, ipv4InCidrs, normalizePeerIp, parseCidrList } from './lib/cidr.js'
import {
  decodeInnerPayload,
  innerCookieHeader,
  innerCookieName,
  mintHandoffToken,
  mintInnerCookie,
  readInnerSecret,
  requestAuthority,
  verifyInnerCookie,
} from './lib/inner.js'
import { deriveHubBase, InstanceManager, isSafeUsername, lanIp } from './lib/instances.js'
import {
  applyModelConfig, applyMyModelDelete, applyMyModels, isProviderId, setDefaultOps,
  summarizeModelConfig, validateModelConfig, validateMyModels,
} from './lib/model-config.js'
import { loginPage } from './lib/page.js'
import { policyFromColumn, readModelPolicy, writeModelPolicy } from './lib/model-policy.js'
import {
  renderAccountPage, renderEnterConfirmPage, renderModelsClosedPage, renderMyModelsPage,
  renderUserModelsPage, renderUsersPage,
} from './lib/account-page.js'

export const name = 'dsh-login'
export const inject = ['webServer', 'credentials']

const AUTH_PREFIX = '/dsh-login/'
const LOGIN_PATH = '/dsh-login/login'
const REGISTER_PATH = '/dsh-login/register'
const LOGOUT_PATH = '/dsh-login/logout'
const STATE_PATH = '/dsh-login/state'
const HEALTH_PATH = '/dsh-login/health'
const ACCOUNT_PATH = '/dsh-login/account'
const USERS_PATH = '/dsh-login/users'
const ENTER_PATH = '/dsh-login/enter'
const USERS_DELETE_PATH = '/dsh-login/users/delete'
/** Admin console: configure one user's own model provider. */
const USER_MODELS_PATH = '/dsh-login/users/models'
/** Admin console: approve or reject one registered account. */
const USERS_STATUS_PATH = '/dsh-login/users/status'
/** Admin console: allow/deny one user configuring their own model providers. */
const USERS_MODEL_POLICY_PATH = '/dsh-login/users/model-policy'
const BODY_LIMIT = 64 * 1024
const INNER_MAX_AGE_DAYS = 30
const INNER_MAX_AGE_MS = INNER_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
/** Lifetime of a hub → instance handoff token (seconds). */
const HUB_HANDOFF_TTL_SEC = 600
const USERNAME_PATTERN = /^[\u4e00-\u9fff\u3400-\u4dbfA-Za-z0-9._-]+$/
const ERRORS = {
  badOrigin: '请求来源不合法',
  badBody: '请求体不是合法的 JSON',
  emptyFields: '请填写完整的用户名和密码',
  invalidUsername: '用户名格式不正确：2-32 位，支持中英文、数字、下划线、点和短横线',
  invalidPassword: '密码长度需为 8-128 位',
  passwordMismatch: '两次输入的密码不一致',
  badCredentials: '用户名或密码错误',
  exists: '该用户名已被占用',
  tooMany: '尝试次数过多，请 15 分钟后再试',
  dbDown: '数据库暂不可用，请稍后重试',
  registerDisabled: '注册功能已关闭',
  pendingApproval: '账号已注册，正在等待管理员审批；审批通过后即可登录',
  rejectedApproval: '账号未通过管理员审批，请联系管理员',
  registeredPending: '注册成功！请等待管理员审批，审批通过后即可登录',
  /** Instance mode: the self-service model page is gated by the admin switch. */
  modelPolicyDenied: '管理员尚未允许你自行设置模型参数：请联系管理员在「用户管理」中开启「允许自行设置模型」，或让管理员直接为你配置。',
  logoutRedirect: '/dsh-login/login',
}

function dshHomeOf() {
  return process.env.DSH_HOME || `${process.env.HOME || ''}/.dsh`
}

function pathnameOf(req) {
  try {
    return new URL(req.url ?? '/', 'http://x').pathname
  } catch {
    return '/'
  }
}

function deny(res, reason, status = 403) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(`forbidden: ${reason}\n`)
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(`${JSON.stringify(body)}\n`)
}

function html(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let n = 0
    req.on('data', (c) => {
      n += c.length
      if (n > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** MySQL TIMESTAMP (Date) → 'YYYY-MM-DD HH:mm' local, for the users page. */
function fmtTs(value) {
  if (value === null || value === undefined) return undefined
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function parseForm(text) {
  const out = Object.create(null)
  for (const part of text.split('&')) {
    if (!part) continue
    const idx = part.indexOf('=')
    const key = decodeURIComponent((idx < 0 ? part : part.slice(0, idx)).replaceAll('+', ' '))
    const value = decodeURIComponent((idx < 0 ? '' : part.slice(idx + 1)).replaceAll('+', ' '))
    out[key] = value
  }
  return out
}

/** Decode a POST body as JSON first, then form-urlencoded (no-JS fallback). */
async function decodeBody(req) {
  const raw = await readBody(req)
  const type = String(req.headers['content-type'] || '')
  if (type.includes('application/json')) {
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed
  }
  return parseForm(raw)
}

/** Validate one username; returns the trimmed value or undefined. */
function cleanUsername(value) {
  if (typeof value !== 'string') return undefined
  const t = value.trim()
  if (t.length < 2 || t.length > 32) return undefined
  if (/[\x00-\x1f\x7f]/.test(t)) return undefined
  if (!USERNAME_PATTERN.test(t)) return undefined
  return t
}

function cleanPassword(value) {
  if (typeof value !== 'string') return undefined
  if (value.length < 8 || value.length > 128) return undefined
  return value
}

/**
 * Validate a `next` redirect target: a same-origin absolute path, or — when
 * `allowAbsolute` accepts the URL — an absolute http(s) URL (per-user
 * instance gates bounce unauthenticated users back to the login page with
 * the instance URL as `next`).
 */
function safeNext(value, fallback = '/', allowAbsolute) {
  if (typeof value !== 'string') return fallback
  const t = value.trim()
  if (t.length < 1 || t.length > 1024) return fallback
  if (/[\r\n\u0000]/.test(t)) return fallback
  if (t.startsWith('/')) {
    return t.startsWith('//') ? fallback : t
  }
  if (allowAbsolute !== undefined) {
    try {
      const u = new URL(t)
      if ((u.protocol === 'http:' || u.protocol === 'https:') && allowAbsolute(u)) return u.toString()
    } catch {
      // not a URL → rejected below
    }
  }
  return fallback
}

/** Predicate factory: absolute `next` URLs limited to this host's own ports. */
function absoluteNextAllowed(portBase) {
  const hosts = new Set(['127.0.0.1'])
  const lan = lanIp()
  if (lan !== undefined) hosts.add(lan)
  return (u) => {
    if (!hosts.has(u.hostname)) return false
    const port = u.port === '' ? (u.protocol === 'https:' ? 443 : 80) : Number(u.port)
    return Number.isInteger(port) && port >= portBase && port <= portBase + 100_000
  }
}

/** The login page redirect target for one unauthenticated request. */
function loginRedirect(req) {
  try {
    const url = new URL(req.url ?? '/', 'http://x')
    const next = `${url.pathname}${url.search}`
    if (!next.startsWith('/') || next.startsWith('//') || /[\r\n\u0000]/.test(next) || next.length > 512) {
      return LOGIN_PATH
    }
    return `${LOGIN_PATH}?next=${encodeURIComponent(next)}`
  } catch {
    return LOGIN_PATH
  }
}

/** Hostname without port of the request authority (absolute URL building). */
function hostNoPortOf(hostHeader) {
  const authority = requestAuthority(hostHeader)
  if (authority === undefined) return undefined
  const idx = authority.lastIndexOf(':')
  return idx < 0 ? authority : authority.slice(0, idx)
}

/** Admission decision for one request (see the module header). */
function admit({ req, cfg, cidrs, sessionOk }) {
  const peer = normalizePeerIp(req.socket?.remoteAddress)
  if (peer === undefined) return { ok: false, reason: 'no-peer', peer, status: 403 }
  if (cfg.rejectProxyHeaders) {
    const bad = requestHasProxyHeaders(req)
    if (bad.length > 0) return { ok: false, reason: `proxy-headers ${bad.join(',')}`, peer, status: 403 }
  }
  const loopback = isLoopbackPeer(peer)
  if (!loopback && (peer.kind !== 'v4' || !ipv4InCidrs(peer.text, cidrs))) {
    return { ok: false, reason: `cidr ${peer.text}`, peer, status: 403 }
  }
  const path = pathnameOf(req)
  if (path.startsWith(AUTH_PREFIX)) return { ok: true, reason: 'auth-path', peer, sessionOk }
  if (sessionOk) return { ok: true, reason: 'session', peer, sessionOk }
  if (req.method === 'GET' || req.method === 'HEAD') {
    return { ok: false, reason: 'auth', peer, status: 401, redirect: loginRedirect(req) }
  }
  return { ok: false, reason: 'auth', peer, status: 401 }
}

/**
 * Wrap the raw HTTP server so every request and upgrade is admitted first.
 * Returns the disposer that restores the original listeners.
 */
function installServerGate(server, decide, bridgeCookie) {
  const current = server.listeners('request')
  server.removeAllListeners('request')
  server.on('request', (req, res) => {
    const verdict = decide(req)
    if (!verdict.ok) {
      const path = pathnameOf(req)
      if (verdict.redirect && (req.method === 'GET' || req.method === 'HEAD') && !path.startsWith('/api/')) {
        res.writeHead(302, { location: verdict.redirect, 'cache-control': 'no-store' })
        res.end()
        return
      }
      if (path.startsWith('/api/')) {
        json(res, verdict.status ?? 401, { error: 'unauthorized' })
        return
      }
      deny(res, verdict.reason, verdict.status ?? 403)
      return
    }
    // Self-healing bridge: when a request passes on our session cookie but
    // lacks a working inner browser-session cookie for this authority,
    // attach one so the built-in gate passes from the very next hop without
    // a second login. Login/register responses already carry a minted inner
    // cookie, so the bridge stays silent for the auth surface.
    const injected = verdict.reason === 'session' ? bridgeCookie(req) : undefined
    if (injected !== undefined) {
      const origWriteHead = res.writeHead.bind(res)
      res.writeHead = function writeHead(status, ...args) {
        let headers
        if (typeof args[0] === 'object' && args[0] !== null) headers = args[0]
        else if (args.length >= 2 && typeof args[1] === 'object' && args[1] !== null) headers = args[1]
        else headers = {}
        const prev = headers['set-cookie']
        headers['set-cookie'] = prev === undefined
          ? [injected]
          : [...(Array.isArray(prev) ? prev : [prev]), injected]
        if (typeof args[0] === 'object' && args[0] !== null) {
          args[0] = headers
        } else if (args.length === 2 && typeof args[1] === 'string') {
          args.push(headers)
        } else if (args.length === 0) {
          args = [headers]
        } else {
          args[args.length - 1] = headers
        }
        return origWriteHead(status, ...args)
      }
    }
    for (const listener of current) listener.call(server, req, res)
  })
  const upgrades = server.listeners('upgrade')
  server.removeAllListeners('upgrade')
  server.on('upgrade', (req, socket, head) => {
    const verdict = decide(req)
    if (!verdict.ok) {
      socket.write(`HTTP/1.1 ${String(verdict.status ?? 401)} Unauthorized\r\nConnection: close\r\n\r\n`)
      socket.destroy()
      return
    }
    for (const listener of upgrades) listener.call(server, req, socket, head)
  })
  return () => {
    server.removeAllListeners('request')
    for (const listener of current) server.on('request', listener)
    server.removeAllListeners('upgrade')
    for (const listener of upgrades) server.on('upgrade', listener)
  }
}

/**
 * Async facade over LoginDatabase: the MySQL driver (db.js) is only imported
 * on first use, so instance-mode hosts — which never touch the database — do
 * not load mysql2. The method surface mirrors LoginDatabase (all awaited by
 * the callers); `close` is a no-op when the driver never loaded.
 */
function createLazyDb(dbCfg) {
  let instancePromise = undefined
  const load = () => {
    if (instancePromise === undefined) {
      instancePromise = import('./lib/db.js')
        .then((m) => new m.LoginDatabase(dbCfg))
        .catch((err) => {
          instancePromise = undefined
          throw err
        })
    }
    return instancePromise
  }
  return {
    ensureTable: () => load().then((d) => d.ensureTable()),
    health: () => load().then((d) => d.health()),
    register: (username, passwordHash, status) => load().then((d) => d.register(username, passwordHash, status)),
    findByUsername: (username) => load().then((d) => d.findByUsername(username)),
    listUsers: () => load().then((d) => d.listUsers()),
    setStatus: (username, status) => load().then((d) => d.setStatus(username, status)),
    setModelSelfService: (username, allow) => load().then((d) => d.setModelSelfService(username, allow)),
    touchLastLogin: (username) => load().then((d) => d.touchLastLogin(username)),
    remove: (username) => load().then((d) => d.remove(username)),
    close() {
      if (instancePromise !== undefined) {
        instancePromise.then((d) => d.close()).catch(() => {})
      }
    },
  }
}

/**
 * Floating "账户" button injected into the served GUI index (official
 * webserver index-inject table, rendered by the webserver itself). The
 * button is static; the target page adapts to the session server-side.
 */
const ACCT_BTN_STYLE = '#dsh-login-acct{position:fixed;right:14px;bottom:14px;z-index:2147483000;background:rgba(18,22,31,.92);border:1px solid #2a3345;color:#aab8ff;padding:5px 12px;border-radius:999px;font:600 12px system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;text-decoration:none;backdrop-filter:blur(4px);user-select:none}#dsh-login-acct:hover{border-color:#5b8cff;color:#e8ecf4}'
const ACCT_BTN_HTML = '<a id="dsh-login-acct" href="/dsh-login/account" title="dsh-login 账户：当前登录 / 用户管理 / 退出">账户</a>'

function registerIndexButton(ctx) {
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.on('webserver/index-inject', (table) => {
        table.push({ kind: 'style', text: ACCT_BTN_STYLE })
        table.push({ kind: 'html', placement: 'body', html: ACCT_BTN_HTML })
      })
    })
  } catch {
    /* index injection unavailable on this host; the page stays reachable
       directly at /dsh-login/account */
  }
}

/**
 * Mount the gate.
 * @param ctx - host plugin context (webServer + credentials services).
 */
export function apply(ctx) {
  const home = dshHomeOf()
  const cfg = loadConfig(home)
  registerIndexButton(ctx)
  if (cfg.mode === 'instance') {
    applyInstance(ctx, home, cfg)
    return
  }
  const cidrs = parseCidrList(cfg.allowCidrs)
  // db.js is imported lazily (hub mode only) so instance-mode hosts never
  // load the MySQL driver.
  const db = createLazyDb(cfg.db)
  const sessions = new SessionStore({
    ttlSec: cfg.sessionTtlSec,
    persistPath: `${home}/dsh-login-sessions.json`,
  })
  const limiter = new LoginLimiter({ windowMs: 15 * 60_000, maxFails: 10 })
  let innerSecret = undefined
  let innerSecretPromise = undefined

  // ---- per-user instance tenancy (hub mode only) ---------------------------
  const isAdmin = (username) => cfg.adminUsers.includes(username)
  const knownPorts = new Map()
  let managerInstance = undefined
  const hubPort = () => {
    try {
      const addr = ctx.webServer.server.address()
      return addr !== null && typeof addr === 'object' ? addr.port : 3080
    } catch {
      return 3080
    }
  }
  /** Lazily create the instance manager and refresh the hub's port/base URL. */
  const manager = () => {
    if (managerInstance === undefined) {
      managerInstance = new InstanceManager({
        root: cfg.instances.root,
        portBase: cfg.instances.portBase,
        checkout: cfg.instances.checkout,
        hubHome: home,
        hubPort: 0,
        hubBase: '',
        allowCidrs: cfg.allowCidrs,
        rejectProxyHeaders: cfg.rejectProxyHeaders,
        // Each instance shares exactly ONE credential with the hub: the
        // browser-session signing secret the handoff is minted with. Model
        // choices and provider API keys start empty for every user.
        signingSecret: async () => {
          await ensureInnerSecret()
          return innerSecret
        },
        logger: {
          warn: (m) => { console.warn(`dsh-login: ${m}`) },
          error: (m) => { console.error(`dsh-login: ${m}`) },
        },
      })
    }
    managerInstance.setHub(hubPort(), deriveHubBase(cfg.instances.hubBase, hubPort()))
    return managerInstance
  }

  /**
   * Ensure one user's instance is running, first mirroring the administrator's
   * model-self-service decision into that user's DSH_HOME.
   *
   * The instance enforces the switch from its own local copy
   * (lib/model-policy.js), so a freshly provisioned or restored home must be
   * brought back in step with the account table before the instance starts.
   * The lookup fails CLOSED: if the decision cannot be read, the mirror is
   * rewritten to "denied" so a stale grant cannot outlive the database answer.
   */
  const ensureUserInstance = async (username) => {
    let allow = false
    try {
      const row = await db.findByUsername(username)
      allow = policyFromColumn(row?.model_self_service)
    } catch (err) {
      ctx.logger?.warn?.(err instanceof Error ? err : new Error(String(err)))
    }
    try {
      await writeModelPolicy(manager().userDir(username), allow)
    } catch (err) {
      ctx.logger?.warn?.(err instanceof Error ? err : new Error(String(err)))
    }
    return manager().ensure(username)
  }
  // Adopt provisioned instances at boot (populates the port cache so the
  // synchronous gate can redirect to a known instance URL).
  manager().listUsers()
    .then((list) => { for (const rec of list) knownPorts.set(rec.username, rec.port) })
    .catch(() => {})

  /**
   * Start (once) the read of the inner browser-session signing secret and
   * return its promise; the cached promise also resolves when the record is
   * absent, so callers can await it before minting.
   */
  const ensureInnerSecret = () => {
    if (innerSecretPromise === undefined) {
      innerSecretPromise = readInnerSecret(ctx.credentials)
        .then((secret) => {
          if (secret !== undefined) innerSecret = secret
          return secret
        })
        .catch(() => undefined)
    }
    return innerSecretPromise
  }

  const sessionOk = (req) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME]
    return sessions.get(token) !== undefined
  }
  const sessionUser = (req) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME]
    const row = token === undefined ? undefined : sessions.get(token)
    return row?.user
  }
  /**
   * Admission decision. Admins use the hub application directly; regular
   * users may only use the hub's login surface — everything else redirects
   * to their own dedicated instance (falling back to the login page when the
   * port is unknown, which re-provisions the instance on the next login).
   */
  const decide = (req) => {
    const verdict = admit({ req, cfg, cidrs, sessionOk: sessionOk(req) })
    if (!verdict.ok || verdict.reason !== 'session') return verdict
    const user = sessionUser(req)
    if (user === undefined || isAdmin(user)) return verdict
    const path = pathnameOf(req)
    if (path.startsWith(AUTH_PREFIX)) return verdict
    const port = knownPorts.get(user)
    if (port === undefined) {
      return { ok: false, reason: 'instance-surface', peer: verdict.peer, status: 401, redirect: loginRedirect(req) }
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const hostNoPort = hostNoPortOf(req.headers.host)
      if (hostNoPort !== undefined) {
        return { ok: false, reason: 'instance-surface', peer: verdict.peer, status: 401, redirect: `http://${hostNoPort}:${String(port)}/` }
      }
    }
    return { ok: false, reason: 'instance-surface', peer: verdict.peer, status: 401 }
  }

  /**
   * Set-Cookie to attach to a session-valid response, or undefined when the
   * request already carries a working inner cookie for this authority.
   */
  const bridgeCookie = (req) => {
    ensureInnerSecret()
    const authority = requestAuthority(req.headers.host)
    if (authority === undefined || innerSecret === undefined) return undefined
    const name = innerCookieName(authority)
    const presented = parseCookies(req.headers.cookie)[name]
    if (presented !== undefined && verifyInnerCookie(presented, innerSecret, authority, INNER_MAX_AGE_MS)) {
      return undefined
    }
    return innerCookieHeader(mintInnerCookie(innerSecret, authority, INNER_MAX_AGE_DAYS))
  }

  ctx.effect(() => installServerGate(ctx.webServer.server, decide, bridgeCookie))
  // Release the database pool when the owning context is disposed so a
  // `dsh web` shutdown (or the test harness) never leaks open connections.
  ctx.effect(() => () => { db.close() })

  /**
   * Issue the gate session cookie and (optionally) a minted inner cookie for
   * this authority. Awaits the secret read if it has not settled yet so the
   * response can carry both cookies on the first hop. Regular users do not
   * get the hub's inner cookie: they are handed off to their own instance,
   * whose cookie that instance mints itself.
   */
  const loginCookies = async (req, username, withInnerCookie) => {
    const token = sessions.issue(username)
    const headers = [cookieHeader(COOKIE_NAME, token, { maxAgeSec: cfg.sessionTtlSec })]
    if (!withInnerCookie) return headers
    const authority = requestAuthority(req.headers.host)
    if (authority !== undefined) {
      if (innerSecret === undefined) await ensureInnerSecret()
      if (innerSecret !== undefined) {
        headers.push(innerCookieHeader(mintInnerCookie(innerSecret, authority, INNER_MAX_AGE_DAYS)))
      }
    }
    return headers
  }

  /**
   * Whether the caller asked for the JSON login protocol (the login page's JS).
   * It only selects the response encoding — never a security decision.
   */
  const wantsJson = (req) => req.headers['x-dsh-login-json'] === '1'

  /**
   * Regular-user handoff: ensure the user's instance is up (provisioning on
   * first use), then redirect to it carrying a short-lived handoff token
   * bound to the instance authority. The instance verifies the token and
   * converts it into its own long-lived browser cookie.
   */
  const handoffRedirect = async (req, res, username, next) => {
    const hostNoPort = hostNoPortOf(req.headers.host) ?? '127.0.0.1'
    const port = await ensureUserInstance(username)
    knownPorts.set(username, port)
    if (innerSecret === undefined) await ensureInnerSecret()
    if (innerSecret === undefined) {
      json(res, 503, { error: '内部错误：无法生成登录令牌，请重试' })
      return
    }
    const authority = `${hostNoPort}:${String(port)}`
    let target
    if (next.startsWith('http://') || next.startsWith('https://')) {
      // Drop any stale handoff token from a bounce-back next so it is never
      // re-sent alongside the fresh one (a consumed first value would make
      // the instance reject the pair and loop the user back to login).
      try {
        const u = new URL(next)
        u.searchParams.delete('handoff')
        target = u.toString()
      } catch {
        target = next
      }
    } else {
      target = `http://${authority}${next === '' ? '/' : next}`
    }
    const handoff = mintHandoffToken(innerSecret, authority, HUB_HANDOFF_TTL_SEC)
    const location = `${target}${target.includes('?') ? '&' : '?'}handoff=${encodeURIComponent(handoff.value)}`
    const cookies = [cookieHeader(COOKIE_NAME, sessions.issue(username), { maxAgeSec: cfg.sessionTtlSec })]
    // A JS caller cannot read the Location of a redirected fetch — and
    // `redirect:'manual'` yields an opaque response (status 0, no headers) —
    // so the page opts into the JSON protocol and receives the target
    // explicitly, then decides same-tab vs new-window itself. The plain form
    // fallback keeps the 302.
    if (wantsJson(req)) {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookies, 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, target: location }))
      return
    }
    res.writeHead(302, { location, 'set-cookie': cookies, 'cache-control': 'no-store' })
    res.end()
  }

  const handleLogin = async (req, res) => {
    const peer = normalizePeerIp(req.socket?.remoteAddress)
    const ip = peer?.text ?? 'unknown'
    if (!originMatchesHost(req.headers.origin, req.headers.host)) {
      json(res, 403, { error: ERRORS.badOrigin })
      return
    }
    if (!limiter.allow(ip)) {
      json(res, 429, { error: ERRORS.tooMany })
      return
    }
    let body
    try {
      body = await decodeBody(req)
    } catch {
      json(res, 400, { error: ERRORS.badBody })
      return
    }
    if (body === undefined) {
      json(res, 400, { error: ERRORS.badBody })
      return
    }
    const username = cleanUsername(body.username)
    const password = cleanPassword(body.password)
    if (username === undefined || password === undefined) {
      json(res, 400, { error: username === undefined ? ERRORS.invalidUsername : ERRORS.invalidPassword })
      return
    }
    let row
    try {
      row = await db.findByUsername(username)
    } catch (err) {
      json(res, 503, { error: `${ERRORS.dbDown}（${err instanceof Error ? err.message : String(err)}）` })
      return
    }
    if (row === undefined || !verifyPassword(password, row.password_hash)) {
      limiter.fail(ip)
      json(res, 401, { error: ERRORS.badCredentials })
      return
    }
    limiter.succeed(ip)
    // Administrator approval gate. Administrators always pass: their names come
    // from the deployment config, not from the table's approval workflow.
    const accountStatus = typeof row.status === 'string' ? row.status : 'approved'
    if (!isAdmin(username) && accountStatus !== 'approved') {
      json(res, 403, {
        error: accountStatus === 'pending' ? ERRORS.pendingApproval : ERRORS.rejectedApproval,
        status: accountStatus,
      })
      return
    }
    void db.touchLastLogin(username).catch(() => {})
    // `next` arrives through the form's hidden field (JSON body or form
    // body); absolute URLs are only accepted for this host's instance ports.
    const next = safeNext(body.next, '/', absoluteNextAllowed(cfg.instances.portBase))
    if (isAdmin(username)) {
      const cookies = await loginCookies(req, username, true)
      if (wantsJson(req)) {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookies, 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, target: next }))
        return
      }
      res.writeHead(302, {
        location: next,
        'set-cookie': cookies,
        'cache-control': 'no-store',
      })
      res.end()
      return
    }
    try {
      await handoffRedirect(req, res, username, next)
    } catch (err) {
      ctx.logger?.warn?.(err instanceof Error ? err : new Error(String(err)))
      json(res, 503, { error: `独立环境准备失败：${err instanceof Error ? err.message : String(err)}` })
    }
  }

  const handleRegister = async (req, res) => {
    const peer = normalizePeerIp(req.socket?.remoteAddress)
    const ip = peer?.text ?? 'unknown'
    if (cfg.register !== 'open') {
      json(res, 403, { error: ERRORS.registerDisabled })
      return
    }
    if (!originMatchesHost(req.headers.origin, req.headers.host)) {
      json(res, 403, { error: ERRORS.badOrigin })
      return
    }
    if (!limiter.allow(ip)) {
      json(res, 429, { error: ERRORS.tooMany })
      return
    }
    let body
    try {
      body = await decodeBody(req)
    } catch {
      json(res, 400, { error: ERRORS.badBody })
      return
    }
    if (body === undefined) {
      json(res, 400, { error: ERRORS.badBody })
      return
    }
    const username = cleanUsername(body.username)
    const password = cleanPassword(body.password)
    const password2 = body.password2 === undefined ? password : cleanPassword(body.password2)
    if (username === undefined) {
      limiter.fail(ip)
      json(res, 400, { error: ERRORS.invalidUsername })
      return
    }
    if (password === undefined) {
      limiter.fail(ip)
      json(res, 400, { error: ERRORS.invalidPassword })
      return
    }
    if (body.password2 !== undefined && password !== password2) {
      limiter.fail(ip)
      json(res, 400, { error: ERRORS.passwordMismatch })
      return
    }
    let result
    // Administrators and deployments that switched approval off are usable at
    // once; everybody else lands in the approval queue.
    const newStatus = isAdmin(username) || cfg.requireApproval !== true ? 'approved' : 'pending'
    try {
      await db.ensureTable()
      result = await db.register(username, hashPassword(password), newStatus)
    } catch (err) {
      json(res, 503, { error: `${ERRORS.dbDown}（${err instanceof Error ? err.message : String(err)}）` })
      return
    }
    if (!result.ok) {
      limiter.fail(ip)
      json(res, 409, { error: ERRORS.exists })
      return
    }
    limiter.succeed(ip)
    const next = safeNext(body.next, '/', absoluteNextAllowed(cfg.instances.portBase))
    if (newStatus === 'pending') {
      // No session, no instance: the account exists but is not usable until an
      // administrator approves it from the user-management console.
      if (wantsJson(req)) {
        json(res, 200, { ok: true, pending: true, message: ERRORS.registeredPending })
        return
      }
      res.writeHead(303, {
        location: `${LOGIN_PATH}?registered=pending`,
        'cache-control': 'no-store',
      })
      res.end()
      return
    }
    // An approved fresh registration logs the user in immediately (they just
    // proved the password). Regular users land on their own instance.
    if (isAdmin(username)) {
      const cookies = await loginCookies(req, username, true)
      if (wantsJson(req)) {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookies, 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, target: next }))
        return
      }
      res.writeHead(302, {
        location: next,
        'set-cookie': cookies,
        'cache-control': 'no-store',
      })
      res.end()
      return
    }
    try {
      await handoffRedirect(req, res, username, next)
    } catch (err) {
      ctx.logger?.warn?.(err instanceof Error ? err : new Error(String(err)))
      json(res, 503, { error: `独立环境准备失败：${err instanceof Error ? err.message : String(err)}` })
    }
  }

  /**
   * Admin "enter as this user": GET renders the two-step confirmation
   * (ensuring the instance first, so the port is real), POST mints a
   * handoff for the target's instance. No session cookie is set: the
   * admin keeps their own hub identity while browsing the user's env.
   */
  const handleEnter = async (req, res, url) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME]
    const row = token === undefined ? undefined : sessions.get(token)
    const self = row?.user
    const instanceHost = hostNoPortOf(req.headers.host) ?? '127.0.0.1'
    if (self === undefined) {
      res.writeHead(302, {
        location: `${LOGIN_PATH}?next=${encodeURIComponent(ENTER_PATH)}`,
        'cache-control': 'no-store',
      })
      res.end()
      return
    }
    if (!isAdmin(self)) {
      html(res, 403, renderUsersPage({ users: [], self, instanceHost, error: '仅管理员可以进入用户环境' }))
      return
    }
    let target
    if (req.method === 'GET') {
      target = url.searchParams.get('user') ?? ''
    } else {
      if (!originMatchesHost(req.headers.origin, req.headers.host)) {
        json(res, 403, { error: ERRORS.badOrigin })
        return
      }
      let body
      try {
        body = await decodeBody(req)
      } catch {
        body = undefined
      }
      if (body === undefined) {
        json(res, 400, { error: ERRORS.badBody })
        return
      }
      target = typeof body.user === 'string' ? body.user : ''
    }
    if (!isSafeUsername(target)) {
      html(res, 400, renderUsersPage({ users: [], self, instanceHost, error: ERRORS.invalidUsername }))
      return
    }
    if (isAdmin(target)) {
      html(res, 400, renderUsersPage({ users: [], self, instanceHost, error: '管理员直接使用 hub，没有独立环境' }))
      return
    }
    let port
    try {
      port = await ensureUserInstance(target)
    } catch (err) {
      const msg = `独立环境准备失败：${err instanceof Error ? err.message : String(err)}`
      ctx.logger?.warn?.(err instanceof Error ? err : new Error(msg))
      html(res, 503, renderUsersPage({ users: [], self, instanceHost, error: msg }))
      return
    }
    knownPorts.set(target, port)
    if (req.method === 'GET') {
      html(res, 200, renderEnterConfirmPage({ user: target, port, running: true }))
      return
    }
    if (innerSecret === undefined) await ensureInnerSecret()
    if (innerSecret === undefined) {
      json(res, 503, { error: '内部错误：无法生成登录令牌，请重试' })
      return
    }
    const authority = `${instanceHost}:${String(port)}`
    const handoff = mintHandoffToken(innerSecret, authority, HUB_HANDOFF_TTL_SEC)
    res.writeHead(302, {
      location: `http://${authority}/?handoff=${encodeURIComponent(handoff.value)}`,
      'cache-control': 'no-store',
    })
    res.end()
  }

  /** Admin user deletion: stop the instance, remove the home dir + DB row. */
  const handleUserDelete = async (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME]
    const row = token === undefined ? undefined : sessions.get(token)
    const self = row?.user
    if (self === undefined) {
      json(res, 401, { error: '未登录' })
      return
    }
    if (!isAdmin(self)) {
      json(res, 403, { error: '仅管理员可以删除用户' })
      return
    }
    if (!originMatchesHost(req.headers.origin, req.headers.host)) {
      json(res, 403, { error: ERRORS.badOrigin })
      return
    }
    let body
    try {
      body = await decodeBody(req)
    } catch {
      body = undefined
    }
    if (body === undefined) {
      json(res, 400, { error: ERRORS.badBody })
      return
    }
    const target = typeof body.user === 'string' ? body.user : ''
    if (!isSafeUsername(target)) {
      json(res, 400, { error: ERRORS.invalidUsername })
      return
    }
    if (target === self) {
      json(res, 400, { error: '不能删除当前登录的账号' })
      return
    }
    let exists
    try {
      exists = (await db.findByUsername(target)) !== undefined
    } catch (err) {
      json(res, 503, { error: `数据库暂不可用：${err instanceof Error ? err.message : String(err)}` })
      return
    }
    if (!exists) {
      json(res, 404, { error: '用户不存在' })
      return
    }
    try {
      await manager().remove(target)
    } catch (err) {
      ctx.logger?.warn?.(err instanceof Error ? err : new Error(String(err)))
    }
    try {
      await db.remove(target)
    } catch (err) {
      json(res, 503, { error: `数据库暂不可用：${err instanceof Error ? err.message : String(err)}` })
      return
    }
    knownPorts.delete(target)
    json(res, 200, { ok: true })
  }

  /**
   * Call one RPC on a user's OWN instance, authenticated with a hub-minted
   * inner cookie for that instance's loopback authority.
   *
   * DSH deliberately withholds the settings/credentials surface from
   * non-loopback browsers, so a LAN administrator cannot use the native Models
   * page; the hub performs the same validated write against the user's
   * instance instead. Only that user's own settings are touched.
   * @param port - the user's instance port.
   * @param method - Typert Remote method (e.g. `settings/mutate`).
   * @param args - plain-object argument map.
   * @returns the successful result value.
   * @throws when the token cannot be minted, HTTP fails, or the instance refuses.
   */
  const instanceRpc = async (port, method, args) => {
    if (innerSecret === undefined) await ensureInnerSecret()
    if (innerSecret === undefined) throw new Error('无法生成实例访问令牌（签名密钥不可用）')
    const authority = `127.0.0.1:${String(port)}`
    const minted = mintInnerCookie(innerSecret, authority, INNER_MAX_AGE_DAYS)
    const res = await fetch(`http://${authority}/api/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${minted.name}=${minted.value}`,
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `admin-${String(Date.now())}`,
        method,
        payload: { args },
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`实例接口返回 HTTP ${String(res.status)}`)
    const envelope = await res.json()
    const result = envelope?.result
    if (result?.ok !== true) throw new Error(result?.error?.message ?? '实例拒绝了该操作')
    return result.value
  }

  /**
   * Administrator approval: approve or reject one registered account.
   * Registration creates accounts as 'pending' (unless `requireApproval` is
   * off), and the login gate refuses anything that is not 'approved'.
   */
  const handleUserStatus = async (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME]
    const row = token === undefined ? undefined : sessions.get(token)
    const self = row?.user
    if (self === undefined) {
      json(res, 401, { error: '未登录' })
      return
    }
    if (!isAdmin(self)) {
      json(res, 403, { error: '仅管理员可以审批账号' })
      return
    }
    if (!originMatchesHost(req.headers.origin, req.headers.host)) {
      json(res, 403, { error: ERRORS.badOrigin })
      return
    }
    let body
    try {
      body = await decodeBody(req)
    } catch {
      body = undefined
    }
    if (body === undefined) {
      json(res, 400, { error: ERRORS.badBody })
      return
    }
    const target = typeof body.user === 'string' ? body.user : ''
    if (!isSafeUsername(target)) {
      json(res, 400, { error: ERRORS.invalidUsername })
      return
    }
    const status = body.action === 'approve' ? 'approved' : body.action === 'reject' ? 'rejected' : undefined
    if (status === undefined) {
      json(res, 400, { error: '未知的审批动作' })
      return
    }
    if (isAdmin(target)) {
      json(res, 400, { error: '管理员账号无需审批' })
      return
    }
    try {
      if ((await db.findByUsername(target)) === undefined) {
        json(res, 404, { error: '用户不存在' })
        return
      }
      await db.setStatus(target, status)
    } catch (err) {
      json(res, 503, { error: `数据库暂不可用：${err instanceof Error ? err.message : String(err)}` })
      return
    }
    json(res, 200, { ok: true, status })
  }

  /**
   * Administrator switch: may this user configure their own model providers?
   *
   * Two stores move together: the account table column (the durable source of
   * truth shown by the console) and the mirror file in the user's DSH_HOME
   * that their own instance reads on every self-service request. Turning it ON
   * is the whole approval — there is no per-change queue; turning it OFF makes
   * the user's 「我的模型」 page read-only immediately, without an instance
   * restart.
   */
  const handleUserModelPolicy = async (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME]
    const row = token === undefined ? undefined : sessions.get(token)
    const self = row?.user
    if (self === undefined) {
      json(res, 401, { error: '未登录' })
      return
    }
    if (!isAdmin(self)) {
      json(res, 403, { error: '仅管理员可以设置模型权限' })
      return
    }
    if (!originMatchesHost(req.headers.origin, req.headers.host)) {
      json(res, 403, { error: ERRORS.badOrigin })
      return
    }
    let body
    try {
      body = await decodeBody(req)
    } catch {
      body = undefined
    }
    if (body === undefined) {
      json(res, 400, { error: ERRORS.badBody })
      return
    }
    const target = typeof body.user === 'string' ? body.user : ''
    if (!isSafeUsername(target)) {
      json(res, 400, { error: ERRORS.invalidUsername })
      return
    }
    // Accept a real boolean or the form encodings (x-www-form-urlencoded
    // decodes to strings); anything else is a malformed request.
    const allow = body.allow === true || body.allow === 'true' || body.allow === 'on' || body.allow === 1 || body.allow === '1'
    const deny = body.allow === false || body.allow === 'false' || body.allow === 'off' || body.allow === 0 || body.allow === '0'
    if (!allow && !deny) {
      json(res, 400, { error: 'allow 需为 true 或 false' })
      return
    }
    if (isAdmin(target)) {
      json(res, 400, { error: '管理员账号无需此开关（管理员直接在 hub 上管理自己的模型）' })
      return
    }
    try {
      if ((await db.findByUsername(target)) === undefined) {
        json(res, 404, { error: '用户不存在' })
        return
      }
      await db.setModelSelfService(target, allow)
    } catch (err) {
      json(res, 503, { error: `数据库暂不可用：${err instanceof Error ? err.message : String(err)}` })
      return
    }
    // Mirror the decision for the user's own instance. A failure here is not
    // fatal for the console (the DB row is authoritative and the next ensure
    // re-mirrors it), but it must be visible: report it and let the admin
    // retry rather than claiming success while the instance still denies.
    try {
      await writeModelPolicy(manager().userDir(target), allow)
    } catch (err) {
      json(res, 500, {
        error: `权限已写入数据库，但同步到该用户环境失败（其登录时会自动重试）：${err instanceof Error ? err.message : String(err)}`,
        allow,
      })
      return
    }
    json(res, 200, { ok: true, allow })
  }

  /**
   * Admin console: GET renders one user's model configuration plus the form;
   * POST writes it through that user's own instance API.
   */
  const handleUserModels = async (req, res, url) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME]
    const row = token === undefined ? undefined : sessions.get(token)
    const self = row?.user
    // The form posts to the bare path (no query string), so on POST the target
    // arrives in the BODY; the query only carries it on the GET link.
    let body
    if (req.method === 'POST') {
      try {
        body = await decodeBody(req)
      } catch {
        body = undefined
      }
    }
    const target = (typeof body?.user === 'string' ? body.user : undefined)
      ?? url.searchParams.get('user')
      ?? ''
    const fail = (status, message, submitted) => html(res, status, renderUserModelsPage({
      user: target,
      port: 0,
      running: false,
      providers: [],
      defaultModel: undefined,
      error: message,
      form: submitted,
    }))
    if (self === undefined) {
      res.writeHead(302, {
        location: `${LOGIN_PATH}?next=${encodeURIComponent(`${USER_MODELS_PATH}?user=${encodeURIComponent(target)}`)}`,
        'cache-control': 'no-store',
      })
      res.end()
      return
    }
    if (!isAdmin(self)) { fail(403, '仅管理员可以配置用户模型'); return }
    if (!isSafeUsername(target)) { fail(400, ERRORS.invalidUsername); return }
    let exists
    try {
      exists = (await db.findByUsername(target)) !== undefined
    } catch (err) {
      fail(503, `数据库暂不可用：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!exists) { fail(404, '用户不存在'); return }
    if (isAdmin(target)) { fail(400, '管理员直接使用 hub，没有独立环境'); return }

    if (req.method === 'POST') {
      // The body was decoded above, before the target could be read from it.
      if (body === undefined) { fail(400, ERRORS.badBody); return }
      if (!originMatchesHost(req.headers.origin, req.headers.host)) { fail(403, ERRORS.badOrigin, body); return }
      const parsed = validateModelConfig(body)
      if (!parsed.ok) { fail(400, parsed.error, body); return }
      try {
        const port = await ensureUserInstance(target)
        knownPorts.set(target, port)
        await applyModelConfig((method, args) => instanceRpc(port, method, args), parsed.value)
      } catch (err) {
        fail(503, `写入失败：${err instanceof Error ? err.message : String(err)}`, body)
        return
      }
      res.writeHead(303, {
        location: `${USER_MODELS_PATH}?user=${encodeURIComponent(target)}&ok=${encodeURIComponent(`已写入 provider ${parsed.value.providerId}（模型 ${parsed.value.modelId}）`)}`,
        'cache-control': 'no-store',
      })
      res.end()
      return
    }

    const record = (await manager().listUsers()).find((candidate) => candidate.username === target)
    const port = record?.port ?? 0
    const running = record?.running ?? false
    let providers = []
    let defaultModel
    let readError
    if (running && port > 0) {
      try {
        const describe = await instanceRpc(port, 'settings/describe', {})
        ;({ providers, defaultModel } = summarizeModelConfig(describe))
      } catch (err) {
        readError = `读取当前模型配置失败：${err instanceof Error ? err.message : String(err)}`
      }
    } else {
      readError = '该用户的实例当前未运行，下面只显示表单；保存时会自动（重新）启动它。'
    }
    html(res, 200, renderUserModelsPage({
      user: target,
      port,
      running,
      providers,
      defaultModel,
      error: url.searchParams.get('error') ?? undefined,
      ok: url.searchParams.get('ok') ?? undefined,
      readError,
    }))
  }

  const handleAuthRoute = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    try {
      if (path === LOGIN_PATH && req.method === 'GET') {
        const next = safeNext(url.searchParams.get('next'), '/', absoluteNextAllowed(cfg.instances.portBase))
        html(res, 200, loginPage({
          next,
          registerOpen: cfg.register === 'open',
          mode: url.searchParams.get('mode') === 'register' && cfg.register === 'open' ? 'register' : 'login',
          notice: url.searchParams.get('registered') === 'pending' ? ERRORS.registeredPending : '',
        }))
        return
      }
      if (path === STATE_PATH && req.method === 'GET') {
        const token = parseCookies(req.headers.cookie)[COOKIE_NAME]
        const row = token === undefined ? undefined : sessions.get(token)
        const user = row?.user
        let instanceInfo
        if (user !== undefined && !isAdmin(user)) {
          const port = knownPorts.get(user)
          if (port !== undefined) {
            instanceInfo = { port, running: await manager().probe(port) }
          }
        }
        json(res, 200, {
          authenticated: row !== undefined,
          // `admin` is what the browser half reads to decide whether to
          // contribute the right-Sidebar user-management entry.
          ...(user === undefined ? {} : { username: user, admin: isAdmin(user) }),
          db: await db.health(),
          register: cfg.register,
          ...(instanceInfo === undefined ? {} : { instance: instanceInfo }),
        })
        return
      }
      if (path === HEALTH_PATH && req.method === 'GET') {
        json(res, 200, { ok: true, db: await db.health() })
        return
      }
      if (path === LOGOUT_PATH && (req.method === 'GET' || req.method === 'POST')) {
        const token = parseCookies(req.headers.cookie)[COOKIE_NAME]
        sessions.drop(token)
        // Full logout: also clear the inner browser cookies, so a tab left open
        // on an instance does not stay logged in behind the operator's back.
        // Cookies are keyed by (name, domain, path) and NOT by port, so a clear
        // issued here reaches the cookies an instance set on another port.
        const cookies = [clearCookieHeader(COOKIE_NAME)]
        const hostNoPort = hostNoPortOf(req.headers.host)
        if (hostNoPort !== undefined) {
          cookies.push(clearCookieHeader(innerCookieName(`${hostNoPort}:${String(hubPort())}`)))
          // One per provisioned user; capped so a large deployment cannot emit
          // an unbounded Set-Cookie list (browsers cap cookies per host).
          const MAX_CLEARED_INSTANCES = 60
          const users = await manager().listUsers()
          for (const rec of users.slice(0, MAX_CLEARED_INSTANCES)) {
            if (Number.isInteger(rec.port) && rec.port > 0) {
              cookies.push(clearCookieHeader(innerCookieName(`${hostNoPort}:${String(rec.port)}`)))
            }
          }
        }
        res.writeHead(302, {
          location: ERRORS.logoutRedirect,
          'set-cookie': cookies,
          'cache-control': 'no-store',
        })
        res.end()
        return
      }
      if (path === LOGIN_PATH && req.method === 'POST') {
        await handleLogin(req, res)
        return
      }
      if (path === REGISTER_PATH && req.method === 'POST') {
        await handleRegister(req, res)
        return
      }
      if (path === ACCOUNT_PATH && req.method === 'GET') {
        const token = parseCookies(req.headers.cookie)[COOKIE_NAME]
        const row = token === undefined ? undefined : sessions.get(token)
        const user = row?.user
        if (user === undefined) {
          res.writeHead(302, {
            location: `${LOGIN_PATH}?next=${encodeURIComponent(ACCOUNT_PATH)}`,
            'cache-control': 'no-store',
          })
          res.end()
          return
        }
        const admin = isAdmin(user)
        let port = 0
        let running
        if (!admin) {
          port = knownPorts.get(user) ?? 0
          if (port > 0) running = await manager().probe(port)
        }
        html(res, 200, renderAccountPage({
          mode: 'hub',
          username: user,
          admin,
          port,
          running,
          instanceHost: hostNoPortOf(req.headers.host) ?? '127.0.0.1',
        }))
        return
      }
      if (path === USERS_PATH && req.method === 'GET') {
        const token = parseCookies(req.headers.cookie)[COOKIE_NAME]
        const row = token === undefined ? undefined : sessions.get(token)
        const user = row?.user
        if (user === undefined) {
          res.writeHead(302, {
            location: `${LOGIN_PATH}?next=${encodeURIComponent(USERS_PATH)}`,
            'cache-control': 'no-store',
          })
          res.end()
          return
        }
        const instanceHost = hostNoPortOf(req.headers.host) ?? '127.0.0.1'
        if (!isAdmin(user)) {
          html(res, 403, renderUsersPage({ users: [], self: user, instanceHost, error: '仅管理员可以访问用户管理' }))
          return
        }
        let accounts
        try {
          accounts = await db.listUsers()
        } catch (err) {
          html(res, 503, renderUsersPage({ users: [], self: user, instanceHost, error: `数据库暂不可用：${err instanceof Error ? err.message : String(err)}` }))
          return
        }
        const mgrUsers = await manager().listUsers()
        const byName = new Map(mgrUsers.map((m) => [m.username, m]))
        const merged = accounts.map((r) => {
          const rec = byName.get(r.username)
          return {
            username: r.username,
            admin: isAdmin(r.username),
            status: typeof r.status === 'string' ? r.status : 'approved',
            modelSelfService: policyFromColumn(r.model_self_service),
            port: rec?.port ?? 0,
            running: rec?.running ?? false,
            createdAt: fmtTs(r.created_at),
            lastLoginAt: r.last_login_at ? fmtTs(r.last_login_at) : undefined,
          }
        })
        html(res, 200, renderUsersPage({ users: merged, self: user, instanceHost }))
        return
      }
      if (path === ENTER_PATH && (req.method === 'GET' || req.method === 'POST')) {
        await handleEnter(req, res, url)
        return
      }
      if (path === USERS_DELETE_PATH && req.method === 'POST') {
        await handleUserDelete(req, res)
        return
      }
      if (path === USERS_STATUS_PATH && req.method === 'POST') {
        await handleUserStatus(req, res)
        return
      }
      if (path === USERS_MODEL_POLICY_PATH && req.method === 'POST') {
        await handleUserModelPolicy(req, res)
        return
      }
      if (path === USER_MODELS_PATH && (req.method === 'GET' || req.method === 'POST')) {
        await handleUserModels(req, res, url)
        return
      }
      json(res, 404, { error: 'not found' })
    } catch (err) {
      ctx.logger?.warn?.(err instanceof Error ? err : new Error(String(err)))
      if (!res.headersSent) json(res, 500, { error: 'internal error' })
      else res.end()
    }
  }

  ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-login',
    handler: (req, res) => {
      handleAuthRoute(req, res).catch(() => {
        if (!res.headersSent) {
          json(res, 500, { error: 'internal error' })
          return
        }
        res.end()
      })
    },
  })

  ensureInnerSecret()
  void db.ensureTable()
    .then(() => {
      console.log(
        `dsh-login: hub gate active; db=${cfg.db.host}:${String(cfg.db.port)}/${cfg.db.database} table=${cfg.db.table}; `
        + `register=${cfg.register}; admins=${cfg.adminUsers.length > 0 ? cfg.adminUsers.join(',') : '(none)'}; `
        + `instances=${cfg.instances.root} (portBase ${String(cfg.instances.portBase)}); cidrs=${cfg.allowCidrs.join(',')}`,
      )
    })
    .catch((err) => {
      console.error(
        `dsh-login: database unreachable at startup (${err instanceof Error ? err.message : String(err)}); `
        + 'login and register will fail until it is reachable',
      )
    })
}

/**
 * Instance mode: the gate of one dedicated per-user dsh web.
 *
 * No database, no session store. The only credential is the built-in
 * browser-session cookie (shared signing secret, per-authority binding).
 * Unauthenticated users are sent to the hub's login page with their current
 * URL as `next`; the hub hands them back with a short-lived, single-use
 * handoff token which this gate converts into a regular long-lived cookie.
 */
function applyInstance(ctx, home, cfg) {
  const cidrs = parseCidrList(cfg.allowCidrs)
  const instanceHealthPath = '/dsh-login/health'
  const instanceStatePath = '/dsh-login/state'
  const instanceLogoutPath = '/dsh-login/logout'
  /** User self-service: the models page and its JSON actions. */
  const myModelsPath = '/dsh-login/models'
  const myModelsDeletePath = '/dsh-login/models/delete'
  const myModelsDefaultPath = '/dsh-login/models/default'
  const myModelsListOfPath = '/dsh-login/models/models-of'
  let innerSecret = undefined
  const innerSecretReady = readInnerSecret(ctx.credentials)
    .then((secret) => {
      innerSecret = secret
      if (secret === undefined) {
        console.error('dsh-login: instance mode: no browser-session secret found; cannot validate requests')
      }
      return secret
    })
    .catch(() => undefined)

  /**
   * One read/write against THIS instance's own /api, over loopback.
   *
   * The same mechanism the hub uses against user instances (instanceRpc),
   * turned on itself: a minted inner cookie for the loopback authority plus
   * the standard client-request envelope. The gate and the built-in
   * BrowserAuth both accept it (same shared secret, same audience), so the
   * self-service Models page goes through DSH's validated write API instead
   * of touching the settings files directly.
   * @param method - Typert Remote method (e.g. `settings/mutate`).
   * @param args - plain-object argument map.
   * @returns the successful result value.
   * @throws when the token cannot be minted, HTTP fails, or the instance refuses.
   */
  const selfRpc = async (method, args) => {
    if (innerSecret === undefined) await innerSecretReady
    if (innerSecret === undefined) throw new Error('无法生成本实例访问令牌（签名密钥不可用）')
    if (!cfg.port) throw new Error('实例端口未知（dsh-login.json 未写 port），无法写入本地设置')
    const authority = `127.0.0.1:${String(cfg.port)}`
    const minted = mintInnerCookie(innerSecret, authority, INNER_MAX_AGE_DAYS)
    const res = await fetch(`http://${authority}/api/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${minted.name}=${minted.value}`,
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `self-${String(Date.now())}`,
        method,
        payload: { args },
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`本实例接口返回 HTTP ${String(res.status)}`)
    const envelope = await res.json()
    const result = envelope?.result
    if (result?.ok !== true) throw new Error(result?.error?.message ?? '本实例拒绝了该操作')
    return result.value
  }

  /**
   * The models page's read half: the provider directory plus the current
   * default selection, with each named credential reference's stored state.
   * A describe failure degrades to a banner (readError) rather than a blank
   * page: the add form stays usable.
   * @returns `{providers, defaultModel, readError}` — providers enriched with
   *   `keyConfigured` (boolean | undefined) for rows naming a reference.
   */
  const readMyModels = async () => {
    try {
      const describe = await selfRpc('settings/describe', {})
      const { providers, defaultModel } = summarizeModelConfig(describe)
      const named = providers.filter((p) => typeof p.apiKeyEnv === 'string' && p.apiKeyEnv !== '')
      if (named.length > 0) {
        const creds = await selfRpc('credentials/describe', { refs: named.map((p) => p.apiKeyEnv) })
        for (const p of named) {
          const info = creds?.[p.apiKeyEnv]
          p.keyConfigured = info?.configured === true
        }
      }
      return { providers, defaultModel, readError: undefined }
    } catch (err) {
      return {
        providers: [],
        defaultModel: undefined,
        readError: `读取当前模型配置失败：${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  // Single-use registry for accepted handoff tokens (sha256 of the token).
  const consumed = new Map()
  const handoffSeen = (value) => {
    const key = createHash('sha256').update(value).digest('hex')
    const now = Date.now()
    if (consumed.size > 2000) {
      for (const [k, exp] of consumed) if (exp < now) consumed.delete(k)
    }
    if (consumed.has(key)) return true
    consumed.set(key, now + cfg.handoffTtlSec * 1000 + 60_000)
    return false
  }

  const innerOk = (req) => {
    if (innerSecret === undefined) return false
    const authority = requestAuthority(req.headers.host)
    if (authority === undefined) return false
    const value = parseCookies(req.headers.cookie)[innerCookieName(authority)]
    return value !== undefined && verifyInnerCookie(value, innerSecret, authority, INNER_MAX_AGE_MS)
  }

  /** Absolute URL of this request, for handing `next` back to the hub. */
  const absUrlOf = (req) => {
    const authority = requestAuthority(req.headers.host)
    if (authority === undefined) return undefined
    return `http://${authority}${req.url ?? '/'}`
  }
  const hubLoginUrl = (req) => {
    const abs = absUrlOf(req)
    return `${cfg.hubBase}dsh-login/login${abs !== undefined ? `?next=${encodeURIComponent(abs)}` : ''}`
  }

  /** A handoff token must carry the short lifetime the hub minted. */
  const isShortLived = (value) => {
    const payload = decodeInnerPayload(value)
    return payload !== undefined
      && payload.expiresAt - payload.issuedAt <= (cfg.handoffTtlSec + 5) * 1000
  }

  const decide = (req) => {
    const peer = normalizePeerIp(req.socket?.remoteAddress)
    if (peer === undefined) return { ok: false, reason: 'no-peer', status: 403 }
    if (cfg.rejectProxyHeaders) {
      const bad = requestHasProxyHeaders(req)
      if (bad.length > 0) return { ok: false, reason: `proxy-headers ${bad.join(',')}`, status: 403 }
    }
    if (!isLoopbackPeer(peer) && (peer.kind !== 'v4' || !ipv4InCidrs(peer.text, cidrs))) {
      return { ok: false, reason: `cidr ${peer.text}`, status: 403 }
    }
    const path = pathnameOf(req)
    if (path === instanceHealthPath || path === instanceStatePath || path === instanceLogoutPath) {
      return { ok: true, reason: 'instance-path', peer }
    }
    if (innerOk(req)) return { ok: true, reason: 'inner', peer }
    let isHandoff = false
    if (req.method === 'GET' || req.method === 'HEAD') {
      try {
        isHandoff = new URL(req.url ?? '/', 'http://x').searchParams.has('handoff')
      } catch {
        isHandoff = false
      }
    }
    if (isHandoff) return { ok: true, reason: 'handoff', peer }
    if (req.method === 'GET' || req.method === 'HEAD') {
      return { ok: false, reason: 'auth', peer, status: 401, redirect: hubLoginUrl(req) }
    }
    return { ok: false, reason: 'auth', peer, status: 401 }
  }

  /**
   * Verify a handoff token and convert it into a regular long-lived browser
   * cookie for this authority (the token itself is a one-shot minting
   * authorization and is never stored as a cookie).
   */
  const handleHandoff = async (req, res) => {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://x')
    } catch {
      res.writeHead(302, { location: cfg.hubBase + 'dsh-login/login', 'cache-control': 'no-store' })
      res.end()
      return
    }
    const values = url.searchParams.getAll('handoff')
    const authority = requestAuthority(req.headers.host)
    // Accept the first value that verifies as a fresh, short-lived handoff
    // (older consumed values that may trail in the URL are skipped).
    let accepted = false
    for (const value of values) {
      if (innerSecret === undefined || authority === undefined) break
      const ok = verifyInnerCookie(value, innerSecret, authority, INNER_MAX_AGE_MS)
        && isShortLived(value)
        && !handoffSeen(value)
      if (ok) { accepted = true; break }
    }
    if (!accepted) {
      res.writeHead(302, { location: hubLoginUrl(req), 'cache-control': 'no-store' })
      res.end()
      return
    }
    const minted = mintInnerCookie(innerSecret, authority, INNER_MAX_AGE_DAYS)
    const clean = new URLSearchParams(url.search)
    clean.delete('handoff')
    const search = clean.toString()
    const location = `${url.pathname}${search === '' ? '' : `?${search}`}` || '/'
    res.writeHead(303, {
      location,
      'set-cookie': innerCookieHeader(minted),
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    })
    res.end()
  }

  ctx.effect(() => {
    const server = ctx.webServer.server
    const current = server.listeners('request')
    server.removeAllListeners('request')
    server.on('request', (req, res) => {
      const verdict = decide(req)
      if (verdict.ok && verdict.reason === 'handoff') {
        handleHandoff(req, res).catch(() => {
          if (!res.headersSent) {
            res.writeHead(302, { location: cfg.hubBase + 'dsh-login/login', 'cache-control': 'no-store' })
            res.end()
            return
          }
          res.end()
        })
        return
      }
      if (!verdict.ok) {
        const path = pathnameOf(req)
        if (verdict.redirect !== undefined && (req.method === 'GET' || req.method === 'HEAD') && !path.startsWith('/api/')) {
          res.writeHead(302, { location: verdict.redirect, 'cache-control': 'no-store' })
          res.end()
          return
        }
        if (path.startsWith('/api/')) {
          json(res, verdict.status ?? 401, { error: 'unauthorized' })
          return
        }
        deny(res, verdict.reason, verdict.status ?? 403)
        return
      }
      for (const listener of current) listener.call(server, req, res)
    })
    const upgrades = server.listeners('upgrade')
    server.removeAllListeners('upgrade')
    server.on('upgrade', (req, socket, head) => {
      const verdict = decide(req)
      if (!verdict.ok || verdict.reason !== 'inner') {
        socket.write(`HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n`)
        socket.destroy()
        return
      }
      // `head` MUST be forwarded. The WebSocket server writes the 101 response
      // and then drains any bytes already buffered after the upgrade headers
      // from `head`; passing undefined makes that step throw *after* the
      // handshake, and the HTTP layer then destroys the socket — so the GUI's
      // live event stream would connect and immediately die (permanent
      // "reconnecting"). The hub never installs this instance-mode wrapper,
      // which is why only user instances were affected.
      for (const listener of upgrades) listener.call(server, req, socket, head)
    })
    return () => {
      server.removeAllListeners('request')
      for (const listener of current) server.on('request', listener)
      server.removeAllListeners('upgrade')
      for (const listener of upgrades) server.on('upgrade', listener)
    }
  })

  const handleInstanceRoute = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    if (path === instanceHealthPath && req.method === 'GET') {
      // `identity` is a hash of this instance's DSH_HOME. The hub compares it
      // with the home it provisioned, so a stale process whose directory was
      // replaced is detected instead of being reused (which would leave the
      // GUI pointing at a home that no longer exists).
      const identity = createHash('sha256').update(home, 'utf8').digest('hex').slice(0, 16)
      json(res, 200, { ok: true, instance: true, identity })
      return
    }
    if (path === instanceStatePath && req.method === 'GET') {
      json(res, 200, { authenticated: innerOk(req), instance: true })
      return
    }
    if (path === instanceLogoutPath && (req.method === 'GET' || req.method === 'POST')) {
      const authority = requestAuthority(req.headers.host)
      res.writeHead(302, {
        // Logging out of an instance must not leave the hub session alive:
        // clearing only this instance's cookie would bounce the user back to a
        // hub login page that still reports "已登录", because the hub session
        // and the instance cookie are two independent sessions. Chain to the
        // hub's logout so it also drops the session-store entry and its cookie.
        location: `${cfg.hubBase}dsh-login/logout`,
        ...(authority === undefined ? {} : { 'set-cookie': clearCookieHeader(innerCookieName(authority)) }),
        'cache-control': 'no-store',
      })
      res.end()
      return
    }
    if (path === ACCOUNT_PATH && req.method === 'GET') {
      html(res, 200, renderAccountPage({
        mode: 'instance',
        port: cfg.port,
        allowSelfService: await readModelPolicy(home),
      }))
      return
    }

    // ---- user self-service: the models page (own instance, own cookie) ----
    // Admission already required this instance's inner cookie (decide()), so
    // only the logged-in user (or an administrator acting as them, the
    // documented trust-model exception) reaches these handlers.
    //
    // The whole surface additionally honours the administrator's per-user
    // switch, mirrored into this DSH_HOME by the hub (lib/model-policy.js):
    // without an explicit grant the endpoint is CLOSED — GET answers a 403
    // "closed by the administrator" page and every write/JSON route refuses.
    // Missing mirror file = denied, so an upgraded instance grants nothing.
    if (path === myModelsPath && req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!(await readModelPolicy(home))) {
        html(res, 403, renderModelsClosedPage({ port: cfg.port }))
        return
      }
      const { providers, defaultModel, readError } = await readMyModels()
      html(res, 200, renderMyModelsPage({
        port: cfg.port,
        providers,
        defaultModel,
        ok: url.searchParams.get('ok'),
        readError,
      }))
      return
    }
    if (path === myModelsPath && req.method === 'POST') {
      // The switch is checked first: a closed endpoint must not validate,
      // echo, or otherwise touch anything.
      if (!(await readModelPolicy(home))) {
        html(res, 403, renderModelsClosedPage({ port: cfg.port }))
        return
      }
      let body
      try {
        body = await decodeBody(req)
      } catch {
        body = undefined
      }
      const echoForm = body === undefined ? {} : {
        kind: body.kind,
        presetId: body.presetId,
        providerId: body.providerId,
        displayName: body.displayName,
        api: body.api,
        baseURL: body.baseURL,
        models: body.models,
        setDefault: body.setDefault,
        defaultModel: body.defaultModel,
      }
      // Validate BEFORE touching the settings: a refused request (bad body,
      // cross-origin) must have no side effects at all.
      if (body === undefined) {
        html(res, 400, renderMyModelsPage({
          port: cfg.port, providers: [], defaultModel: undefined,
          error: ERRORS.badBody, form: echoForm,
        }))
        return
      }
      if (!originMatchesHost(req.headers.origin, req.headers.host)) {
        html(res, 403, renderMyModelsPage({
          port: cfg.port, providers: [], defaultModel: undefined,
          error: ERRORS.badOrigin, form: echoForm,
        }))
        return
      }
      const { providers, defaultModel, readError } = await readMyModels()
      const fail = (status, error) => {
        html(res, status, renderMyModelsPage({
          port: cfg.port, providers, defaultModel, readError, error, form: echoForm,
        }))
      }
      // Overwrite semantics need the CURRENT profile at the target route: a
      // blank key must keep an existing credential reference (the DSH-native
      // derivation rule), which only the stored profile knows.
      const pidCandidate = typeof body.presetId === 'string' && body.presetId !== ''
        ? body.presetId
        : typeof body.providerId === 'string' ? body.providerId : ''
      const existing = pidCandidate === ''
        ? undefined
        : providers.find((p) => p.id === pidCandidate.trim())
      const parsed = validateMyModels(body, existing)
      if (!parsed.ok) { fail(400, parsed.error); return }
      // Best effort: a preset's chosen default must sit in the installed
      // catalog (the local read the plugin answers without a network call);
      // a catalog-read failure never blocks an explicit user choice.
      if (body.kind === 'preset' && parsed.value.setDefault !== undefined) {
        try {
          const models = await selfRpc('llm/discoverModels', {
            settingsNs: 'llm-pi-ai',
            request: { provider: parsed.value.providerId },
          })
          if (Array.isArray(models) && models.length > 0
            && !models.some((m) => m?.id === parsed.value.setDefault.model)) {
            fail(400, `默认模型 ${parsed.value.setDefault.model} 不在 ${parsed.value.providerId} 的模型目录内`)
            return
          }
        } catch {
          // keep the user's explicit choice
        }
      }
      try {
        await applyMyModels(selfRpc, parsed.value)
      } catch (err) {
        fail(503, `写入失败：${err instanceof Error ? err.message : String(err)}`)
        return
      }
      res.writeHead(303, {
        location: `${myModelsPath}?ok=${encodeURIComponent(`已保存 provider ${parsed.value.providerId}`)}`,
        'cache-control': 'no-store',
      })
      res.end()
      return
    }
    if (path === myModelsDeletePath && req.method === 'POST') {
      let body
      try {
        body = await decodeBody(req)
      } catch {
        body = undefined
      }
      if (body === undefined) { json(res, 400, { error: ERRORS.badBody }); return }
      if (!originMatchesHost(req.headers.origin, req.headers.host)) { json(res, 403, { error: ERRORS.badOrigin }); return }
      if (!(await readModelPolicy(home))) { json(res, 403, { error: ERRORS.modelPolicyDenied }); return }
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (!isProviderId(id)) { json(res, 400, { error: 'provider 标识不合法' }); return }
      const { providers } = await readMyModels()
      const existing = providers.find((p) => p.id === id)
      if (existing === undefined) { json(res, 200, { ok: true, removed: false }); return }
      try {
        await applyMyModelDelete(selfRpc, id, existing)
      } catch (err) {
        json(res, 503, { error: err instanceof Error ? err.message : String(err) })
        return
      }
      json(res, 200, { ok: true, removed: true })
      return
    }
    if (path === myModelsDefaultPath && req.method === 'POST') {
      let body
      try {
        body = await decodeBody(req)
      } catch {
        body = undefined
      }
      if (body === undefined) { json(res, 400, { error: ERRORS.badBody }); return }
      if (!originMatchesHost(req.headers.origin, req.headers.host)) { json(res, 403, { error: ERRORS.badOrigin }); return }
      if (!(await readModelPolicy(home))) { json(res, 403, { error: ERRORS.modelPolicyDenied }); return }
      const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
      const model = typeof body.model === 'string' ? body.model.trim() : ''
      if (!isProviderId(provider) || model === '' || model.length > 200) {
        json(res, 400, { error: 'provider 或模型 ID 不合法' })
        return
      }
      const { providers } = await readMyModels()
      if (!providers.some((p) => p.id === provider)) {
        json(res, 400, { error: `provider ${provider} 尚未配置：请先添加` })
        return
      }
      try {
        await selfRpc('settings/mutate', {
          ns: 'agent-default-model',
          ops: setDefaultOps(provider, model),
          expectedRevision: undefined,
        })
      } catch (err) {
        json(res, 503, { error: err instanceof Error ? err.message : String(err) })
        return
      }
      json(res, 200, { ok: true })
      return
    }
    if (path === myModelsListOfPath && req.method === 'GET') {
      if (!(await readModelPolicy(home))) { json(res, 403, { error: ERRORS.modelPolicyDenied }); return }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const id = url.searchParams.get('id') ?? ''
      if (!isProviderId(id)) { json(res, 400, { error: 'provider 标识不合法' }); return }
      try {
        const models = await selfRpc('llm/discoverModels', {
          settingsNs: 'llm-pi-ai',
          request: { provider: id },
        })
        const list = (Array.isArray(models) ? models : [])
          .filter((m) => typeof m?.id === 'string' && m.id !== '')
          .map((m) => ({ id: m.id, ...(typeof m.name === 'string' && m.name !== '' ? { name: m.name } : {}) }))
        json(res, 200, { ok: true, models: list })
      } catch (err) {
        json(res, 503, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }
    json(res, 404, { error: 'not found' })
  }

  ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-login',
    handler: (req, res) => {
      handleInstanceRoute(req, res).catch(() => {
        if (!res.headersSent) {
          json(res, 500, { error: 'internal error' })
          return
        }
        res.end()
      })
    },
  })

  console.log(`dsh-login: instance gate active (home=${home}); hub=${cfg.hubBase}; cidrs=${cfg.allowCidrs.join(',')}`)
}
