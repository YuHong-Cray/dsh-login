/**
 * dsh-login — the per-user「普通用户能否自行设置模型参数」policy mirror.
 *
 * The administrator's decision lives in the account table (`model_self_service`,
 * see lib/db.js) and is flipped from the user-management console. The USER's
 * own instance, however, has no database by design (instance mode carries no
 * `db` section) and must know the decision without asking the hub — an
 * instance stays usable while the hub restarts or is offline.
 *
 * The hub therefore MIRRORS the decision into the user's own DSH_HOME as this
 * tiny JSON file, and the instance reads it fresh on every self-service
 * request (a few bytes; no reload or restart needed when the administrator
 * flips the switch):
 *
 *   /root/dsh-users/<username>/dsh-login-model-policy.json
 *   { "allowSelfService": false, "updatedAt": "2025-01-01T00:00:00.000Z" }
 *
 * FAIL CLOSED: a missing, unreadable, or malformed file means DENIED. That is
 * also the state of every instance provisioned before this file existed, so an
 * upgrade never silently hands out self-service rights the administrator has
 * not granted. The hub (re)writes the file on every administrative toggle and
 * every time it ensures/repairs an instance, so a re-provisioned home or a
 * restored backup converges back to the database's decision.
 *
 * Trust model: this file is the switch the SELF-SERVICE PAGE honours, not a
 * hard sandbox. A user's instance runs as root on the host and its owner can
 * reach the same settings/credentials write API directly (the deployment
 * documents this: the page wraps an ability the cookie holder already has).
 * The mirror exists so the running instance enforces the administrator's
 * policy on its own routes without a per-request hub round-trip.
 */
import { mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** File name inside a user's DSH_HOME. */
export const MODEL_POLICY_FILE = 'dsh-login-model-policy.json'

/** Absolute path of the policy mirror inside one DSH_HOME. */
export function modelPolicyPath(dshHome) {
  return join(dshHome, MODEL_POLICY_FILE)
}

/**
 * Interpret the account table's `model_self_service` column.
 *
 * Kept here (next to the mirror, in a module that never imports MySQL) so the
 * hub and any test share one interpretation of the 0/1 column, and so
 * instance-mode hosts do not pull in the driver just to read a boolean.
 * @param value - the raw column value (number, string, or boolean).
 * @returns true only for an explicit allow.
 */
export function policyFromColumn(value) {
  return value === 1 || value === '1' || value === true
}

/**
 * Interpret one policy document.
 * @param raw - the file text (or anything).
 * @returns true only for an explicit `{"allowSelfService": true}` document.
 */
export function parseModelPolicy(raw) {
  let parsed
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : '')
  } catch {
    return false
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    && parsed.allowSelfService === true
}

/**
 * Read the decision for one DSH_HOME.
 * Never throws: any failure (absent file, permissions, malformed JSON) is a
 * denial, which is the documented default.
 * @param dshHome - the user's Harness home directory.
 * @returns true when self-service is explicitly allowed.
 */
export async function readModelPolicy(dshHome) {
  try {
    return parseModelPolicy(await readFile(modelPolicyPath(dshHome), 'utf8'))
  } catch {
    return false
  }
}

/**
 * Mirror one decision into a DSH_HOME (creating the directory if needed).
 * @param dshHome - the user's Harness home directory.
 * @param allow - the administrator's decision.
 * @returns the boolean that was written.
 * @throws when the file cannot be written (the caller decides how loud to be:
 *   the DB row is authoritative and the next ensure re-mirrors it).
 */
export async function writeModelPolicy(dshHome, allow) {
  const path = modelPolicyPath(dshHome)
  mkdirSync(dirname(path), { recursive: true })
  const value = allow === true
  await writeFile(
    path,
    `${JSON.stringify({ allowSelfService: value, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  )
  return value
}
