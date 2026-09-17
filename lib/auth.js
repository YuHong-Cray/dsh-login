/**
 * dsh-login — password hashing, session store, login rate limiter, and cookie
 * helpers. Self-contained node:crypto + node:fs implementation (pattern
 * inherited from dsh-lan-gate, MIT).
 *
 * Passwords never touch the database in clear text: the dsh-login table
 * stores only the scrypt verifier (N=16384, r=8, p=1, 16-byte random salt,
 * 32-byte key). Session tokens are stored hashed (sha256) on disk so the
 * persisted session file leaking does not reveal live tokens.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const COOKIE_NAME = 'dsh_db_sess'

const KEYLEN = 32
const N = 16384
const R = 8
const P = 1

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new Error('password must be between 8 and 128 characters')
  }
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

export function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false
  const parts = encoded.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  if (n < 16384 || n > (1 << 20) || r < 1 || p < 1) return false
  let salt
  let expected
  try {
    salt = Buffer.from(parts[4], 'base64url')
    expected = Buffer.from(parts[5], 'base64url')
  } catch {
    return false
  }
  if (salt.length < 16 || expected.length < 16) return false
  const actual = scryptSync(password, salt, expected.length, { N: n, r, p })
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

export function newSessionToken() {
  return randomBytes(32).toString('base64url')
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

export function parseCookies(header) {
  const out = Object.create(null)
  if (typeof header !== 'string' || header.length === 0) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    try {
      out[key] = decodeURIComponent(value)
    } catch {
      out[key] = value
    }
  }
  return out
}

export function cookieHeader(name, value, { maxAgeSec, httpOnly = true, sameSite = 'Strict', path = '/' } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`]
  if (httpOnly) bits.push('HttpOnly')
  if (Number.isFinite(maxAgeSec)) bits.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`)
  return bits.join('; ')
}

export function clearCookieHeader(name) {
  return `${name}=; Path=/; Max-Age=0; SameSite=Strict; HttpOnly`
}

export function originMatchesHost(origin, host) {
  if (typeof origin !== 'string' || origin.length === 0) return true
  if (typeof host !== 'string' || host.length === 0) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Per-IP failed-attempt limiter for the login and register endpoints. */
export class LoginLimiter {
  constructor({ windowMs = 15 * 60_000, maxFails = 10 } = {}) {
    this.windowMs = windowMs
    this.maxFails = maxFails
    this.hits = new Map()
  }

  allow(ip) {
    const now = Date.now()
    const row = this.hits.get(ip)
    if (row === undefined || now - row.start >= this.windowMs) {
      this.hits.set(ip, { start: now, fails: 0 })
      return true
    }
    return row.fails < this.maxFails
  }

  fail(ip) {
    const now = Date.now()
    const row = this.hits.get(ip)
    if (row === undefined || now - row.start >= this.windowMs) {
      this.hits.set(ip, { start: now, fails: 1 })
      return
    }
    row.fails += 1
  }

  succeed(ip) {
    this.hits.delete(ip)
  }
}

/**
 * Token session store: in-memory map plus a 0600 JSON persistence file so
 * sessions survive a `dsh web` restart. Tokens are stored by sha256 hash.
 */
export class SessionStore {
  constructor({ ttlSec = 7 * 24 * 3600, persistPath } = {}) {
    this.ttlSec = ttlSec
    this.persistPath = persistPath
    this.sessions = new Map()
    this.#load()
  }

  #load() {
    if (this.persistPath === undefined) return
    let parsed
    try {
      parsed = JSON.parse(readFileSync(this.persistPath, 'utf8'))
    } catch (err) {
      if (err && err.code === 'ENOENT') return
      throw new Error(`dsh-login: session store ${this.persistPath} is unreadable: ${err.message}`)
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sessions)) return
    const now = Date.now()
    for (const row of parsed.sessions) {
      if (typeof row?.id !== 'string' || typeof row.exp !== 'number') continue
      if (row.exp > now) this.sessions.set(row.id, { exp: row.exp, user: typeof row.user === 'string' ? row.user : undefined })
    }
  }

  #save() {
    if (this.persistPath === undefined) return
    const now = Date.now()
    const sessions = []
    for (const [id, row] of this.sessions) {
      if (row.exp > now) sessions.push({ id, exp: row.exp, ...(row.user === undefined ? {} : { user: row.user }) })
    }
    mkdirSync(dirname(this.persistPath), { recursive: true })
    writeFileSync(this.persistPath, `${JSON.stringify({ version: 2, sessions }, null, 2)}\n`, { mode: 0o600 })
  }

  /** Issue a session; returns the raw token (only the hash is stored). */
  issue(user) {
    const token = newSessionToken()
    const id = hashToken(token)
    const exp = Date.now() + this.ttlSec * 1000
    this.sessions.set(id, { exp, ...(user === undefined ? {} : { user }) })
    this.#save()
    return token
  }

  get(token) {
    if (typeof token !== 'string' || token.length < 16) return undefined
    const id = hashToken(token)
    const row = this.sessions.get(id)
    if (row === undefined) return undefined
    if (row.exp <= Date.now()) {
      this.sessions.delete(id)
      this.#save()
      return undefined
    }
    return row
  }

  drop(token) {
    if (typeof token !== 'string') return
    this.sessions.delete(hashToken(token))
    this.#save()
  }
}

/** Header names that betray a forwarding proxy; the gate refuses them. */
export const PROXY_HEADER_NAMES = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'forwarded',
  'via',
  'true-client-ip',
  'cf-connecting-ip',
  'x-cluster-client-ip',
]

export function requestHasProxyHeaders(req) {
  const headers = req.headers ?? {}
  return PROXY_HEADER_NAMES.filter((name) => {
    const value = headers[name]
    return value !== undefined && value !== ''
  })
}
