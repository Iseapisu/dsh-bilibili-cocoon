/*
 * dsh-bilibili-cocoon — 客户端半边。
 *
 * 挂载方式与 dsh-local-engines 一致：执行本文件只登记 factory，真正的注册
 * 发生在模块被 materialize 时，随这个插件的 client fiber 一起销毁。
 *
 * 数据从 `GET /dsh-bilibili-cocoon/summary` 取（Host 半边读 SQLite 后算好的摘要）。
 * 桌面端会把页面请求转发给 Host，相对 fetch 同源，不需要 CORS 处理。
 *
 * 失败姿态：拉不到数据就显示「茧房 ?」，面板里给出原因。绝不因为后端没数据
 * 让这个 pill 阻塞或抛错——它挂在会话头部，崩了很难看。
 */
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
      width: '330px',
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

    function pct(x) {
      var n = Number(x)
      return isFinite(n) ? (n * 100).toFixed(1) + '%' : '-'
    }

    function themeRow(a, key) {
      return h(
        'div',
        {
          key: key,
          style: {
            display: 'grid',
            gridTemplateColumns: '1fr 46px 46px 46px',
            gap: '4px',
            padding: '2px 0',
          },
        },
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, a.name),
        h('span', { style: Object.assign({}, NUM, DIM) }, pct(a.guestShare)),
        h('span', { style: Object.assign({}, NUM, { fontWeight: 600 }) }, pct(a.loginShare)),
        h('span', { style: Object.assign({}, NUM, DIM) }, pct(a.historyShare)),
      )
    }

    function Body(props) {
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
          return themeRow(a, a.id)
        }),
        h('div', { style: { marginTop: '10px', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '8px' } },
          rows[0]
            ? h('div', null, '这一周算法在你身上加码最多的是 ' + rows[0].name + '（' + (rows[0].ratio === null ? '路人没看到' : rows[0].ratio + '×') + '）。')
            : null,
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

      // attempt 是重试计数：只靠 phase 会让「失败 → 重跑 effect → 再失败」变成死循环
      var attemptState = React.useState(0)
      var attempt = attemptState[0]
      var setAttempt = attemptState[1]

      React.useEffect(function () {
        // 挂载就拉一次：pill 要常显倍率，不能等用户点开
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
