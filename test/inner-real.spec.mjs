/**
 * dsh-login — real-compatibility check for the inner browser-session bridge.
 *
 * Mints an inner cookie using the target dsh web instance's real stored
 * signing secret ($DSH_HOME/.credentials.yaml, record
 * client-connection/browser-session) and posts a real /api RPC to it.
 * Success (200 + server-response envelope) proves the bridge's wire format
 * is byte-compatible with client-connection's BrowserAuth.
 *
 * When the target already runs the dsh-login gate (deployed hub), a bare
 * inner cookie is refused at the gate before reaching BrowserAuth, so the
 * check skips itself: the same proof is obtained against a per-user
 * instance (whose gate passes valid inner cookies through).
 *
 * Run:  node --test test/inner-real.spec.mjs
 *        DSH_LOGIN_TEST_URL=http://127.0.0.1:3100 DSH_HOME=/root/dsh-users/u \
 *        node --test test/inner-real.spec.mjs   (probe one instance)
 * Skips gracefully when the GUI is not listening on the configured URL.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { innerCookieName, mintInnerCookie, requestAuthority } from '../lib/inner.js'

const TARGET = process.env.DSH_LOGIN_TEST_URL ?? 'http://127.0.0.1:3080'
const HOME = process.env.DSH_HOME || `${process.env.HOME || ''}/.dsh`

/** True when the dsh-login gate is mounted on the target (auth surface live). */
async function gateDeployed() {
  try {
    const res = await fetch(`${TARGET}/dsh-login/state`, { signal: AbortSignal.timeout(4000) })
    return res.status === 200
  } catch {
    return false
  }
}

function b64urlDecode(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
}

/** Extract the browser-session secret (base64url) from the credentials file. */
function readRealSecret() {
  let text
  try {
    text = readFileSync(join(HOME, '.credentials.yaml'), 'utf8')
  } catch {
    return undefined
  }
  const lines = text.split('\n')
  let inBlock = false
  for (const line of lines) {
    if (line.includes('client-connection/browser-session:')) {
      inBlock = true
      continue
    }
    if (!inBlock) continue
    const match = /^\s+secret:\s*(\S+)/.exec(line)
    if (match?.[1] !== undefined) return match[1]
    if (/^\S/.test(line)) break
  }
  return undefined
}

async function rpc(settings) {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: 'dsh-login-real-check',
    method: 'settings/describe',
    payload: { args: {} },
  })
  return fetch(`${TARGET}/api/settings/describe`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...settings,
    },
    body,
  })
}

describe('inner bridge vs the running dsh web (byte compatibility)', () => {
  it('a minted cookie for the target authority authenticates /api', { timeout: 20_000 }, async () => {
    if (await gateDeployed()) {
      console.log(`skip: the dsh-login gate is deployed on ${TARGET}; a bare inner cookie is refused at the gate by design (wire compatibility is proven against a per-user instance instead)`)
      return
    }
    const secretB64 = readRealSecret()
    assert.ok(secretB64, 'browser-session secret not found in credentials file')
    const secret = b64urlDecode(secretB64)
    assert.equal(secret.length, 32)
    const authority = requestAuthority(new URL(TARGET).host)
    const minted = mintInnerCookie(secret, authority, 30)
    let probe
    try {
      probe = await rpc({ host: authority, cookie: `${minted.name}=${minted.value}` })
    } catch {
      console.log(`skip: dsh web not reachable at ${TARGET}`)
      return
    }
    assert.equal(probe.status, 200)
    const payload = await probe.json()
    assert.equal(payload.type, 'server-response')
    assert.equal(payload.rpcId, 'dsh-login-real-check')
    assert.equal(payload.result.ok, true)
  })

  it('a cookie minted for a different authority is rejected', { timeout: 20_000 }, async () => {
    if (await gateDeployed()) {
      console.log(`skip: the dsh-login gate is deployed on ${TARGET} (wrong-authority rejection is indistinguishable from the gate's own 401)`)
      return
    }
    const secretB64 = readRealSecret()
    if (secretB64 === undefined) return
    const secret = b64urlDecode(secretB64)
    const authority = requestAuthority(new URL(TARGET).host)
    const other = `127.0.0.1:${String(new URL(TARGET).port + 1)}`
    const minted = mintInnerCookie(secret, other, 30)
    let probe
    try {
      probe = await rpc({ host: authority, cookie: `${minted.name}=${minted.value}` })
    } catch {
      console.log(`skip: dsh web not reachable at ${TARGET}`)
      return
    }
    assert.equal(probe.status, 401)
  })
})
