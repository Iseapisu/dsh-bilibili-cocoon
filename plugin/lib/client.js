// Client half: a pill in the conversation header that expands into the
// newcomer / fed-to-you / you-watch comparison.

window.__ModuleLoader__.load({
  id: 'dsh-bilibili-cocoon',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement

    var NS = 'dsh-bilibili-cocoon'
    var ROUTE = '/dsh-bilibili-cocoon/summary'

    var PANEL_STYLE = {
      position: 'absolute',
      top: '30px',
      right: 0,
      width: '380px',
      maxWidth: 'calc(100vw - 16px)',
      maxHeight: '70vh',
      overflowY: 'auto',
      padding: '12px 14px',
      borderRadius: '10px',
      background: 'rgba(28, 30, 34, 0.98)',
      color: '#e6e6e6',
      border: '1px solid rgba(255, 255, 255, 0.12)',
      boxShadow: '0 10px 30px rgba(0, 0, 0, 0.45)',
      fontSize: '12px',
      lineHeight: 1.55,
      whiteSpace: 'normal',
      textAlign: 'left',
      zIndex: 2147483000,
    }

    var PILL_STYLE = {
      height: '24px',
      padding: '0 9px',
      borderRadius: '6px',
      border: '1px solid currentColor',
      background: 'transparent',
      color: 'inherit',
      fontSize: '12px',
      lineHeight: '22px',
      cursor: 'pointer',
      opacity: 0.78,
    }

    var NUM = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
    var DIM = { opacity: 0.6 }
    var STAT_STYLE = Object.assign({}, DIM, { fontSize: '11px', marginBottom: '4px' })

    var LINK_STYLE = {
      color: '#8ab4f8',
      textDecoration: 'none',
      display: 'block',
      maxHeight: '2.9em',
      overflow: 'hidden',
      wordBreak: 'break-word',
      lineHeight: 1.45,
    }

    var EXPAND_STYLE = {
      margin: '2px 0 6px',
      padding: '4px 8px',
      background: 'rgba(255, 255, 255, 0.04)',
      borderLeft: '2px solid rgba(255, 255, 255, 0.2)',
      borderRadius: '4px',
    }

    function pct(x) {
      var n = Number(x)
      return isFinite(n) ? (n * 100).toFixed(1) + '%' : '-'
    }

    // Numeric field -> number, or null when it is missing / not a usable number.
    // null and undefined must not become 0 here: repeatRate 0 is a real value.
    function num(x) {
      if (x === null || x === undefined || x === '') return null
      var t = typeof x
      if (t !== 'number' && t !== 'string') return null
      var n = Number(x)
      return Number.isFinite(n) ? n : null
    }

    // The headline of the expanded block: how many rows the theme held and how
    // much of it was repeated. Renders nothing when the numbers are unusable.
    function statLine(attr) {
      var a = attr || {}
      var appearances = num(a.appearances)
      var uniqueBvids = num(a.uniqueBvids)
      var repeatRate = num(a.repeatRate)
      if (appearances === null || uniqueBvids === null || repeatRate === null) return null
      var detail = repeatRate === 0 ? '零重复曝光' : '重复率 ' + (repeatRate * 100).toFixed(0) + '%'
      return h('div', { style: STAT_STYLE }, '共 ' + appearances + ' 条 · ' + detail)
    }

    function videoItem(v, key) {
      var video = v || {}
      var title = video.title
      if (title === null || title === undefined || title === '') title = '未知标题'
      var upName = video.upName
      if (upName === null || upName === undefined || upName === '') upName = '未知 UP'
      var rounds = num(video.rounds)
      var meta = upName
      if (rounds !== null && rounds > 1) meta = upName + ' · ' + rounds + ' 轮都推了'
      var url = typeof video.url === 'string' && video.url ? video.url : null

      return h(
        'div',
        { key: key, style: { padding: '4px 0' } },
        url
          ? h(
              'a',
              {
                href: url,
                target: '_blank',
                rel: 'noopener noreferrer',
                onClick: function (e) {
                  e.stopPropagation()
                },
                style: LINK_STYLE,
              },
              title,
            )
          : h('div', { style: LINK_STYLE }, title),
        h('div', { style: Object.assign({}, DIM, { marginTop: '2px' }) }, meta),
      )
    }

    function expandBlock(attr) {
      var list = attr && Array.isArray(attr.topVideos) ? attr.topVideos.slice(0, 3) : []
      return h(
        'div',
        { style: EXPAND_STYLE },
        statLine(attr),
        list.length
          ? list.map(function (v, i) {
              return videoItem(v, (v && v.bvid) || i)
            })
          : h('div', { style: DIM }, '这个主题没有可列出的视频。'),
      )
    }

    function themeRow(a, attr, expanded, onToggle) {
      a = a || {}
      var id = a.id !== undefined && a.id !== null ? String(a.id) : ''
      var canExpand = !!attr
      var open = canExpand && expanded === id

      var cells = [
        h(
          'span',
          { key: 'name', style: { display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 } },
          canExpand ? h('span', { style: { opacity: 0.6, flex: 'none' } }, open ? '▾' : '▸') : null,
          h(
            'span',
            { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            a.name === null || a.name === undefined ? '未知主题' : a.name,
          ),
        ),
        h('span', { key: 'guest', style: Object.assign({}, NUM, DIM) }, pct(a.guestShare)),
        h('span', { key: 'login', style: Object.assign({}, NUM, { fontWeight: 600 }) }, pct(a.loginShare)),
        h('span', { key: 'history', style: Object.assign({}, NUM, DIM) }, pct(a.historyShare)),
      ]

      var gridStyle = {
        display: 'grid',
        gridTemplateColumns: '1fr 46px 46px 46px',
        gap: '4px',
        width: '100%',
        padding: '2px 0',
        borderRadius: '4px',
      }

      // Only attributed themes get a real button; others stay inert rows with no
      // clickable affordance.
      var row = canExpand
        ? h(
            'button',
            {
              type: 'button',
              onClick: function () {
                onToggle(id)
              },
              onMouseEnter: function (e) {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)'
              },
              onMouseLeave: function (e) {
                e.currentTarget.style.background = 'transparent'
              },
              style: Object.assign({}, gridStyle, {
                appearance: 'none',
                border: 'none',
                margin: 0,
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
              }),
            },
            cells,
          )
        : h('div', { style: gridStyle }, cells)

      return h('div', { key: id }, row, open ? expandBlock(attr) : null)
    }

    function Body(props) {
      var expandedState = React.useState(null)
      var expanded = expandedState[0]
      var setExpanded = expandedState[1]

      var data = props.data
      if (props.phase === 'loading') return h('div', { style: DIM }, '读取中…')
      if (props.phase === 'error') {
        return h(
          'div',
          null,
          h('div', null, '暂时读不到数据。'),
          h('div', { style: Object.assign({}, DIM, { marginTop: '4px' }) }, props.error),
          h(
            'button',
            { type: 'button', onClick: props.onRetry, style: Object.assign({}, PILL_STYLE, { marginTop: '8px' }) },
            '重试',
          ),
        )
      }
      if (!data || data.ok !== true) {
        return h(
          'div',
          null,
          h('div', null, (data && data.error) || '没有数据'),
          h('div', { style: Object.assign({}, DIM, { marginTop: '4px' }) }, '先跑一次：node tools/exposure-login.mjs 3 28'),
        )
      }

      var rows = (data.amplification || []).slice(0, 4)

      // Older summaries have no attribution; build a lookup that tolerates both
      // a missing field and malformed entries.
      var attrMap = {}
      if (Array.isArray(data.attribution)) {
        data.attribution.forEach(function (item) {
          if (!item || item.id === undefined || item.id === null) return
          attrMap[String(item.id)] = item
        })
      }

      var advice = data.advice && typeof data.advice.text === 'string' && data.advice.text ? data.advice.text : ''
      var fallbackLine = rows[0]
        ? '这一周算法在你身上加码最多的是 ' + rows[0].name + '（' + (rows[0].ratio === null ? '路人没看到' : rows[0].ratio + '×') + '）。'
        : null

      return h(
        'div',
        null,
        h(
          'div',
          { style: Object.assign({}, DIM, { marginBottom: '8px' }) },
          data.date + ' · ' + data.rounds + ' 轮 · 登录取 ' + data.login.count + ' 条 / 游客 ' + data.guest.count + ' 条',
        ),
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: '1fr 46px 46px 46px', gap: '4px', paddingBottom: '4px' } },
          h('span', { style: DIM }, '主题'),
          h('span', { style: Object.assign({}, NUM, DIM) }, '路人'),
          h('span', { style: Object.assign({}, NUM, DIM) }, '推给你'),
          h('span', { style: Object.assign({}, NUM, DIM) }, '你在看'),
        ),
        rows.map(function (a) {
          var id = a && a.id !== undefined && a.id !== null ? String(a.id) : ''
          return themeRow(a, attrMap[id] || null, expanded, function (nextId) {
            setExpanded(expanded === nextId ? null : nextId)
          })
        }),
        h('div', { style: { marginTop: '10px', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '8px' } },
          advice ? h('div', { style: { whiteSpace: 'pre-wrap' } }, advice) : fallbackLine,
          h('div', { style: Object.assign({}, DIM, { marginTop: '4px' }) },
            '顺序按「推给你 − 路人」排；覆盖率 ' + pct(data.login.coverage) + '，未分类不计入比值。'),
        ),
      )
    }

    function CocoonPill() {
      var state = React.useState(false)
      var open = state[0]
      var setOpen = state[1]

      var phaseState = React.useState('loading')
      var phase = phaseState[0]
      var setPhase = phaseState[1]

      var dataState = React.useState(null)
      var data = dataState[0]
      var setData = dataState[1]

      var errState = React.useState('')
      var error = errState[0]
      var setError = errState[1]

      var attemptState = React.useState(0)
      var attempt = attemptState[0]
      var setAttempt = attemptState[1]

      React.useEffect(function () {
        var alive = true
        setPhase('loading')
        fetch(ROUTE, { credentials: 'same-origin' })
          .then(function (r) {
            return r.json()
          })
          .then(function (j) {
            if (!alive) return
            setData(j)
            setPhase('ready')
          })
          .catch(function (err) {
            if (!alive) return
            setError(String((err && err.message) || err))
            setPhase('error')
          })
        return function () {
          alive = false
        }
      }, [attempt])

      var label = '茧房'
      if (phase === 'error') label = '茧房 ?'
      else if (data && data.ok && data.headline) label = '茧房 ' + data.headline.ratio + '×'

      return h(
        'div',
        { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
        h(
          'button',
          {
            type: 'button',
            title: data && data.ok && data.headline ? data.headline.name + ' ' + data.headline.ratio + '×（相对游客基线）' : 'B站信息茧房',
            onClick: function () {
              setOpen(!open)
            },
            style: PILL_STYLE,
          },
          open ? label + ' ∧' : label,
        ),
        open
          ? h(
              'div',
              { style: PANEL_STYLE },
              h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, 'B站信息茧房'),
              h(Body, {
                phase: phase,
                data: data,
                error: error,
                onRetry: function () {
                  setAttempt(attempt + 1)
                },
              }),
            )
          : null,
      )
    }

    return {
      name: NS,
      inject: ['slots'],
      apply: function (ctx) {
        ctx.effect(function () {
          return ctx.slots.inject('conversation.session.header.actions', function () {
            return ctx.slots.register(
              {
                name: 'conversation.session.header.actions',
                id: NS,
                order: 13,
              },
              CocoonPill,
            )
          })
        }, 'bili-cocoon: header pill')
      },
    }
  },
})
