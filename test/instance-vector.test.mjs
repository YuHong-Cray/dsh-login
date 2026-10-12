/**
 * dsh-login — what a per-user instance is launched with.
 *
 * Two launch-time decisions are asserted here:
 *
 *  1. The launch vector must mirror the hub's plane. The instance has to load
 *     the same copy of every workspace package the hub loaded, or module-local
 *     symbols such as `@deepseek-ai/dsh-tools`'s `TOOL_RUNTIME_SCHEDULER`
 *     disagree between the mounted ToolRuntime and the agent loop, and every
 *     tool call fails its turn with
 *     `Cannot read properties of undefined (reading 'prepare')`.
 *  2. The profile patch: no GUI terminals, and full permission on the tenant's
 *     own home. The second half is what keeps "run a file in my own workspace"
 *     from being answered with a sandbox denial or an approval prompt.
 *
 * Run:  node --test test/instance-vector.test.mjs
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { INSTANCE_PROFILE_PATCH, instanceLaunchVector } from '../lib/instances.js'

const CHECKOUT = '/checkout'
const hubEntry = process.argv[1]

after(() => { process.argv[1] = hubEntry })

test('an artifact-plane hub spawns the built CLI under plain node', () => {
  process.argv[1] = `${CHECKOUT}/apps/cli/lib/bin.js`
  assert.deepEqual(instanceLaunchVector(CHECKOUT), {
    entry: `${CHECKOUT}/apps/cli/lib/bin.js`,
    execArgv: [],
    env: {},
  })
})

test('a source-plane hub spawns the TS entry under the pinned tsx loader', () => {
  process.argv[1] = `${CHECKOUT}/apps/cli/src/bin.ts`
  assert.deepEqual(instanceLaunchVector(CHECKOUT), {
    entry: `${CHECKOUT}/apps/cli/src/bin.ts`,
    execArgv: ['--import', `${CHECKOUT}/node_modules/tsx/dist/esm/index.mjs`],
    env: { TSX_TSCONFIG_PATH: `${CHECKOUT}/tsconfig.json` },
  })
})

test('an unrecognized hub entry falls back to the built CLI', () => {
  process.argv[1] = '/usr/local/bin/dsh-web-shim'
  assert.deepEqual(instanceLaunchVector(CHECKOUT), {
    entry: `${CHECKOUT}/apps/cli/lib/bin.js`,
    execArgv: [],
    env: {},
  })
})

/** One `- id:` block of the generated patch, as `{id, body}` (comments dropped). */
function rowsOf(patch) {
  return patch.split(/\n- id: /u).slice(1).map((block) => {
    const [id, ...rest] = block.split('\n')
    const body = rest
      .filter(line => !line.trimStart().startsWith('#'))
      .join('\n')
      .trimEnd()
    return { id: id.trim(), body }
  })
}

const rows = new Map(rowsOf(INSTANCE_PROFILE_PATCH).map(({ id, body }) => [id, body]))

test('the instance profile disables both GUI terminal surfaces', () => {
  assert.equal(rows.get('terminal-controller'), '  disabled: true')
  assert.equal(rows.get('ui-sidebar-terminal'), '  disabled: true')
})

test('the instance profile grants full permission on the tenant own home', () => {
  assert.equal(rows.get('sandbox-policy'), '  config:\n    mode: danger-full-access')
  assert.equal(rows.get('approval'), '  config:\n    policy: never')
})

test('the instance profile patches nothing else', () => {
  assert.deepEqual([...rows.keys()], [
    'terminal-controller',
    'ui-sidebar-terminal',
    'sandbox-policy',
    'approval',
  ])
})
