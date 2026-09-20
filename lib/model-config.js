/**
 * Per-user model configuration for the admin console.
 *
 * DSH deliberately withholds the settings/credentials surface from
 * non-loopback browsers (`ui-settings` keeps Host persistence disabled there),
 * so an administrator browsing the hub over the LAN cannot use the native
 * Models page. This module drives the very same validated write API
 * (`settings/mutate` + `credentials/set`) against the target user's OWN
 * instance instead, authenticated with a hub-minted inner cookie.
 *
 * Nothing here touches the hub's own settings: each user keeps an independent
 * `settings.yaml` / `.credentials.yaml` in their own DSH_HOME.
 *
 * The `validateMyModels` / `applyMyModels` / `applyMyModelDelete` trio serves
 * the USER self-service page (`/dsh-login/models`, instance mode): the same
 * validated write API, driven by the user's own instance cookie instead of an
 * administrator. The admin `validateModelConfig`/`applyModelConfig` pair is
 * untouched.
 */

import { KNOWN_APIS, presetById } from './provider-presets.js'

/** A provider id must be a short, lowercase, path-safe identifier. */
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/
/** The pi-ai route's protocol discriminator. */
const API_PATTERN = /^[a-z][a-z0-9-]{1,31}$/
const MAX_TEXT = 200
const MAX_SECRET = 4096

/**
 * The credential reference one provider's API key is stored under.
 * @param providerId - validated provider id.
 * @returns the `apiKeyEnv` name, e.g. `my-gw` → `MY_GW_API_KEY`.
 */
export function providerRefName(providerId) {
  return `${providerId.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_API_KEY`
}

/**
 * Validate one administrator-entered model configuration.
 * @param input - raw form/JSON fields.
 * @returns `{ok: true, value}` or `{ok: false, error}` with a human message.
 */
export function validateModelConfig(input) {
  const providerId = typeof input?.providerId === 'string' ? input.providerId.trim() : ''
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    return { ok: false, error: 'provider 标识需为 2~32 位小写字母/数字/连字符，且以字母开头' }
  }
  const rawApi = typeof input?.api === 'string' ? input.api.trim() : ''
  const api = rawApi === '' ? 'openai-completions' : rawApi
  if (!API_PATTERN.test(api)) return { ok: false, error: 'api 类型不合法' }
  const baseURL = typeof input?.baseURL === 'string' ? input.baseURL.trim() : ''
  if (!/^https?:\/\/\S+$/.test(baseURL) || baseURL.length > MAX_TEXT) {
    return { ok: false, error: 'baseURL 需为 http(s):// 开头的地址' }
  }
  const modelId = typeof input?.modelId === 'string' ? input.modelId.trim() : ''
  if (modelId === '' || modelId.length > MAX_TEXT) return { ok: false, error: '模型 ID 不能为空且不超过 200 字符' }
  const rawName = typeof input?.modelName === 'string' ? input.modelName.trim() : ''
  if (rawName.length > MAX_TEXT) return { ok: false, error: '模型显示名过长' }
  const apiKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : ''
  if (/[\r\n\u0000]/.test(apiKey) || apiKey.length > MAX_SECRET) return { ok: false, error: 'API key 含非法字符或过长' }
  const setDefault = input?.setDefault === true || input?.setDefault === 'true' || input?.setDefault === 'on'
  return {
    ok: true,
    value: {
      providerId,
      api,
      baseURL,
      modelId,
      modelName: rawName === '' ? modelId : rawName,
      apiKey,
      setDefault,
    },
  }
}

/**
 * The `llm-pi-ai.providers.<id>` value for one validated configuration.
 * @param cfg - a {@link validateModelConfig} value.
 * @returns the settings value describing provider route + its one model.
 */
export function providerSettingsValue(cfg) {
  return {
    apiKeyEnv: providerRefName(cfg.providerId),
    api: cfg.api,
    baseURL: cfg.baseURL,
    models: [{ id: cfg.modelId, name: cfg.modelName }],
  }
}

/**
 * Read the provider directory and default selection out of a
 * `settings/describe` answer, for rendering the console.
 * @param describeValue - the `SettingsDescribeValue` (or undefined).
 * @returns the configured providers and the current default selection.
 */
export function summarizeModelConfig(describeValue) {
  const namespaces = Array.isArray(describeValue?.namespaces) ? describeValue.namespaces : []
  const find = (name) => namespaces.find((candidate) => candidate?.ns === name)
  const providers = []
  const map = find('llm-pi-ai')?.value?.providers
  if (map !== null && typeof map === 'object' && !Array.isArray(map)) {
    for (const [id, provider] of Object.entries(map)) {
      providers.push({
        id,
        api: typeof provider?.api === 'string' ? provider.api : '',
        baseURL: typeof provider?.baseURL === 'string' ? provider.baseURL : '',
        apiKeyEnv: typeof provider?.apiKeyEnv === 'string' ? provider.apiKeyEnv : '',
        models: Array.isArray(provider?.models)
          ? provider.models.map((model) => String(model?.id ?? '')).filter((id2) => id2 !== '')
          : [],
      })
    }
  }
  const selection = find('agent-default-model')?.value
  const defaultModel = selection !== null && typeof selection === 'object'
    && typeof selection.provider === 'string' && typeof selection.model === 'string'
    ? { provider: selection.provider, model: selection.model }
    : undefined
  return { providers, defaultModel }
}

/**
 * Apply one configuration to a user instance through its own API.
 *
 * Writes are unconditional (`expectedRevision: undefined`): the administrator
 * is explicitly replacing this provider, and the instance's settings service
 * hot-reloads and rebuilds its model catalog on commit.
 * @param rpc - `(method, args) => Promise<value>`, already bound to the target
 *   instance and its session cookie; rejects on any RPC failure.
 * @param cfg - a {@link validateModelConfig} value.
 * @returns the provider settings value that was written.
 */
export async function applyModelConfig(rpc, cfg) {
  const value = providerSettingsValue(cfg)
  await rpc('settings/mutate', {
    ns: 'llm-pi-ai',
    ops: [{ op: 'set', path: ['providers', cfg.providerId], value }],
    expectedRevision: undefined,
  })
  if (cfg.setDefault) {
    await rpc('settings/mutate', {
      ns: 'agent-default-model',
      ops: [
        { op: 'set', path: ['provider'], value: cfg.providerId },
        { op: 'set', path: ['model'], value: cfg.modelId },
        // Clear any effort left over from the previous default: path ops only
        // touch what they name, so a stale `reasoningEffort` (e.g. deepseek's
        // "high") would survive a provider switch and fail every run with
        // UNSUPPORTED_REASONING_EFFORT when the new route declares none.
        { op: 'unset', path: ['reasoningEffort'] },
      ],
      expectedRevision: undefined,
    })
  }
  if (cfg.apiKey !== '') {
    await rpc('credentials/set', { ref: providerRefName(cfg.providerId), value: cfg.apiKey })
  }
  return value
}

/**
 * Whether a candidate route id is a usable provider identifier.
 * @param id - candidate id.
 * @returns true when it matches {@link PROVIDER_ID_PATTERN}.
 */
export function isProviderId(id) {
  return typeof id === 'string' && PROVIDER_ID_PATTERN.test(id)
}

/**
 * Parse the custom form's model field: ids separated by commas, semicolons,
 * or whitespace (including newlines).
 * @param raw - the textarea value.
 * @returns the trimmed non-empty ids in input order (duplicates kept; the
 *   validator reports them, so the error can name the field state).
 */
export function parseModelIds(raw) {
  return String(raw ?? '')
    .split(/[\s,;，；]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/** Whether a value is wrapped in one matching pair of quotes. */
function isQuoted(value) {
  const first = value[0]
  if (first !== '"' && first !== "'" && first !== '`') return false
  return value.length > 1 && value.endsWith(first)
}

/**
 * Judge one API-key input with the same rules the DSH Models page applies —
 * mirror of `normalizeApiKey` in `@deepseek-ai/dsh-llm` and of
 * `apiKeyFailure` in the client `ui-settings-models` (printable ASCII, no
 * spaces; a pasted `NAME=value` environment line and a quoted wrap are
 * rejected): keep the three in step.
 * @param draft - the raw input value.
 * @param required - whether an empty field is itself an error.
 * @returns a human message, or undefined when the value is acceptable.
 */
export function apiKeyError(draft, required = true) {
  const raw = typeof draft === 'string' ? draft : ''
  if (raw.length === 0) return required ? '请输入 API 密钥' : undefined
  const value = raw.trim()
  if (value.length === 0) return 'API 密钥不能只包含空白字符'
  if (value.length > MAX_SECRET) return 'API 密钥过长'
  if (/^[\x21-\x7E]+$/.test(value) === false || /^[A-Z][A-Z0-9_]*=[^=]/.test(value) || isQuoted(value)) {
    return '该 API 密钥格式错误，请检查（仅粘贴官网签发的原始密钥；不要带引号，也不要整行环境变量）'
  }
  return undefined
}

/**
 * Validate the user self-service add-provider form.
 *
 * Two kinds share one entry:
 *  - `preset`: the route id is one of the pi-ai catalog presets — the profile
 *    carries only `apiKeyEnv` + `displayName`; api/baseURL/models come from
 *    the installed catalog. The key is REQUIRED (a catalog route without a
 *    key cannot serve requests here: the instance ships no ambient keys).
 *  - `custom`: a route pi-ai does not ship — the profile carries `api`,
 *    `baseURL`, and at least one model. A blank key keeps the existing
 *    profile's credential reference (overwrite semantics) or, for a brand
 *    new route, names no reference at all (the DSH-native derivation rule:
 *    provider-native authentication).
 *
 * A re-save for an id that already has a profile OVERWRITES that profile
 * (whole-value set), matching the admin page's 覆盖 semantics.
 * @param input - raw form/JSON fields: `kind`, `presetId` | `providerId`,
 *   `displayName?`, `api?`, `baseURL?`, `models?` (raw text), `apiKey?`,
 *   `setDefault?`, `defaultModel?`.
 * @param existing - the profile stored at that route (from
 *   `settings/describe`), or undefined when the route is not configured yet.
 * @returns `{ok: true, value}` or `{ok: false, error}` with a human message.
 */
export function validateMyModels(input, existing) {
  const kind = input?.kind === 'preset' ? 'preset' : input?.kind === 'custom' ? 'custom' : undefined
  if (kind === undefined) {
    return { ok: false, error: '缺少表单类型：请选择一个模型公司或自定义' }
  }

  let providerId
  let displayName
  let profile
  let apiKey

  if (kind === 'preset') {
    const preset = presetById(typeof input?.presetId === 'string' ? input.presetId : '')
    if (preset === undefined) {
      return { ok: false, error: '未知的模型公司：请选择页面列出的内置提供方' }
    }
    providerId = preset.id
    displayName = preset.name
    const keyFailure = apiKeyError(input?.apiKey, true)
    if (keyFailure !== undefined) return { ok: false, error: keyFailure }
    apiKey = String(input.apiKey).trim()
    profile = { apiKeyEnv: providerRefName(providerId), displayName }
  } else {
    const pid = typeof input?.providerId === 'string' ? input.providerId.trim() : ''
    if (!isProviderId(pid)) {
      return { ok: false, error: 'provider 标识需为 2~32 位小写字母/数字/连字符，且以字母开头' }
    }
    providerId = pid
    const rawName = typeof input?.displayName === 'string' ? input.displayName.trim() : ''
    if (rawName.length > MAX_TEXT) return { ok: false, error: '显示名过长' }
    displayName = rawName === '' ? undefined : rawName
    const rawApi = typeof input?.api === 'string' ? input.api.trim() : ''
    const api = rawApi === '' ? 'openai-completions' : rawApi
    if (!KNOWN_APIS.includes(api)) return { ok: false, error: 'api 协议不在支持列表内' }
    const baseURL = typeof input?.baseURL === 'string' ? input.baseURL.trim() : ''
    if (!/^https?:\/\/\S+$/.test(baseURL) || baseURL.length > MAX_TEXT) {
      return { ok: false, error: 'API 地址需为 http(s):// 开头的地址' }
    }
    const models = parseModelIds(input?.models)
    if (models.length === 0) return { ok: false, error: '请至少填写一个模型 ID（多个用逗号或换行分隔）' }
    const seen = new Set()
    for (const id of models) {
      if (id.length > MAX_TEXT) return { ok: false, error: `模型 ID 过长：${id}` }
      if (seen.has(id)) return { ok: false, error: `模型 ID 重复：${id}` }
      seen.add(id)
    }
    profile = { api, baseURL, models: models.map((id) => ({ id })) }
    if (displayName !== undefined) profile.displayName = displayName
    const keyFailure = apiKeyError(input?.apiKey, false)
    if (keyFailure !== undefined) return { ok: false, error: keyFailure }
    const rawKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : ''
    if (rawKey !== '') {
      profile.apiKeyEnv = providerRefName(providerId)
      apiKey = rawKey
    } else if (existing !== undefined && typeof existing.apiKeyEnv === 'string' && existing.apiKeyEnv !== '') {
      // Overwrite keeps the stored key: the profile re-asserts the reference.
      profile.apiKeyEnv = existing.apiKeyEnv
    }
    // A brand-new route with a blank key names no reference: it authenticates
    // provider-natively (credential chain / environment), DSH-native rule.
  }

  let setDefault
  const wantsDefault = input?.setDefault === true || input?.setDefault === 'true' || input?.setDefault === 'on'
  if (wantsDefault) {
    const model = typeof input?.defaultModel === 'string' ? input.defaultModel.trim() : ''
    if (model === '' || model.length > MAX_TEXT) {
      return { ok: false, error: '已勾选设为默认，但未选择默认模型' }
    }
    if (kind === 'custom' && !profile.models.some((m) => m.id === model)) {
      return { ok: false, error: '默认模型必须在本次填写的模型列表内' }
    }
    setDefault = { provider: providerId, model }
  }

  return { ok: true, value: { providerId, displayName, profile, apiKey, setDefault } }
}

/**
 * The `agent-default-model` path ops for one provider/model selection.
 * The trailing unset matters: path ops only touch what they name, so a stale
 * `reasoningEffort` from the previous default would survive a provider switch
 * and fail every run with UNSUPPORTED_REASONING_EFFORT when the new route
 * declares none.
 * @param provider - route id.
 * @param model - model id.
 * @returns the ordered ops.
 */
export function setDefaultOps(provider, model) {
  return [
    { op: 'set', path: ['provider'], value: provider },
    { op: 'set', path: ['model'], value: model },
    { op: 'unset', path: ['reasoningEffort'] },
  ]
}

/**
 * Apply one self-service add/overwrite through the instance's own API.
 *
 * Order: profile, then key, then default — the same two-step credential
 * semantics as the DSH native add card: a key failure leaves the profile
 * stored, so a retry re-sends only the key instead of racing the first
 * write.
 * @param rpc - `(method, args) => Promise<value>`, bound to this instance's
 *   own `/api`; rejects on any RPC failure.
 * @param value - a {@link validateMyModels} value.
 */
export async function applyMyModels(rpc, value) {
  await rpc('settings/mutate', {
    ns: 'llm-pi-ai',
    ops: [{ op: 'set', path: ['providers', value.providerId], value: value.profile }],
    expectedRevision: undefined,
  })
  if (value.apiKey !== undefined) {
    await rpc('credentials/set', { ref: providerRefName(value.providerId), value: value.apiKey })
  }
  if (value.setDefault !== undefined) {
    await rpc('settings/mutate', {
      ns: 'agent-default-model',
      ops: setDefaultOps(value.setDefault.provider, value.setDefault.model),
      expectedRevision: undefined,
    })
  }
}

/**
 * Remove one provider the way the DSH native page does: the page-managed
 * credential FIRST (so a second-step failure leaves the row visible and the
 * retry is safe), then the profile itself.
 *
 * Only the CONVENTIONAL ref (`<ID>_API_KEY`) is unset: a profile that names a
 * hand-written environment variable is managed elsewhere and its credential
 * is kept (the native `removeProviderProfile` rule). Both unsets are
 * idempotent, so deleting an already-removed route is a no-op.
 * @param rpc - `(method, args) => Promise<value>`, bound to this instance's
 *   own `/api`; rejects on any RPC failure.
 * @param providerId - a validated route id.
 * @param profile - the stored profile at that route (from `settings/describe`),
 *   or undefined when the route is already gone.
 */
export async function applyMyModelDelete(rpc, providerId, profile) {
  const ref = typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv !== '' ? profile.apiKeyEnv : undefined
  if (ref !== undefined && ref === providerRefName(providerId)) {
    await rpc('credentials/unset', { ref })
  }
  await rpc('settings/mutate', {
    ns: 'llm-pi-ai',
    ops: [{ op: 'unset', path: ['providers', providerId] }],
    expectedRevision: undefined,
  })
}
