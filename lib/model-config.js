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
 */

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
