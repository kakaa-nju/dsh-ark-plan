/* dsh-ark-plan client half: Agent Plan quota page + per-model provider switches + composer readout.
 * Loaded through the client module loader (CJS wrapper). The loader id MUST
 * equal the package name. */
window.__ModuleLoader__.load({
  id: 'dsh-ark-plan',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = {
      status: () => api('/api/ark-plan/status'),
      refresh: () => api('/api/ark-plan/refresh', { method: 'POST' }),
      sync: () => api('/api/ark-plan/sync', { method: 'POST' }),
      catalog: () => api('/api/ark-plan/sync-catalog', { method: 'POST' }),
      toggle: (id, on) => api('/api/ark-plan/toggle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, on }),
      }),
    }

    function api(url, options) {
      return fetch(url, options).then((response) => {
        return response.text().then((text) => {
          let body = null
          try {
            body = JSON.parse(text)
          } catch {
            body = { error: text.slice(0, 200) }
          }
          if (!response.ok) {
            throw new Error((body && body.error) || 'HTTP ' + response.status)
          }
          return body
        })
      })
    }

    /* 颜色全部走宿主主题令牌，浅色/深色都跟随；fallback 只在令牌缺失时兜底。 */
    const CSS = [
      '.dshark-page{display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:1.5;}',
      '.dshark-card{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:10px;padding:12px 14px;}',
      '.dshark-head{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
      '.dshark-title{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;}',
      '.dshark-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto;}',
      '.dshark-row{display:flex;justify-content:space-between;gap:12px;padding:2px 0;}',
      '.dshark-muted{color:var(--dsw-alias-label-secondary,inherit);opacity:.8;font-size:12px;}',
      '.dshark-err{color:var(--dsw-alias-state-error-primary,#e5484d);font-size:12px;}',
      '.dshark-bar{height:5px;background:rgba(127,127,127,.18);border-radius:3px;overflow:hidden;margin:3px 0;}',
      '.dshark-bar-fill{height:100%;border-radius:3px;background:var(--dsw-alias-brand-primary,#4d7cfe);}',
      '.dshark-btn{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:transparent;color:inherit;border-radius:7px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer;}',
      '.dshark-btn:hover:not(:disabled){background:rgba(127,127,127,.1);}',
      '.dshark-btn:disabled{opacity:.5;cursor:default;}',
      '.dshark-btn-primary{border-color:var(--dsw-alias-brand-primary,#4d7cfe);color:var(--dsw-alias-brand-primary,#4d7cfe);}',
      '.dshark-tag{display:inline-block;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));border-radius:999px;padding:0 6px;font-size:11px;line-height:16px;margin-left:5px;color:var(--dsw-alias-label-secondary,inherit);}',
      '.dshark-tag-think{border-color:var(--dsw-alias-brand-primary,#4d7cfe);color:var(--dsw-alias-brand-primary,#4d7cfe);}',
      '.dshark-models{margin-top:8px;max-height:300px;overflow:auto;}',
      '.dshark-model{display:flex;align-items:center;gap:10px;padding:5px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));}',
      '.dshark-model-main{flex:1 1 auto;min-width:0;}',
      '.dshark-model-name{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.dshark-model-id{font-size:11px;color:var(--dsw-alias-label-secondary,inherit);opacity:.75;font-family:ui-monospace,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.dshark-model-off .dshark-model-name{opacity:.5;}',
      '.dshark-tags{flex:0 0 auto;white-space:nowrap;}',
      '.dshark-efforts{font-size:11px;color:var(--dsw-alias-label-secondary,inherit);opacity:.75;margin-top:1px;}',
      '.dshark-dock{font-size:11px;color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;}',
      '.dshark-plan-badge{font-size:11px;border:1px solid var(--dsw-alias-brand-primary,#4d7cfe);color:var(--dsw-alias-brand-primary,#4d7cfe);border-radius:999px;padding:0 7px;line-height:16px;}',
    ].join('\n')

    /**
     * 样式随组件一起渲染：不依赖宿主注入样式表的接口，插槽落在 shadow DOM 里也生效，
     * 卸载时随 React 树一起移除。
     */
    function StyleTag() {
      return h('style', { 'data-dsh-ark-plan': '' }, CSS)
    }

    const store = { status: null, listeners: [] }
    function emit(next) {
      store.status = next
      for (const listener of store.listeners) {
        try {
          listener(next)
        } catch {
          // 单个视图异常不影响其它视图。
        }
      }
    }
    function subscribe(listener) {
      store.listeners.push(listener)
      return () => {
        const index = store.listeners.indexOf(listener)
        if (index >= 0) store.listeners.splice(index, 1)
      }
    }
    function loadStatus() {
      return API.status().then(emit).catch((error) => emit({ error: String(error && error.message) }))
    }
    let refreshPromise = null
    function forceRefresh() {
      if (refreshPromise !== null) return refreshPromise
      refreshPromise = API.refresh()
        .then((status) => {
          emit(status)
          return status
        })
        .catch((error) => {
          emit({ error: String(error && error.message) })
          return null
        })
      refreshPromise.then(
        () => { refreshPromise = null },
        () => { refreshPromise = null },
      )
      return refreshPromise
    }

    function fmtAfp(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
      return rounded.toLocaleString('zh-CN')
    }
    function fmtCtx(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—'
      if (value >= 1048576) return (Math.round((value / 1048576) * 10) / 10) + 'M'
      return Math.round(value / 1024) + 'K'
    }
    function fmtCountdown(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      if (ms <= 0) return '即将重置'
      const seconds0 = Math.floor(ms / 1000)
      const days = Math.floor(seconds0 / 86400)
      const hours = Math.floor((seconds0 % 86400) / 3600)
      const minutes = Math.floor((seconds0 % 3600) / 60)
      const rest = seconds0 % 60
      if (days > 0) return days + ' 天 ' + hours + ' 小时'
      if (hours > 0) return hours + ' 小时 ' + minutes + ' 分'
      if (minutes > 0) return minutes + ' 分 ' + rest + ' 秒'
      return rest + ' 秒'
    }
    function fmtTime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
      return new Date(ms).toLocaleTimeString('zh-CN')
    }

    function useStatus() {
      const [status, setStatus] = React.useState(store.status)
      const [now, setNow] = React.useState(Date.now())
      React.useEffect(() => {
        let alive = true
        const unsubscribe = subscribe((next) => {
          if (alive) setStatus(next)
        })
        const tick = setInterval(() => {
          if (alive) setNow(Date.now())
        }, 1000)
        const poll = setInterval(() => {
          if (alive) loadStatus()
        }, 30000)
        forceRefresh()
        return () => {
          alive = false
          unsubscribe()
          clearInterval(tick)
          clearInterval(poll)
        }
      }, [])
      return { status, now }
    }

    function WindowRow(props) {
      const window = props.window
      const now = props.now
      const percent = Math.max(0, Math.min(100, typeof window.percent === 'number' ? window.percent : 0))
      return h('div', { style: { marginTop: 8 } },
        h('div', { className: 'dshark-row' },
          h('span', null, window.label),
          h('span', null, fmtAfp(window.used) + ' / ' + fmtAfp(window.quota) + ' AFP · ' + (window.percent || 0) + '%')),
        h('div', { className: 'dshark-bar' },
          h('div', { className: 'dshark-bar-fill', style: { width: percent + '%' } })),
        h('div', { className: 'dshark-row' },
          h('span', { className: 'dshark-muted' }, window.resetMs ? '重置倒计时' : '未启用'),
          h('span', { className: 'dshark-muted' }, window.resetMs ? fmtCountdown(window.resetMs - now) : '—')))
    }

    function PlanCard(props) {
      const usage = props.usage
      const now = props.now
      if (!usage) {
        return h('div', { className: 'dshark-card' },
          h('div', { className: 'dshark-title' }, '额度用量'), h('div', { className: 'dshark-muted' }, '加载中…'))
      }
      if (!usage.ok) {
        return h('div', { className: 'dshark-card' },
          h('div', { className: 'dshark-title' }, '额度用量'),
          h('div', { className: 'dshark-err' }, usage.error || '额度查询失败'))
      }
      const rows = (usage.windows || []).map((window) => h(WindowRow, { key: window.key, window, now }))
      const staleNote = usage.stale && usage.error
        ? h('div', { className: 'dshark-muted' }, '⚠ 刷新失败：' + usage.error + '（显示上次数据）')
        : null
      return h('div', { className: 'dshark-card' },
        h('div', { className: 'dshark-head' },
          h('div', { className: 'dshark-title' },
            '额度用量',
            usage.planType ? h('span', { className: 'dshark-plan-badge' }, usage.planType.toUpperCase()) : null)),
        rows.length ? rows : h('div', { className: 'dshark-muted' }, '未查到有效套餐窗口'),
        staleNote)
    }

    function switchStyle(on, disabled) {
      const brand = 'var(--dsw-alias-brand-primary,#4d7cfe)'
      return {
        position: 'relative',
        flex: '0 0 auto',
        width: '30px',
        height: '17px',
        padding: 0,
        boxSizing: 'border-box',
        borderRadius: '999px',
        border: '1px solid ' + (on ? brand : 'var(--dsw-alias-border-l2,rgba(127,127,127,.55))'),
        background: on ? brand : 'rgba(127,127,127,.28)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background .15s,border-color .15s',
      }
    }
    function knobStyle(on) {
      return {
        position: 'absolute',
        top: '1px',
        left: on ? '14px' : '1px',
        width: '13px',
        height: '13px',
        borderRadius: '50%',
        background: '#fff',
        transition: 'left .15s',
        pointerEvents: 'none',
      }
    }

    function ModelRow(props) {
      const row = props.row
      const busy = props.busy
      const tags = [h('span', { className: 'dshark-tag', key: 'ctx' }, fmtCtx(row.contextWindow))]
      if (Array.isArray(row.input) && row.input.indexOf('image') >= 0) {
        tags.push(h('span', { className: 'dshark-tag', key: 'img' }, '图'))
      }
      if (row.thinking !== 'none') {
        tags.push(h('span', { className: 'dshark-tag dshark-tag-think', key: 'think' }, row.thinking === 'standard' ? '可关闭思考' : '始终思考'))
      }
      const effortText = row.efforts && row.efforts.length
        ? '思考档位：' + row.efforts.map((e) => e.level + (e.level === e.wire ? '' : '→' + e.wire)).join(' / ')
        : '不支持思考'
      return h('div', { className: 'dshark-model' },
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': row.enabled ? 'true' : 'false',
          'aria-label': row.name,
          title: row.enabled ? '从 Provider 中移除' : '加入 Provider',
          style: switchStyle(row.enabled, busy),
          disabled: busy,
          onClick: (event) => {
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
            props.onToggle(row.id, !row.enabled)
          },
        }, h('span', { style: knobStyle(row.enabled) })),
        h('div', { className: 'dshark-model-main' + (row.enabled ? '' : ' dshark-model-off') },
          h('div', { className: 'dshark-model-name' }, row.name),
          h('div', { className: 'dshark-model-id' }, row.id),
          h('div', { className: 'dshark-efforts' }, effortText)),
        h('div', { className: 'dshark-tags' }, tags))
    }

    function ModelsCard(props) {
      const models = props.models
      const provider = props.provider
      const keys = props.keys
      const onToggle = props.onToggle
      const [busy, setBusy] = React.useState(false)
      const [catalogBusy, setCatalogBusy] = React.useState(false)

      if (!models) {
        return h('div', { className: 'dshark-card' },
          h('div', { className: 'dshark-title' }, '模型目录'), h('div', { className: 'dshark-muted' }, '加载中…'))
      }

      const rows = models.rows || []
      const chatRows = rows.filter((row) => row.chat)
      const enabledCount = chatRows.filter((row) => row.enabled).length
      const anyBusy = busy || catalogBusy

      const toggle = (id, on) => {
        if (anyBusy) return
        setBusy(true)
        onToggle(id, on).finally(() => setBusy(false))
      }

      const syncAll = () => {
        if (anyBusy) return
        setBusy(true)
        API.sync().then(emit).catch(() => {}).finally(() => setBusy(false))
      }

      const reloadCatalog = () => {
        if (anyBusy) return
        setCatalogBusy(true)
        API.catalog().then(emit).catch(() => {}).finally(() => setCatalogBusy(false))
      }

      const providerError = provider && !provider.ok ? provider.error : ''
      return h('div', { className: 'dshark-card' },
        h('div', { className: 'dshark-head' },
          h('div', { className: 'dshark-title' },
            '模型目录',
            h('span', { className: 'dshark-muted' }, '已加入 ' + enabledCount + ' / ' + chatRows.length)),
          h('div', { className: 'dshark-actions' },
            h('button', { className: 'dshark-btn', onClick: reloadCatalog, disabled: anyBusy }, catalogBusy ? '拉取中…' : '重新拉取目录'),
            h('button', { className: 'dshark-btn dshark-btn-primary', onClick: syncAll, disabled: anyBusy }, busy ? '写入中…' : '同步全部')))
        ,
        h('div', { className: 'dshark-muted' },
          'Provider ' + ((provider && provider.route) || 'arkcli-agent-plan') +
          (models.at ? ' · 目录更新于 ' + fmtTime(models.at) : '')),
        models.ok ? null : h('div', { className: 'dshark-err' }, '模型目录查询失败：' + (models.error || '未知错误')),
        providerError ? h('div', { className: 'dshark-err' }, providerError) : null,
        h('div', { className: 'dshark-models' },
          chatRows.map((row) => h(ModelRow, {
            key: row.id,
            row,
            busy: anyBusy,
            onToggle: toggle,
          }))),
        h('div', { style: { marginTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16))', paddingTop: 8 } },
          h('div', { className: 'dshark-row' },
            h('span', { className: 'dshark-muted' }, '模型调用 API Key'),
            h('span', { className: 'dshark-muted' }, keys && keys.modelKey ? '已配置（' + keys.modelKeyEnv + '）' : '未配置')),
          h('div', { className: 'dshark-row' },
            h('span', { className: 'dshark-muted' }, '控制面 AK/SK（目录与额度）'),
            h('span', { className: 'dshark-muted' }, keys && keys.controlPlane ? '已配置' : '未配置'))))
    }

    function SettingsPage() {
      const used = useStatus()
      const status = used.status
      const now = used.now
      const [busy, setBusy] = React.useState(false)
      // 开关的乐观状态：{ [modelId]: boolean }，保存完成后以服务端返回为准。
      const [localEnabled, setLocalEnabled] = React.useState(null)
      const updated = status && status.at ? '更新于 ' + fmtTime(status.at) : ''

      const view = React.useMemo(() => {
        if (!status || !status.models || !status.models.rows) return status ? status.models : null
        if (!localEnabled) return status.models
        const rows = status.models.rows.map((row) => (
          Object.hasOwn(localEnabled, row.id) ? Object.assign({}, row, { enabled: localEnabled[row.id] }) : row
        ))
        return Object.assign({}, status.models, {
          rows,
          count: rows.filter((row) => row.chat && row.enabled).length,
        })
      }, [status, localEnabled])

      const refresh = () => {
        if (busy) return
        setBusy(true)
        setLocalEnabled(null)
        API.refresh().then(emit).catch(() => {}).finally(() => setBusy(false))
      }

      const onToggle = (id, on) => {
        setLocalEnabled((current) => Object.assign({}, current || {}, { [id]: on }))
        return API.toggle(id, on)
          .then((next) => {
            emit(next)
            setLocalEnabled(null)
          })
          .catch(() => {
            setLocalEnabled((current) => {
              const rest = Object.assign({}, current || {})
              delete rest[id]
              return rest
            })
            return loadStatus()
          })
      }

      return h('div', { className: 'dshark-page' },
        h(StyleTag, { key: 'style' }),
        h('div', { className: 'dshark-head' },
          h('div', { className: 'dshark-title' }, status && status.usage && status.usage.planType
            ? '套餐 ' + status.usage.planType.toUpperCase()
            : '使用状态'),
          h('div', { className: 'dshark-actions' },
            h('span', { className: 'dshark-muted' }, updated),
            h('button', { className: 'dshark-btn', onClick: refresh, disabled: busy }, busy ? '刷新中…' : '刷新'))),
        status && status.error ? h('div', { className: 'dshark-err' }, status.error) : null,
        h(PlanCard, { usage: status ? status.usage : null, now }),
        h(ModelsCard, {
          models: view,
          provider: status ? status.provider : null,
          keys: status ? status.keys : null,
          onToggle,
        }))
    }

    function DockReadout() {
      const used = useStatus()
      const status = used.status
      const now = used.now
      if (!status || !status.usage || !status.usage.ok || !status.usage.windows || status.usage.windows.length === 0) {
        return h(React.Fragment, null,
          h(StyleTag, { key: 'style' }),
          h('span', { className: 'dshark-dock', style: { display: 'none' }, key: 'text' }, ''))
      }
      const short = { five_hour: '5h', daily: '日', weekly: '周', monthly: '月' }
      const segments = status.usage.windows.map((window) => (short[window.key] || window.label) + ' ' + (window.percent || 0) + '%')
      let nearest = 0
      for (const window of status.usage.windows) {
        if (window.resetMs > 0 && (nearest === 0 || window.resetMs < nearest)) nearest = window.resetMs
      }
      const title = '火山方舟 Agent Plan' + (status.usage.planType ? ' · ' + status.usage.planType : '') + ' · 点击刷新'
      const text = '火山Agent ' + segments.join(' · ') + (nearest ? ' · 重置 ' + fmtCountdown(nearest - now) : '')
      return h(React.Fragment, null,
        h(StyleTag, { key: 'style' }),
        h('span', { className: 'dshark-dock', title, onClick: () => { forceRefresh() }, key: 'text' }, text))
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'ark-plan', order: 26, label: '方舟 Agent Plan' },
        SettingsPage,
      ))
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
        { name: 'conversation.composer.dock', id: 'ark-plan-dock', order: 21, label: '方舟 Agent Plan 额度' },
        DockReadout,
      ))
    }

    return { inject: ['slots'], apply }
  },
})
