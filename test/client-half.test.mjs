/**
 * dsh-login browser half — registration logic.
 *
 * The bundle is a classic script in the client module system's format, so the
 * test evaluates it in a VM with a stubbed `window.__ModuleLoader__`, a stubbed
 * `require('react')`, a fake client context, and a stubbed `fetch`. That pins
 * the two facts that matter without a browser: an administrator gets exactly
 * one tab type plus its body seat, and anyone else gets nothing at all.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** Evaluate the bundle and hand back its plugin exports. */
function loadBundle(fetchImpl) {
  let registration
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { registration = value } } },
    fetch: fetchImpl,
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox)
  assert.equal(registration.id, 'dsh-login', 'the registration id must be the package name')
  const react = { createElement: (type, props, ...children) => ({ type, props, children }) }
  const require = (id) => {
    assert.equal(id, 'react', 'the bundle must reach the baseline only through react')
    return react
  }
  return registration.factory(require)
}

/** A client context recording everything the half contributes. */
function fakeContext() {
  const effects = []
  const tabTypes = []
  const slots = []
  const registrations = []
  const ctx = {
    effect(body, label) {
      effects.push({ body, label })
      return () => {}
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => `<${key}>`,
    },
    sidebarRightTabs: {
      register(definition) {
        tabTypes.push(definition)
        return () => {}
      },
    },
    slots: {
      inject(name, factory) {
        registrations.push(name)
        const dispose = factory()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(declaration, component) {
        slots.push({ declaration, component })
        return () => {}
      },
    },
  }
  return { ctx, effects, tabTypes, slots, registrations }
}

/** Run the contribution effect the way Cordis would, and settle it. */
async function contribute(exports_, ctx, effects) {
  exports_.apply(ctx)
  const effect = effects.at(-1)
  return await effect.body()
}

test('an administrator gets the user-management tab type and its body', async () => {
  const exports_ = loadBundle(async () => ({ ok: true, json: async () => ({ authenticated: true, username: 'wyh', admin: true }) }))
  const { ctx, effects, tabTypes, slots, registrations } = fakeContext()

  const dispose = await contribute(exports_, ctx, effects)

  assert.deepEqual([...exports_.inject], ['slots', 'sidebarRightTabs', 'locale'])
  assert.equal(tabTypes.length, 1)
  const [definition] = tabTypes
  assert.equal(definition.id, 'dsh-login/users')
  assert.equal(definition.kind, 'dsh-login-users')
  assert.equal(definition.title('/dsh-login/users'), '<users.title>')
  assert.equal(definition.guide.length, 1)
  assert.equal(definition.guide[0].title(), '<users.title>')
  assert.equal(definition.guide[0].description(), '<users.description>')
  assert.deepEqual(registrations, ['sidebar.right.pane.tab'])
  assert.equal(slots.length, 1)
  assert.equal(slots[0].declaration.name, 'sidebar.right.pane.tab')
  assert.equal(slots[0].declaration.key, 'dsh-login/users')
  assert.equal(slots[0].declaration.locale, 'dshLogin')
  assert.equal(typeof dispose, 'function')

  const tree = slots[0].component({ t: (key) => `<${key}>` })
  assert.equal(tree.type, 'div')
  const [frame] = tree.children
  assert.equal(frame.type, 'iframe')
  assert.equal(frame.props.src, '/dsh-login/users')
  assert.equal(frame.props.title, '<users.frameTitle>')
})

test('a non-administrator contributes nothing', async () => {
  const exports_ = loadBundle(async () => ({ ok: true, json: async () => ({ authenticated: true, username: 'someone' }) }))
  const { ctx, effects, tabTypes, slots, registrations } = fakeContext()

  const dispose = await contribute(exports_, ctx, effects)

  assert.deepEqual(tabTypes, [])
  assert.deepEqual(slots, [])
  assert.deepEqual(registrations, [])
  assert.equal(typeof dispose, 'function')
})

test('a failed or unauthenticated role read contributes nothing', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('offline') },
    async () => ({ ok: false, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => ({ authenticated: false }) }),
  ]) {
    const exports_ = loadBundle(fetchImpl)
    const { ctx, effects, tabTypes } = fakeContext()
    await contribute(exports_, ctx, effects)
    assert.deepEqual(tabTypes, [])
  }
})
