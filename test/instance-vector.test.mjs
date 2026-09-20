/**
 * dsh-login — the per-user instance launch vector must mirror the hub's plane.
 *
 * The instance has to load the same copy of every workspace package the hub
 * loaded, or module-local symbols such as `@deepseek-ai/dsh-tools`'s
 * `TOOL_RUNTIME_SCHEDULER` disagree between the mounted ToolRuntime and the
 * agent loop, and every tool call fails its turn with
 * `Cannot read properties of undefined (reading 'prepare')`.
 *
 * Run:  node --test test/instance-vector.test.mjs
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { instanceLaunchVector } from '../lib/instances.js'

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
