/**
 * dsh-login — bridge to the Web GUI's built-in browser-session gate.
 *
 * The DSH web server authenticates the app itself (client-connection's
 * BrowserAuth): the launch-token URL mints an HttpOnly cookie whose value is
 * a versioned, HMAC-SHA256-signed payload, and the cookie name is derived
 * from the request authority. Without that cookie the app answers 401 even
 * after our gate is satisfied.
 *
 * This module reproduces the wire format byte for byte (v1 payload
 * {version, authority, issuedAt, expiresAt}; signing secret read from the
 * Harness credentials service under the client-connection/browser-session
 * record, the same secret BrowserAuth loads at startup) so a user who
 * authenticated against the dsh-login table can also pass the inner gate —
 * no launch-token URL required. The bridge mints one cookie per request
 * authority, so the same account works from loopback and from any LAN name.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const AUTH_RECORD_KEY = 'client-connection/browser-session'
const COOKIE_PREFIX = 'dsh-auth-'
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const SECRET_BYTES = 32
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value) {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The canonical request authority from a Host header (e.g. `10.0.0.50:3080`). */
export function requestAuthority(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return undefined
  try {
    return new URL(`http://${hostHeader}`).host
  } catch {
    return undefined
  }
}

/** The generated cookie name for one authority (sha256-bound, cookie-safe). */
export function innerCookieName(authority) {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

/**
 * Read the browser-session signing secret through the credentials service.
 * @param credentials - the ctx.credentials provider.
 * @returns the 32-byte secret Buffer, or undefined when no record is stored.
 */
export async function readInnerSecret(credentials) {
  let record
  try {
    record = await credentials.readRecord(AUTH_RECORD_KEY)
  } catch {
    return undefined
  }
  if (record === undefined || record.kind !== 'grant' || !isRecord(record.payload)) return undefined
  if (record.payload.version !== 1) return undefined
  const secret = decodeBase64Url(typeof record.payload.secret === 'string' ? record.payload.secret : '')
  if (secret === undefined || secret.length !== SECRET_BYTES) return undefined
  return secret
}

/**
 * Mint one inner-session cookie value for an authority.
 * @param secret - the 32-byte browser-session signing secret.
 * @param authority - canonical request authority (Host).
 * @param maxAgeDays - absolute cookie lifetime in days (the inner gate's default is 30).
 * @returns {name, value, maxAgeSec, expiresAt} for a Set-Cookie header.
 */
export function mintInnerCookie(secret, authority, maxAgeDays = 30) {
  const now = Date.now()
  const issuedAt = now
  const expiresAt = now + maxAgeDays * DAY_MILLISECONDS
  const body = encodeBase64Url(Buffer.from(JSON.stringify({
    version: 1,
    authority,
    issuedAt,
    expiresAt,
  }), 'utf8'))
  const signature = encodeBase64Url(createHmac('sha256', secret).update(body).digest())
  const value = `v1.${body}.${signature}`
  return {
    name: innerCookieName(authority),
    value,
    maxAgeSec: maxAgeDays * 86400,
    expiresAt,
  }
}

/** Serialize an inner cookie exactly like the built-in gate does. */
export function innerCookieHeader(minted) {
  return [
    `${minted.name}=${minted.value}`,
    `Max-Age=${String(minted.maxAgeSec)}`,
    'Path=/',
    `Expires=${new Date(minted.expiresAt).toUTCString()}`,
    'HttpOnly',
    'SameSite=Strict',
  ].join('; ')
}

/**
 * Mint one short-lived handoff token: byte-identical cookie format to
 * {@link mintInnerCookie} but with a seconds-granularity lifetime, for the
 * hub → per-user instance handoff (the instance verifies it, then mints a
 * regular long-lived cookie for the same authority).
 * @param secret - the 32-byte browser-session signing secret.
 * @param authority - canonical request authority (Host) of the target instance.
 * @param ttlSec - token lifetime in seconds.
 * @returns {name, value, maxAgeSec, expiresAt} for a URL parameter / Set-Cookie.
 */
export function mintHandoffToken(secret, authority, ttlSec) {
  const now = Date.now()
  const issuedAt = now
  const expiresAt = now + ttlSec * 1000
  const body = encodeBase64Url(Buffer.from(JSON.stringify({
    version: 1,
    authority,
    issuedAt,
    expiresAt,
  }), 'utf8'))
  const signature = encodeBase64Url(createHmac('sha256', secret).update(body).digest())
  return {
    name: innerCookieName(authority),
    value: `v1.${body}.${signature}`,
    maxAgeSec: ttlSec,
    expiresAt,
  }
}

/**
 * Decode one cookie/token body into its payload (structure checks only, no
 * signature or expiry verification) — used to bound a handoff token's
 * lifetime before treating it as a minting authorization.
 * @param value - a `v1.<body>.<signature>` value.
 * @returns {version, authority, issuedAt, expiresAt} or undefined.
 */
export function decodeInnerPayload(value) {
  if (typeof value !== 'string') return undefined
  const parts = value.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return undefined
  const bodyBytes = decodeBase64Url(parts[1])
  if (bodyBytes === undefined) return undefined
  try {
    const decoded = JSON.parse(bodyBytes.toString('utf8'))
    if (!isRecord(decoded) || decoded.version !== 1
      || typeof decoded.authority !== 'string'
      || !Number.isSafeInteger(decoded.issuedAt)
      || !Number.isSafeInteger(decoded.expiresAt)) {
      return undefined
    }
    return decoded
  } catch {
    return undefined
  }
}

/**
 * Verify a presented inner cookie against a secret (same checks as the
 * built-in gate: structure, signature, audience, and lifetime bounds).
 * @param value - the raw cookie value.
 * @param secret - the 32-byte signing secret.
 * @param authority - the request authority the cookie must be bound to.
 * @param maxAgeMilliseconds - the gate's configured lifetime bound.
 * @returns true only for a valid, unexpired, audience-matching cookie.
 */
export function verifyInnerCookie(value, secret, authority, maxAgeMilliseconds = 30 * DAY_MILLISECONDS) {
  if (typeof value !== 'string') return false
  const parts = value.split('.')
  const [version, body, encodedSignature] = parts
  if (parts.length !== 3 || version !== 'v1' || body === undefined || encodedSignature === undefined) {
    return false
  }
  const actualSignature = decodeBase64Url(encodedSignature)
  if (actualSignature === undefined) return false
  const expectedSignature = createHmac('sha256', secret).update(body).digest()
  if (actualSignature.byteLength !== expectedSignature.byteLength
    || !timingSafeEqual(actualSignature, expectedSignature)) {
    return false
  }
  let decoded
  try {
    const bodyBytes = decodeBase64Url(body)
    if (bodyBytes === undefined) return false
    decoded = JSON.parse(bodyBytes.toString('utf8'))
  } catch {
    return false
  }
  if (!isRecord(decoded)
    || decoded.version !== 1
    || typeof decoded.authority !== 'string'
    || !Number.isSafeInteger(decoded.issuedAt)
    || !Number.isSafeInteger(decoded.expiresAt)) {
    return false
  }
  const now = Date.now()
  return decoded.authority === authority
    && decoded.issuedAt <= now
    && decoded.expiresAt > now
    && decoded.expiresAt > decoded.issuedAt
    && decoded.expiresAt - decoded.issuedAt <= maxAgeMilliseconds
}
