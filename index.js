/**
 * dsh-ark-plan — 火山方舟 Agent Plan 接入插件（Host 半边）
 *
 * 两件事：
 * 1. 通过控制面 OpenAPI `ListAgentPlanVirtualModelID` 拉取套餐可用模型（含
 *    上下文窗口、最大输出、输入模态），把 `llm-pi-ai` 里对应 provider 的
 *    `models` 列表自动同步成最新目录；模型条目会带上思考强度与多模态声明。
 * 2. 通过控制面 OpenAPI `GetAFPUsage` 拉取 Agent Plan 的 5 小时 / 每日 /
 *    每周 / 每月 AFP 额度窗口，供 Web 端展示。
 *
 * 控制面接口只接受火山 OpenAPI V4 签名（AK/SK）；模型调用鉴权由 llm-pi-ai
 * 的 `apiKeyEnv`（Agent Plan 专属 API Key）负责，二者互不混用。
 */
import { createHash, createHmac } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

export const name = 'ark-plan'
export const inject = ['webServer', 'credentials', 'configEditor']
/** 插件被 Loader 重新激活的次数（诊断用：写本行 config 会导致重挂）。 */
let activations = 0

/**
 * 开关偏好存在本插件的行 config 里。两个字段都标成 volatile：Loader 的
 * equalExceptVolatile 会跳过它们，因此点开关只做 live-commit，不会把插件
 * 整块重挂（重挂会清空目录/额度状态，观感就是开关“点了没反应”）。
 * 必须用 DSH 自带的 @deepseek-ai/schemastery，它的 volatile 才被构建识别。
 */
let SchemaRef = null
try {
  const loaded = await import('@deepseek-ai/schemastery')
  SchemaRef = loaded.default === undefined ? loaded : loaded.default
} catch {
  SchemaRef = null
}

export const Config = SchemaRef === null
  ? undefined
  : SchemaRef.object({
    include: SchemaRef.array(SchemaRef.string()).volatile().default([]),
    exclude: SchemaRef.array(SchemaRef.string()).volatile().default([]),
  })

/** 解析后的 volatile 字段是 cosmokit 的 Volatile 引用，读值前要拆一层。 */
function unwrapConfigValue(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

const REGION = 'cn-beijing'
const PLAN_BASE_URL = 'https://ark.cn-beijing.volces.com/api/plan/v3'
const PI_AI_PACKAGE = '@deepseek-ai/dsh-llm-pi-ai'
const DEFAULT_ROUTE = 'arkcli-agent-plan'
const DEFAULT_DISPLAY_NAME = 'Volcano Engine (Agent Plan)'
const DEFAULT_CONTEXT_WINDOW = 1048576
const DEFAULT_MAX_TOKENS = 262144
const MODEL_TTL_MS = 10 * 60 * 1000
const REFRESH_MS = 60 * 1000
const BOOT_REFRESH_MS = 1200

const MODEL_KEY_CANDIDATES = [
  'ARKCLI_AGENT_PLAN_API_KEY',
  'ARK_AGENT_PLAN_API_KEY',
  'ARK_PLAN_API_KEY',
  'ARK_API_KEY',
]
const ACCESS_KEY_CANDIDATES = ['VOLC_ACCESS_KEY', 'VOLCENGINE_ACCESS_KEY']
const SECRET_KEY_CANDIDATES = ['VOLC_SECRET_KEY', 'VOLCENGINE_SECRET_KEY']

/**
 * pi-ai 的思考档位只有 off/minimal/low/medium/high/xhigh/max 七档，取值一一对应。
 * 方舟 `reasoning.effort` 的七档是 none/minimal/low/medium/high/xhigh/max，两套
 * 档位不完全同名，必须显式映射，否则会出现 `medium: medium` 这种重复档位
 * （下拉里同时出现两个「Medium」，选哪个都可能被网关落到 low）。
 *   off → none（关闭思考；官方文档说明与「不传 reasoning_effort」等价）
 *   minimal/low/medium/high → 同名
 *   xhigh → xhigh（弱化思考；deepseek 系列会映射为 high）
 *   max → max
 */
const EFFORT_WIRE = {
  off: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}
/** 可提供 off（关闭思考）档位的模型族，按 ID 前缀匹配。 */
const OFF_CAPABLE_PREFIXES = [
  'doubao-seed-evolving',
  'doubao-seed-2',
  'glm-5.2',
  'deepseek-v4',
]
/** 不支持关闭思考的模型族：只给弱化思考以上的档位。 */
const ALWAYS_THINKING_PREFIXES = ['glm-5.3', 'glm-latest', 'kimi-']
/** 不具备思考能力的模型族。 */
const NON_REASONING_PREFIXES = ['minimax-']
/** 无法从接口获取思考能力时的兜底归类（实测响应里没有任何思考相关字段）。 */
const DEFAULT_THINKING_PROFILE = 'standard'

const EFFORT_SETS = {
  /** 可关闭：off / minimal / low / medium / high（xhigh 弱化）。 */
  standard: ['off', 'minimal', 'low', 'medium', 'high'],
  /** 始终思考：low / medium / high（xhigh 弱化）。 */
  always: ['low', 'medium', 'high'],
  /** 不具备思考能力。 */
  none: [],
}

function matchesPrefix(id, prefixes) {
  return prefixes.some((prefix) => id.startsWith(prefix))
}

function thinkingProfileFor(id) {
  if (matchesPrefix(id, NON_REASONING_PREFIXES)) return 'none'
  if (matchesPrefix(id, OFF_CAPABLE_PREFIXES)) return 'standard'
  if (matchesPrefix(id, ALWAYS_THINKING_PREFIXES)) return 'always'
  return DEFAULT_THINKING_PROFILE
}

function reasoningEffortsFor(id) {
  const levels = EFFORT_SETS[thinkingProfileFor(id)]
  if (levels.length === 0) return false
  const efforts = {}
  for (const level of levels) efforts[level] = EFFORT_WIRE[level]
  return efforts
}

/** 各档位的中文说明，供设置页展示。 */
const EFFORT_LABELS = {
  off: '关闭思考（none）',
  minimal: '关闭思考，直接回答（minimal）',
  low: '轻量思考（low）',
  medium: '均衡（medium）',
  high: '深度分析（high）',
  xhigh: '更高强度（xhigh，弱化思考时网关映射为 high）',
  max: '最高强度（max）',
}

const NAME_PARTS = {
  doubao: 'Doubao',
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
  glm: 'GLM',
  minimax: 'MiniMax',
  seed: 'Seed',
  flash: 'Flash',
  economy: 'Economy',
  pro: 'Pro',
  lite: 'Lite',
  mini: 'Mini',
  max: 'Max',
  preview: 'Preview',
  code: 'Code',
  latest: 'Latest',
  evolving: 'Evolving',
  ga: 'GA',
  auto: 'Auto',
  m3: 'M3',
  '2.0': '2.0',
  '2.1': '2.1',
  '3': '3',
  '5.3': '5.3',
  'v4': 'V4',
  'v4.1': 'V4.1',
  'k3': 'K3',
  'k3.1': 'K3.1',
  'k2.8': 'K2.8',
  'k2.7': 'K2.7',
}

function prettyName(id) {
  if (id === 'ark-code-latest') return 'Ark Code Latest (Auto)'
  // 只按 provider 的短横线分段：版本号里的点（v4.1 / k3.1 / glm-5.3）保持完整。
  return id
    .split('-')
    .map((part) => NAME_PARTS[part] || (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('-')
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readJsonBody(req, cap = 65536) {
  return new Promise((resolve) => {
    let size = 0
    const parts = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= cap) parts.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

/** 把插件行的配置写成 { include?, exclude? }；空数组时就只剩空对象。 */
function sha256hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function hmacHex(key, data) {
  return createHmac('sha256', key).update(data, 'utf8').digest('hex')
}

function hmacBuf(keyHex, data) {
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(data, 'utf8').digest('hex')
}

function uriEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** Volcengine OpenAPI V4 签名（service=ark，scope={date}/{region}/ark/request）。 */
async function volcCall(accessKey, secretKey, action, bodyObject, region = REGION) {
  const body = bodyObject === undefined || bodyObject === null ? '' : JSON.stringify(bodyObject)
  const pairs = [
    ['Action', action],
    ['Region', region],
    ['Version', '2024-01-01'],
  ].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const canonicalQuery = pairs.map((p) => uriEncode(p[0]) + '=' + uriEncode(p[1])).join('&')
  const xDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const shortDate = xDate.slice(0, 8)
  const xContent = sha256hex(body)
  const host = 'open.volcengineapi.com'
  const signedHeaders = 'host;x-date;x-content-sha256;content-type'
  const contentType = 'application/json; charset=utf-8'
  const canonicalHeaders =
    'host:' + host + '\n' +
    'x-date:' + xDate + '\n' +
    'x-content-sha256:' + xContent + '\n' +
    'content-type:' + contentType + '\n'
  const canonicalRequest = 'POST\n/\n' + canonicalQuery + '\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + xContent
  const scope = shortDate + '/' + region + '/ark/request'
  const stringToSign = 'HMAC-SHA256\n' + xDate + '\n' + scope + '\n' + sha256hex(canonicalRequest)
  const kDate = hmacHex(secretKey, shortDate)
  const kRegion = hmacBuf(kDate, region)
  const kService = hmacBuf(kRegion, 'ark')
  const kSigning = hmacBuf(kService, 'request')
  const signature = hmacBuf(kSigning, stringToSign)
  const authorization =
    'HMAC-SHA256 Credential=' + accessKey + '/' + scope +
    ', SignedHeaders=' + signedHeaders +
    ', Signature=' + signature

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 25000)
  try {
    const response = await fetch('https://' + host + '/?' + canonicalQuery, {
      method: 'POST',
      headers: {
        'X-Date': xDate,
        'X-Content-Sha256': xContent,
        'Content-Type': contentType,
        Authorization: authorization,
      },
      body,
      signal: controller.signal,
    })
    const text = await response.text()
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      // 非 JSON 响应交给调用方按 HTTP 状态报错。
    }
    return { status: response.status, text, body: parsed }
  } finally {
    clearTimeout(timeout)
  }
}

function volcError(result) {
  const error = result && result.body && result.body.ResponseMetadata && result.body.ResponseMetadata.Error
  if (error) {
    return String(error.Code || 'Error') + ': ' + String(error.Message || '')
  }
  if (!result || result.status !== 200) {
    return 'HTTP ' + String(result ? result.status : 0) + ': ' + String(result ? result.text : '').slice(0, 200)
  }
  return ''
}

function parseUsage(result, modelKeyEnv) {
  const error = volcError(result)
  if (error) return { ok: false, at: Date.now(), planType: '', windows: [], error, modelKeyEnv }
  const payload = result.body || {}
  const data = payload.Result || payload || {}
  const planType = typeof data.PlanType === 'string' ? data.PlanType : ''
  const windows = []
  const specs = [
    ['five_hour', '5 小时', 'AFPFiveHour'],
    ['daily', '每日', 'AFPDaily'],
    ['weekly', '每周', 'AFPWeekly'],
    ['monthly', '每月', 'AFPMonthly'],
  ]
  for (const [key, label, field] of specs) {
    const bucket = data[field]
    if (!bucket || typeof bucket !== 'object') continue
    const quota = Number(bucket.Quota)
    const used = Number(bucket.Used)
    const resetMs = Number(bucket.ResetTime)
    windows.push({
      key,
      label,
      quota: Number.isFinite(quota) ? quota : 0,
      used: Number.isFinite(used) ? used : 0,
      percent: Number.isFinite(quota) && quota > 0 && Number.isFinite(used) ? round((used / quota) * 100, 1) : 0,
      resetMs: Number.isFinite(resetMs) && resetMs > 0 ? resetMs : 0,
    })
  }
  return {
    ok: true,
    at: Date.now(),
    planType,
    windows,
    error: '',
    modelKeyEnv,
    quota: windows.length ? windows[windows.length - 1].quota : 0,
  }
}

function isChatModel(id, capability) {
  const lower = id.toLowerCase()
  if (/tts|asr|embedding|seedream|seedance|seed3d|voice|music|podcast/.test(lower)) return false
  const outputs = capability && Array.isArray(capability.OutputModalities) ? capability.OutputModalities : []
  if (outputs.length > 0) return outputs.includes('text')
  return true
}

function modalityInputs(capability) {
  const inputs = capability && Array.isArray(capability.InputModalities) ? capability.InputModalities : []
  const result = ['text']
  if (inputs.includes('image')) result.push('image')
  return result
}

function parseModels(result, planType) {
  const error = volcError(result)
  if (error) return { ok: false, at: Date.now(), planType, list: [], error }
  const payload = result.body || {}
  const data = payload.Result || payload || {}
  const items = Array.isArray(data.Data) ? data.Data : []
  const all = []
  for (const item of items) {
    const id = typeof item.VirtualModelID === 'string' ? item.VirtualModelID : ''
    if (!id) continue
    const capability = item.ModelCapability && typeof item.ModelCapability === 'object' ? item.ModelCapability : {}
    const contextWindow = Number(capability.ContextWindow) > 0 ? Number(capability.ContextWindow) : DEFAULT_CONTEXT_WINDOW
    const rawMax = Number(capability.MaxCompletionTokens) > 0 ? Number(capability.MaxCompletionTokens) : DEFAULT_MAX_TOKENS
    const maxTokens = Math.max(1, Math.min(rawMax, contextWindow))
    const chat = isChatModel(id, capability)
    all.push({
      id,
      name: prettyName(id),
      chat,
      contextWindow,
      maxTokens,
      input: modalityInputs(capability),
      reasoningEfforts: reasoningEffortsFor(id),
    })
  }
  return { ok: true, at: Date.now(), planType, all, error: '' }
}

/**
 * 选中集合：{ include: [...], exclude: [...] }，都是「例外表」而不是白名单。
 * 默认全部加入（新上架模型自动进 Provider），include 表示从「默认关闭」里
 * 单独打开、exclude 表示从「默认开启」里单独关掉，两者同 id 时 include 优先。
 */
function selectedIds(prefs, catalog) {
  const include = new Set((prefs && Array.isArray(prefs.include) ? prefs.include : []).filter((id) => typeof id === 'string'))
  const exclude = new Set((prefs && Array.isArray(prefs.exclude) ? prefs.exclude : []).filter((id) => typeof id === 'string'))
  const result = []
  for (const model of catalog) {
    if (!model.chat) continue
    const enabled = include.has(model.id) ? true : !exclude.has(model.id)
    if (enabled) result.push(model)
  }
  return result
}

function normalizePrefs(prefs) {
  return {
    include: (prefs && Array.isArray(prefs.include) ? prefs.include : []).filter((id) => typeof id === 'string'),
    exclude: (prefs && Array.isArray(prefs.exclude) ? prefs.exclude : []).filter((id) => typeof id === 'string'),
  }
}

function toPiModel(model) {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: model.input,
    reasoningEfforts: model.reasoningEfforts,
  }
}

function chooseRoute(providers) {
  if (providers && Object.hasOwn(providers, DEFAULT_ROUTE)) return DEFAULT_ROUTE
  for (const [route, profile] of Object.entries(providers || {})) {
    if (profile && typeof profile.baseURL === 'string' && /\/api\/plan\/v3\/?$/.test(profile.baseURL)) return route
  }
  return DEFAULT_ROUTE
}

/** 插件行的配置：{ exclude?, include? }；include 优先，二者皆空表示全选。 */
function readPrefs(override) {
  return normalizePrefs(override)
}

function samePrefs(a, b) {
  const x = { include: [...a.include].sort(), exclude: [...a.exclude].sort() }
  const y = { include: [...b.include].sort(), exclude: [...b.exclude].sort() }
  return isDeepStrictEqual(x, y)
}

/** 把插件行的配置写成 { include?, exclude? }；空数组时写入空对象。 */
function normalizeOverride(override, prefs) {
  const raw = override && typeof override === 'object' ? { ...override } : {}
  delete raw.include
  delete raw.exclude
  if (prefs.include.length > 0) raw.include = prefs.include
  if (prefs.exclude.length > 0) raw.exclude = prefs.exclude
  return raw
}

export function apply(ctx, config) {
  activations += 1
  const credentials = ctx.get('credentials')
  const configEditor = ctx.get('configEditor')
  let prefs = normalizePrefs({
    include: unwrapConfigValue(config && config.include),
    exclude: unwrapConfigValue(config && config.exclude),
  })
  let rowId = null

  const state = {
    usage: null,
    models: null,
    provider: null,
    keys: { modelKeyEnv: null, controlPlane: false },
    at: 0,
    modelsAt: 0,
  }
  const lastGood = { usage: null, models: null }
  let inFlight = null
  /** 开关的串行队列：两次点击并发时，后一次必须看到前一次写好的例外表。 */
  let toggleChain = Promise.resolve()

  async function resolveCredential(candidates) {
    if (credentials === undefined) return { env: null, value: '' }
    for (const candidate of candidates) {
      try {
        const resolved = await credentials.resolve(candidate)
        if (resolved && typeof resolved.value === 'string' && resolved.value.length > 0) {
          return { env: candidate, value: resolved.value }
        }
      } catch {
        // 单个凭据解析失败不阻断其它候选。
      }
    }
    return { env: null, value: '' }
  }

  async function readCredentials() {
    const model = await resolveCredential(MODEL_KEY_CANDIDATES)
    const access = await resolveCredential(ACCESS_KEY_CANDIDATES)
    const secret = await resolveCredential(SECRET_KEY_CANDIDATES)
    return {
      modelKeyEnv: model.env || 'ARKCLI_AGENT_PLAN_API_KEY',
      modelKey: model.value,
      accessKey: access.value,
      secretKey: secret.value,
    }
  }

  async function fetchUsage(creds) {
    if (!creds.accessKey || !creds.secretKey) {
      return {
        ok: false,
        at: Date.now(),
        planType: '',
        windows: [],
        error: '未配置控制面密钥（VOLC_ACCESS_KEY / VOLC_SECRET_KEY）',
        modelKeyEnv: creds.modelKeyEnv,
      }
    }
    try {
      const result = await volcCall(creds.accessKey, creds.secretKey, 'GetAFPUsage', null)
      return parseUsage(result, creds.modelKeyEnv)
    } catch (error) {
      return {
        ok: false,
        at: Date.now(),
        planType: '',
        windows: [],
        error: String(error && error.message ? error.message : error).slice(0, 300),
        modelKeyEnv: creds.modelKeyEnv,
      }
    }
  }

  async function fetchModels(creds, tier) {
    if (!creds.accessKey || !creds.secretKey) {
      return {
        ok: false,
        at: Date.now(),
        planType: tier,
        list: [],
        error: '未配置控制面密钥（VOLC_ACCESS_KEY / VOLC_SECRET_KEY）',
      }
    }
    try {
      const bizInfo = ['small', 'medium', 'large', 'max'].includes(tier) ? tier : 'medium'
      const result = await volcCall(creds.accessKey, creds.secretKey, 'ListAgentPlanVirtualModelID', {
        Edition: 'personal',
        BizInfo: bizInfo,
      })
      return parseModels(result, bizInfo)
    } catch (error) {
      return {
        ok: false,
        at: Date.now(),
        planType: tier,
        list: [],
        error: String(error && error.message ? error.message : error).slice(0, 300),
      }
    }
  }

  function mergeState(key, fresh) {
    if (fresh && fresh.ok) {
      lastGood[key] = fresh
      state[key] = fresh
      return
    }
    if (lastGood[key]) {
      state[key] = { ...lastGood[key], stale: true, error: fresh && fresh.error ? fresh.error : '' }
    } else {
      state[key] = fresh
    }
  }

  /** 设置页的模型行视图：能力 + 是否已加入 + 档位说明。 */
  function modelView() {
    if (!state.models) return null
    const enabled = new Set(selectedIds(prefs, state.models.all || []).map((m) => m.id))
    const rows = (state.models.all || []).map((model) => ({
      ...model,
      enabled: enabled.has(model.id),
      thinking: thinkingProfileFor(model.id),
      efforts: model.reasoningEfforts
        ? Object.keys(model.reasoningEfforts).map((level) => ({ level, wire: model.reasoningEfforts[level], label: EFFORT_LABELS[level] || level }))
        : [],
    }))
    return {
      ok: state.models.ok,
      at: state.models.at,
      planType: state.models.planType,
      error: state.models.error,
      stale: state.models.stale === true,
      rows,
      count: rows.filter((row) => row.enabled).length,
      chatCount: rows.filter((row) => row.chat).length,
    }
  }

  async function readProviderConfig() {
    if (configEditor === undefined) {
      return { ok: false, error: 'configEditor 服务不可用' }
    }
    let entries
    try {
      entries = configEditor.entries()
    } catch (error) {
      return { ok: false, error: '读取配置行失败：' + String(error && error.message) }
    }
    const entry = entries.find((item) => item && item.options && item.options.name === PI_AI_PACKAGE)
    if (!entry) {
      return { ok: false, error: '未找到 ' + PI_AI_PACKAGE + ' 配置行' }
    }
    let configuration
    try {
      configuration = configEditor.configuration().find((row) => row.entry === entry)
    } catch (error) {
      return { ok: false, error: '读取 provider 配置失败：' + String(error && error.message) }
    }
    const inherited = (configuration && configuration.inherited) || {}
    const override = (configuration && configuration.override) || {}
    const providers = { ...(inherited.providers || {}), ...(override.providers || {}) }
    const route = chooseRoute(providers)
    const profile = providers[route] || {}
    return {
      ok: true,
      entry,
      inherited,
      override,
      providers,
      route,
      profile,
      models: Array.isArray(profile.models) ? profile.models : [],
    }
  }

  /** 写入 profile patch 时与其它写者共享同一把文件锁，短暂冲突（锁超时 / 行被 HMR 换掉）重试。
   *  插件刚加载的那一次写入还可能落在 Loader 自己的 HMR 事务里，等一拍再试即可。 */
  function retryableWriteError(error) {
    return /writer lock|no longer available|changed during reload|no longer active|HMR transactions cannot be nested/i.test(String(error && error.message))
  }

  async function editWithRetry(entry, change, attempts = 4) {
    let last = null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await configEditor.edit(entry, change)
        return
      } catch (error) {
        last = error
        if (!retryableWriteError(error)) throw error
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
      }
    }
    throw last
  }

  /** 把模型列表写进 llm-pi-ai 的 provider；每次重试都重新定位配置行（HMR 会换掉 entry）。 */
  async function writeProviderModels(models) {
    // 防呆：pi-ai 的 models 必须是数组，误传对象会被 schema 拒绝并让开关静默失效。
    if (!Array.isArray(models)) throw new Error('内部错误：models 必须是数组')
    let last = null
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const config = await readProviderConfig()
      if (!config.ok) throw new Error(config.error)
      try {
        await configEditor.edit(config.entry, (current, inherited) => {
          const inheritedProviders = (inherited && inherited.providers) || {}
          const currentProviders = (current && current.providers) || {}
          const providers = { ...inheritedProviders, ...currentProviders }
          const route = chooseRoute(providers)
          const existing = providers[route] || {}
          providers[route] = {
            ...existing,
            displayName: existing.displayName || DEFAULT_DISPLAY_NAME,
            api: existing.api || 'openai-completions',
            apiKeyEnv: existing.apiKeyEnv || state.keys.modelKeyEnv || 'ARKCLI_AGENT_PLAN_API_KEY',
            baseURL: existing.baseURL || PLAN_BASE_URL,
            defaultContextWindow: existing.defaultContextWindow || DEFAULT_CONTEXT_WINDOW,
            models,
          }
          return { ...current, providers }
        })
        return config
      } catch (error) {
        last = error
        if (!retryableWriteError(error)) throw error
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
      }
    }
    throw last
  }

  async function syncProvider(included, options = {}) {
    const force = options.force === true
    // 只把 pi-ai 认识的字段写进配置，目录侧的内部字段（chat/thinking/efforts）留在插件里。
    const models = included.map(toPiModel)
    const signature = JSON.stringify(models)
    if (!force && state.provider && state.provider.ok && state.provider.signature === signature) {
      return { ...state.provider, changed: false }
    }
    // configEditor.edit 内部会占用 HMR 事务；必须等它完全结束再返回，否则下一轮
    // 自动同步（如启动后 60 秒的定时刷新）会在同一事务里再嵌套一次。
    const config = await readProviderConfig()
    if (!config.ok) return { ok: false, changed: false, error: config.error, signature }
    if (JSON.stringify(config.models) === signature) {
      return {
        ok: true,
        changed: false,
        route: config.route,
        count: models.length,
        signature,
        at: Date.now(),
      }
    }
    try {
      await writeProviderModels(models)
    } catch (error) {
      return {
        ok: false,
        changed: false,
        route: config.route,
        error: '写入 llm-pi-ai 配置失败：' + String(error && error.message),
        signature,
      }
    }
    return {
      ok: true,
      changed: true,
      route: config.route,
      count: models.length,
      signature,
      at: Date.now(),
    }
  }

  /**
   * 设置页的「刷新额度」：只重拉 AFP 用量并顺手刷新模型目录（目录有 10 分钟缓存），
   * 不写 provider；写入只在开关变化、目录新上架模型或自动同步时由签名比较触发。
   */
  async function refresh(options = {}) {
    if (inFlight !== null) return inFlight
    inFlight = (async () => {
      const creds = await readCredentials()
      state.keys = {
        modelKeyEnv: creds.modelKeyEnv,
        modelKey: creds.modelKey.length > 0,
        controlPlane: !!(creds.accessKey && creds.secretKey),
      }

      // 先补齐目录，让「是否加入」的判断基于最新目录。
      const cachedModels = state.models && state.models.ok
      if (options.forceModels === true || !cachedModels || Date.now() - state.modelsAt > MODEL_TTL_MS) {
        const planHint = (state.usage && state.usage.planType) || 'medium'
        const models = await fetchModels(creds, planHint)
        mergeState('models', models)
        if (models.ok) state.modelsAt = Date.now()
      }

      const usage = await fetchUsage(creds)
      mergeState('usage', usage)
      const planType = usage.ok && usage.planType ? usage.planType : ''
      // 套餐档位变了（例如升配）就按新档位重拉一次目录。
      if (planType && state.models && state.models.ok && state.models.planType !== planType) {
        const models = await fetchModels(creds, planType)
        mergeState('models', models)
        if (models.ok) state.modelsAt = Date.now()
      }

      // 目录或开关集合变化时补一次写入（签名一致会直接跳过，因此定时刷新不会反复改配置）。
      if (state.models && state.models.ok) {
        state.provider = await syncProvider(selectedIds(prefs, state.models.all), { force: false })
      }

      state.at = Date.now()
      return snapshot()
    })().catch((error) => {
      return { error: '刷新失败：' + String(error && error.message) }
    })
    try {
      return await inFlight
    } finally {
      inFlight = null
    }
  }

  /** 强制重拉模型目录并写 provider；catalogOnly 时只重拉目录、不写 provider。 */
  async function syncModelCatalog(options = {}) {
    const key = options.catalogOnly === true ? 'catalog' : 'sync'
    // 有刷新在跑时先等它结束，避免把这次切换的写入吞并进上一轮。
    if (inFlight !== null) {
      try {
        await inFlight
      } catch {
        // 忽略上一轮失败。
      }
    }
    inFlight = (async () => {
      const creds = await readCredentials()
      const planType = (state.usage && state.usage.planType) || 'medium'
      const models = await fetchModels(creds, planType)
      mergeState('models', models)
      if (models.ok) state.modelsAt = Date.now()
      if (!models.ok || options.catalogOnly === true) return snapshot()
      state.provider = await syncProvider(selectedIds(prefs, state.models.all), { force: true })
      state.at = Date.now()
      return snapshot()
    })().catch((error) => ({ error: key + ' 失败：' + String(error && error.message) }))
    try {
      return await inFlight
    } finally {
      inFlight = null
    }
  }

  /**
   * 本插件行的 patch id 就是配置注入的「服务名」（Loader 的 bootstrap 约定：
   * 本行就是 id 为插件名的配置插件），localeFile 等方式都拿它做注入名；
   * 按加载顺序找到最近的一个即可定位当前生效的那一行。
   */
  function rowIdOf(entry) {
    return entry && entry.options ? entry.options.id : null
  }

  function bindRowId() {
    if (configEditor === undefined) return
    try {
      rowId = configEditor.entries().some((item) => rowIdOf(item) === name) ? name : null
    } catch {
      rowId = null
    }
  }

  /** 读出 profile patch 里本插件行的 config，作为开关判断的依据。 */
  function readRowPrefs() {
    if (configEditor === undefined || rowId === null) return prefs
    try {
      const row = configEditor.configuration().find((item) => rowIdOf(item.entry) === rowId)
      return normalizePrefs(row && row.override)
    } catch {
      return prefs
    }
  }

  /** 用户点开关：串行执行（读-改-写必须原子，否则两次点击互相覆盖），再写一次 Provider。 */
  function toggleModel(id, on) {
    const run = () => toggleModelOnce(id, on)
    const result = toggleChain.then(run, run)
    toggleChain = result.then(() => {}, () => {})
    return result
  }

  async function toggleModelOnce(id, on) {
    if (configEditor === undefined || rowId === null) {
      return { ...snapshot(), message: '入口服务不可用：' + (configEditor === undefined ? 'configEditor' : 'rowId') }
    }
    // 后台刷新（60 秒定时器 / 页面轮询）可能正在跑：等它收尾再切，而不是直接拒绝这一下点击。
    if (inFlight !== null) {
      try {
        await inFlight
      } catch {
        // 上一轮的失败不影响这一次切换。
      }
    }
    const entry = configEditor.entries().find((item) => rowIdOf(item) === rowId)
    if (!entry) return { ...snapshot(), message: '未找到插件配置行 ' + rowId }
    const catalog = (state.models && state.models.all) || []
    if (!catalog.some((model) => model.id === id)) return { ...snapshot(), message: '未知模型：' + id }

    const current = readRowPrefs()
    if (!catalog.some((model) => model.id === id && model.chat)) {
      return { ...snapshot(), message: '该模型不是文本模型，无需加入 Provider' }
    }
    // 只改这一个 id 的例外，其它模型的开关状态原样保留：
    //   打开 = 从 exclude 里移除（默认加入）；关闭 = 从 include 里移除并写进 exclude。
    const next = { include: current.include.filter((modelId) => modelId !== id), exclude: current.exclude.filter((modelId) => modelId !== id) }
    if (on === false) next.exclude.push(id)
    // 没有例外时写空对象，清掉旧字段，配置保持干净。
    if (!samePrefs(next, current)) {
      try {
        await editWithRetry(entry, (raw) => normalizeOverride(raw, next))
      } catch (error) {
        return { ...snapshot(), message: '保存开关失败：' + String(error && error.message) }
      }
      prefs = next
    }

    const synced = await syncModelCatalog({ catalogOnly: false })
    return { ...synced, message: synced.provider && synced.provider.ok ? '' : ((synced.provider && synced.provider.error) || '写入 Provider 失败') }
  }

  function snapshot() {
    // 每次都从配置行读数：用户手改 cordis.patch.yml 或 HMR 重载后开关状态仍然正确。
    prefs = readRowPrefs()
    return {
      at: state.at,
      activations,
      keys: state.keys,
      usage: state.usage,
      models: modelView(),
      provider: state.provider,
      prefs: { include: prefs.include, exclude: prefs.exclude },
    }
  }

  ctx.effect(() => {
    // 等插件行注册进 Loader 后再定位；失败时开关会明确报「未找到配置行」。
    const locate = () => {
      bindRowId()
      if (rowId === null) {
        const retry = setTimeout(locate, 1500)
        if (typeof retry.unref === 'function') retry.unref()
      }
    }
    locate()
    const disposers = [
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/ark-plan/status',
        handler: (req, res) => {
          if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
          return json(res, 200, snapshot())
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/ark-plan/refresh',
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
          const result = await refresh({ forceModels: false })
          return json(res, 200, result)
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/ark-plan/sync',
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
          const result = await syncModelCatalog({ catalogOnly: false })
          return json(res, 200, result)
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/ark-plan/toggle',
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
          const body = await readJsonBody(req)
          if (!body || typeof body.id !== 'string' || typeof body.on !== 'boolean') {
            return json(res, 400, { ok: false, error: '需要 { id: string, on: boolean }' })
          }
          const result = await toggleModel(body.id, body.on)
          return json(res, 200, result)
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/ark-plan/sync-catalog',
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
          const result = await syncModelCatalog({ catalogOnly: true })
          return json(res, 200, result)
        },
      }),
    ]

    const timer = setInterval(() => {
      // 上一轮仍在写配置（HMR 事务未结束）时跳过本轮，避免在同一事务里嵌套 rewrite。
      if (inFlight !== null) return
      refresh().catch(() => {})
    }, REFRESH_MS)
    if (typeof timer.unref === 'function') timer.unref()
    // 首次同步推迟一拍：插件正在被 Loader 激活时还在 HMR 事务里，直接写配置会报嵌套。
    const boot = setTimeout(() => {
      refresh().catch(() => {})
    }, BOOT_REFRESH_MS)
    if (typeof boot.unref === 'function') boot.unref()

    return () => {
      clearTimeout(boot)
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 已卸载的路由无需重复清理。
        }
      }
      clearInterval(timer)
    }
  }, 'dsh-ark-plan: routes')
}
