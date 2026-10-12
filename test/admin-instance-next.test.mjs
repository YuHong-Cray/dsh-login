/**
 * dsh-login — an administrator aiming at a user instance must not be bounced
 * back to the login page.
 *
 * The instance gate admits only a handoff token bound to its own authority or a
 * browser cookie it minted itself. The hub mints neither for an administrator
 * who opens the instance URL directly, so answering such a `next` with the port
 * itself sends the browser to the instance, which 302s it back to the login
 * page with the same `next` — the page then looks like it refuses to log in.
 * The hub instead routes that case to the enter confirmation for the instance's
 * owner, which is the flow that mints the handoff the instance accepts.
 *
 * Run:  node --test test/admin-instance-next.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { adminLoginTarget } from '../index.js'

const ports = new Map([['tty', 3100], ['ada', 3101]])

test('a relative next is returned untouched', () => {
  assert.equal(adminLoginTarget('/', ports), '/')
  assert.equal(adminLoginTarget('/dsh-login/users', ports), '/dsh-login/users')
})

test('an absolute next on a live instance port becomes that owner enter page', () => {
  assert.equal(
    adminLoginTarget('http://192.168.1.10:3100/', ports),
    '/dsh-login/enter?user=tty',
  )
  assert.equal(
    adminLoginTarget('http://127.0.0.1:3101/some/path?x=1', ports),
    '/dsh-login/enter?user=ada',
  )
})

test('the enter page keeps a username that needs encoding', () => {
  assert.equal(
    adminLoginTarget('http://192.168.1.10:3100/', new Map([['a b', 3100]])),
    '/dsh-login/enter?user=a%20b',
  )
})

test('an absolute next on an unprovisioned port is left to the caller', () => {
  assert.equal(adminLoginTarget('http://192.168.1.10:3999/', ports), 'http://192.168.1.10:3999/')
})

test('the hub authority itself is never treated as an instance', () => {
  assert.equal(adminLoginTarget('http://192.168.1.10/', ports), 'http://192.168.1.10/')
  assert.equal(adminLoginTarget('http://192.168.1.10:3080/', ports), 'http://192.168.1.10:3080/')
})

test('an unparseable next is returned untouched', () => {
  assert.equal(adminLoginTarget('http://[', ports), 'http://[')
})

test('an empty port cache leaves every next untouched', () => {
  assert.equal(adminLoginTarget('http://192.168.1.10:3100/', new Map()), 'http://192.168.1.10:3100/')
})
