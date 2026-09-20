/**
 * dsh-login — model-company presets for the user self-service Models page
 * (`/dsh-login/models`, instance mode).
 *
 * A preset is a model company whose route id the installed pi-ai catalog
 * already knows: the user only pastes the API key the company issued, and the
 * profile that lands in `llm-pi-ai.providers.<id>` carries just
 * `apiKeyEnv` + `displayName` — api, baseURL, and the model list come from
 * the catalog defaults (this build: pi-ai 0.85.1). The `api`/`baseUrl`/
 * `model` fields here are for PAGE DISPLAY (「目录默认」) and for pre-filling
 * the editable model field; the write path never trusts them.
 *
 * Presets whose route pi-ai does NOT ship (DashScope, Volcano Ark, self-hosted
 * gateways, …) deliberately have no entry: those take the 自定义 form, which
 * requires baseURL + protocol + at least one model.
 *
 * Keep this table in step with the installed catalog: a pi-ai upgrade that
 * renames or drops a route surfaces as that preset's provider failing to
 * resolve (the GUI row shows the catalog error), which names the drifted id.
 */

/** Every wire protocol the installed pi-ai understands (pi-ai 0.85.1 `KnownApi`). */
export const KNOWN_APIS = [
  'openai-completions',
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses',
  'anthropic-messages',
  'mistral-conversations',
  'bedrock-converse-stream',
  'google-generative-ai',
  'google-vertex',
  'pi-messages',
]

/**
 * One model-company preset.
 * @typedef {Object} ProviderPreset
 * @property {string} id - the pi-ai catalog route id (fixed; the credential ref derives from it).
 * @property {string} name - page label.
 * @property {boolean} common - rendered in the first (un-collapsed) row.
 * @property {string} api - catalog default protocol (display + model-field prefill only).
 * @property {string} baseUrl - catalog default base URL (display only).
 * @property {string} model - a catalog model id offered as the editable default-model prefill.
 * @property {string} [keyUrl] - where the user gets the key (hidden when absent).
 */

/** @type {ProviderPreset[]} */
export const PROVIDER_PRESETS = [
  // ---- the first-run eight (common row) ---------------------------------
  { id: 'deepseek', name: 'DeepSeek', common: true, api: 'openai-completions', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'openai', name: 'OpenAI', common: true, api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', name: 'Anthropic (Claude)', common: true, api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'google', name: 'Google Gemini', common: true, api: 'google-generative-ai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.5-flash', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'moonshotai-cn', name: '月之暗面 Kimi（国内）', common: true, api: 'openai-completions', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2.5', keyUrl: 'https://platform.moonshot.cn' },
  { id: 'zai-coding-cn', name: '智谱（国内）', common: true, api: 'openai-completions', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-5.1', keyUrl: 'https://bigmodel.cn' },
  { id: 'minimax-cn', name: 'MiniMax（国内）', common: true, api: 'anthropic-messages', baseUrl: 'https://api.minimaxi.com/anthropic', model: 'MiniMax-M2.7', keyUrl: 'https://platform.minimaxi.com' },
  { id: 'openrouter', name: 'OpenRouter', common: true, api: 'anthropic-messages', baseUrl: 'https://openrouter.ai/api', model: 'openai/gpt-5.4-mini', keyUrl: 'https://openrouter.ai/settings/keys' },
  // ---- the rest of the key-based catalog (collapsed「更多」) --------------
  { id: 'moonshotai', name: '月之暗面 Kimi（国际）', common: false, api: 'openai-completions', baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k2.5', keyUrl: 'https://platform.moonshot.ai' },
  { id: 'zai', name: '智谱（国际）', common: false, api: 'openai-completions', baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-5.2', keyUrl: 'https://z.ai' },
  { id: 'minimax', name: 'MiniMax（国际）', common: false, api: 'anthropic-messages', baseUrl: 'https://api.minimax.io/anthropic', model: 'MiniMax-M2.7', keyUrl: 'https://platform.minimax.io' },
  { id: 'qwen-token-plan-cn', name: '阿里通义（Token Plan 国内）', common: false, api: 'openai-completions', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'deepseek-v4-flash', keyUrl: 'https://bailian.console.aliyun.com' },
  { id: 'xai', name: 'xAI (Grok)', common: false, api: 'openai-responses', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.6', keyUrl: 'https://console.x.ai' },
  { id: 'mistral', name: 'Mistral', common: false, api: 'mistral-conversations', baseUrl: 'https://api.mistral.ai', model: 'mistral-medium-latest', keyUrl: 'https://console.mistral.ai' },
  { id: 'groq', name: 'Groq', common: false, api: 'openai-completions', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', keyUrl: 'https://console.groq.com/keys' },
  { id: 'together', name: 'Together', common: false, api: 'openai-completions', baseUrl: 'https://api.together.ai/v1', model: 'Qwen/Qwen3.5-9B', keyUrl: 'https://api.together.ai/settings' },
  { id: 'fireworks', name: 'Fireworks', common: false, api: 'anthropic-messages', baseUrl: 'https://api.fireworks.ai/inference', model: 'accounts/fireworks/models/gpt-oss-120b', keyUrl: 'https://fireworks.ai' },
  { id: 'cerebras', name: 'Cerebras', common: false, api: 'openai-completions', baseUrl: 'https://api.cerebras.ai/v1', model: 'gpt-oss-120b', keyUrl: 'https://cloud.cerebras.ai' },
]

/**
 * Look up one preset by its (fixed) route id.
 * @param id - route id.
 * @returns the preset, or undefined.
 */
export function presetById(id) {
  return PROVIDER_PRESETS.find((p) => p.id === id)
}

/**
 * The presets in page order: the common row first, the rest after.
 * @returns the preset list (a copy; callers may not reorder the module table).
 */
export function listPresets() {
  return [...PROVIDER_PRESETS]
}
