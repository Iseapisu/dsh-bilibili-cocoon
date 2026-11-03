// Client half: a pill in the conversation header that expands into the
// newcomer / fed-to-you / you-watch comparison.

window.__ModuleLoader__.load({
  id: 'dsh-bilibili-cocoon',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement

    var NS = 'dsh-bilibili-cocoon'
    var ROUTE = '/dsh-bilibili-cocoon/summary'

    // Animation lives in one injected stylesheet: inline styles cannot express a
    // @keyframes, and the ring should arrive as a ring being drawn rather than as
    // a finished picture. The panel unmounts when it closes, so reopening replays
    // it. The prefers-reduced-motion block is not optional — a spinning pie is
    // exactly the kind of motion someone asking for less of it does not want.
    var STYLE_ID = 'dsh-bili-cocoon-styles'
    var STYLES = [
      '@keyframes cocoon-ring-in {',
      '  from { transform: rotate(-110deg) scale(.55); opacity: 0 }',
      '  55% { opacity: 1 }',
      '  to { transform: rotate(0deg) scale(1); opacity: 1 }',
      '}',
      '.cocoon-ring { animation: cocoon-ring-in .64s cubic-bezier(.22,.85,.3,1) both }',
      '@keyframes cocoon-row-in {',
      '  from { opacity: 0; transform: translateX(-8px) }',
      '  to { opacity: 1; transform: translateX(0) }',
      '}',
      '.cocoon-row { animation: cocoon-row-in .42s ease-out both }',
      '@media (prefers-reduced-motion: reduce) {',
      '  .cocoon-ring, .cocoon-row { animation: none }',
      '}',
    ].join('\n')

    function installStyles() {
      if (typeof document === 'undefined' || !document.head) return function () {}
      if (document.getElementById(STYLE_ID)) return function () {}
      var tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = STYLES
      document.head.appendChild(tag)
      return function () {
        if (tag.parentNode) tag.parentNode.removeChild(tag)
      }
    }

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

    // Partition pie. The panel is a fixed 380px wide, so the circle and the legend
    // take fixed sizes rather than a flex ratio that reflows on every render.
    var PIE_SIZE = 108
    var PIE_HOLE = 62
    var PIE_COLORS = ['#8ab4f8', '#f2a65a', '#7bd88f', '#e08fd0', '#f7d060', '#7fd1d8', '#9aa4b2']
    var PIE_SECTION = {
      marginTop: '10px',
      borderTop: '1px solid rgba(255,255,255,0.1)',
      paddingTop: '8px',
    }
    var PIE_HEAD = Object.assign({}, DIM, {
      display: 'flex',
      justifyContent: 'space-between',
      fontSize: '11px',
      marginBottom: '8px',
    })
    var PIE_BODY = { display: 'flex', alignItems: 'center', gap: '16px' }
    var PIE_LEGEND = { flex: 1, minWidth: 0, fontSize: '11px', lineHeight: '1.8' }
    var PIE_SWATCH = { width: '8px', height: '8px', borderRadius: '2px', flex: 'none' }

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

    // The badge shows the leading theme and its share of the home feed: "AI 27%"
    // reads on its own, while "2.9x" only means something once you know what it is
    // measured against.
    function shortThemeName(name) {
      if (typeof name !== 'string' || name === '') return null
      var cut = name.indexOf(' / ')
      return cut > 0 ? name.slice(0, cut) : name
    }

    function badgeInfo(data) {
      var empty = { label: '题材', tooltip: 'B站首页题材分布' }
      if (!data || data.ok !== true) return empty
      var focus = data.feedFocus
      var top = focus && typeof focus === 'object' ? focus.top : null
      var fullName = top && typeof top.name === 'string' && top.name !== '' ? top.name : null
      var shortName = shortThemeName(fullName)
      var share = top ? num(top.share) : null
      if (shortName === null || share === null) return empty
      var tip = '你的首页 ' + pct(share) + ' 是 ' + fullName
      var base = num(top.baselineShare)
      if (base !== null && base > 0) tip += '，路人只有 ' + pct(base)
      return { label: shortName + ' ' + Math.round(share * 100) + '%', tooltip: tip }
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

    // The share and the baseline come from the host already on the same measure
    // (distinct videos), so the multiple is exactly those two divided and nothing
    // here has to re-derive a pair. Pulling a matching share out of
    // `amplification` was a client-side patch for a host that counted the
    // baseline in rows; with the host fixed it would only hide future drift.
    function focusPair(top) {
      var share = num(top.share)
      var baseline = num(top.baselineShare)
      var multiple = null

      if (baseline !== null && baseline > 0) {
        if (share !== null) multiple = share / baseline
      } else if (baseline === null && share !== null) {
        // No baseline to divide by: quote the host's multiple on its own, dedup
        // first for the same reason the badge prefers it.
        multiple = num(top.ratioDedup)
        if (multiple === null) multiple = num(top.ratio)
      }

      return { share: share, baseline: baseline, multiple: multiple }
    }

    var FOCUS_SECTION = {
      marginTop: '2px',
      marginBottom: '8px',
      paddingTop: '8px',
      paddingBottom: '8px',
      borderTop: '1px solid rgba(255,255,255,0.1)',
      borderBottom: '1px solid rgba(255,255,255,0.1)',
    }
    var FOCUS_ROW = { display: 'flex', justifyContent: 'space-between', gap: '8px' }
    var FOCUS_LEFT = {
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }

    // What the home feed is actually made of, above the per-theme table. Every
    // number here is read from `feedFocus` alone. A field that is missing drops
    // its own line; a block with no lead theme at all renders nothing, because a
    // half-filled block reads as "measured zero".
    // The one number the panel exists for: which theme owns the home feed, how big
    // it is, and what a stranger would see instead. Two lines, no heading, no
    // secondary counts — those belong in the table below, if anywhere.
    function feedFocusBlock(focus) {
      if (!focus || typeof focus !== 'object') return null
      var top = focus.top
      if (!top || typeof top !== 'object') return null
      var name = typeof top.name === 'string' && top.name !== '' ? top.name : null
      if (name === null) return null

      var pair = focusPair(top)
      if (pair.share === null) return null

      var sub = []
      if (pair.baseline !== null) sub.push('路人 ' + pct(pair.baseline))
      if (pair.multiple !== null) sub.push('你是 ' + pair.multiple.toFixed(1) + ' 倍')

      return h(
        'div',
        { style: FOCUS_SECTION },
        h(
          'div',
          { style: FOCUS_ROW },
          h('span', { style: FOCUS_LEFT }, name),
          h(
            'span',
            { style: { fontSize: '18px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' } },
            pct(pair.share),
          ),
        ),
        sub.length ? h('div', { style: Object.assign({}, DIM, { marginTop: '2px' }) }, sub.join('，')) : null,
      )
    }

    // A theme's share in the table. The dedup measure is the main one now: the
    // guest feed repeats 38 videos across 82 rows, so rows understate the guest
    // baseline. Old summaries carry only the row shares, so fall back to those.
    function shareCell(a, dedupKey, rowKey) {
      var dedup = num(a[dedupKey])
      if (dedup !== null) return pct(dedup)
      var row = num(a[rowKey])
      return row === null ? '-' : pct(row)
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
        h('span', { key: 'guest', style: Object.assign({}, NUM, DIM) }, shareCell(a, 'guestShareDedup', 'guestShare')),
        h('span', { key: 'login', style: Object.assign({}, NUM, { fontWeight: 600 }) }, shareCell(a, 'loginShareDedup', 'loginShare')),
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

    // The home feed's partition mix as a ring. This replaces the 0-100 composite
    // index on the panel: a share of a circle needs no formula to read, and
    // "14 / 19 个分区" answers the other question - how much of the site this feed
    // touches at all.
    function categoryBlock(cats) {
      if (!cats || typeof cats !== 'object') return null
      var items = Array.isArray(cats.items) ? cats.items : []
      if (!items.length) return null

      // Seven slices is as many as a 108px ring can carry; the tail becomes one
      // grey slice with its own legend row, never silently dropped.
      var slices = []
      items.slice(0, 6).forEach(function (it, i) {
        if (!it || typeof it !== 'object') return
        var share = num(it.share)
        if (share === null || share <= 0) return
        var name = typeof it.name === 'string' && it.name !== '' ? it.name : '未分类'
        slices.push({ name: name, share: share, color: PIE_COLORS[i] })
      })
      if (!slices.length) return null

      var tail = items.slice(6)
      if (tail.length) {
        var tailShare = tail.reduce(function (sum, it) {
          var s = it && typeof it === 'object' ? num(it.share) : null
          return s === null ? sum : sum + s
        }, 0)
        slices.push({ name: '其余 ' + tail.length + ' 个分区', share: tailShare, color: PIE_COLORS[6] })
      }

      var acc = 0
      var stops = slices.map(function (s) {
        var from = acc
        acc += s.share
        return s.color + ' ' + (from * 100).toFixed(2) + '% ' + (acc * 100).toFixed(2) + '%'
      })

      var covered = num(cats.covered)
      var total = num(cats.total)
      var counter = covered !== null && total !== null ? covered + ' / ' + total + ' 个分区' : null
      var holeOffset = (PIE_SIZE - PIE_HOLE) / 2 + 'px'

      return h(
        'div',
        { style: PIE_SECTION },
        h('div', { style: PIE_HEAD }, h('span', null, '分区构成'), h('span', null, counter)),
        h(
          'div',
          { style: PIE_BODY },
          h(
            'div',
            {
              className: 'cocoon-ring',
              style: { position: 'relative', width: PIE_SIZE + 'px', height: PIE_SIZE + 'px', flex: 'none' },
            },
            h('div', {
              style: {
                width: '100%',
                height: '100%',
                borderRadius: '50%',
                background: 'conic-gradient(' + stops.join(', ') + ')',
              },
            }),
            h('div', {
              style: {
                position: 'absolute',
                top: holeOffset,
                left: holeOffset,
                width: PIE_HOLE + 'px',
                height: PIE_HOLE + 'px',
                borderRadius: '50%',
                background: '#1c1e22',
              },
            }),
          ),
          h(
            'div',
            { style: PIE_LEGEND },
            slices.map(function (s, i) {
              return h(
                'div',
                {
                  key: 'p' + i,
                  className: 'cocoon-row',
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    animationDelay: 140 + i * 45 + 'ms',
                  },
                },
                h('span', { style: Object.assign({}, PIE_SWATCH, { background: s.color }) }),
                h('span', { style: { flex: 1, opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.name),
                h('span', { style: { fontVariantNumeric: 'tabular-nums', opacity: 0.75 } }, pct(s.share)),
              )
            }),
          ),
        ),
      )
    }

    // The breakout block sits at the bottom of the panel and says what it is:
    // videos the guest sample saw that this home feed never did, ordered by how
    // little their theme weighs at home. Not "for you" and not "you may be
    // interested" - the panel cannot know that, and the honest claim is only ever
    // "this reached a logged-out viewer and not you".
    var BREAKOUT_SECTION = {
      marginTop: '10px',
      borderTop: '1px solid rgba(255,255,255,0.1)',
      paddingTop: '8px',
      fontSize: '12px',
    }
    var BREAKOUT_HEAD = { fontWeight: 600, marginBottom: '2px' }
    var BREAKOUT_ITEM = { padding: '3px 0' }
    var BREAKOUT_META = Object.assign({}, DIM, { marginTop: '1px' })

    // One row: the title is the link, the line under it names the uploader, the
    // theme and the theme's share of the home feed. Anything missing degrades to a
    // phrase or disappears - never to the string 'undefined' or to NaN.
    function breakoutItem(v, i) {
      var item = v && typeof v === 'object' ? v : {}
      var title = typeof item.title === 'string' && item.title !== '' ? item.title : '未知标题'
      var upName = typeof item.upName === 'string' && item.upName !== '' ? item.upName : '未知 UP'
      var themeName = typeof item.themeName === 'string' && item.themeName !== '' ? item.themeName : null

      var meta = upName
      if (themeName !== null) meta += ' · ' + themeName

      // url is what the host sent; a summary without it still gets a link because
      // the bvid is enough to build one. No url and no bvid renders plain text.
      var url = typeof item.url === 'string' && item.url ? item.url : null
      if (url === null && typeof item.bvid === 'string' && item.bvid) {
        url = 'https://www.bilibili.com/video/' + item.bvid
      }

      var label = String(i + 1) + '. ' + title
      var key = typeof item.bvid === 'string' && item.bvid ? item.bvid : 'pick' + i

      return h(
        'div',
        { key: key, style: BREAKOUT_ITEM },
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
              label,
            )
          : h('div', { style: LINK_STYLE }, label),
        h('div', { style: BREAKOUT_META }, meta),
      )
    }

    // Nothing at all when the summary has no block, no items, or a malformed one:
    // an old host and an empty guest sample must both leave the panel as it was.
    function breakoutBlock(breakout) {
      if (!breakout || typeof breakout !== 'object') return null
      var items = Array.isArray(breakout.items) ? breakout.items : []
      if (!items.length) return null

      // One label, no lead-in sentence: the list is self-describing once the
      // uploader and theme sit under each title.
      var candidates = num(breakout.candidates)
      var head = '路人能刷到，你刷不到'
      if (candidates !== null && candidates > 0) head += '（' + candidates + ' 条）'

      return h(
        'div',
        { style: BREAKOUT_SECTION },
        h('div', { style: BREAKOUT_HEAD }, head),
        items.map(function (v, i) {
          return breakoutItem(v, i)
        }),
      )
    }

    // Just the day being described. Row counts and sampling rounds belong in the
    // README: in a 380px panel they are noise, and "82 rows over 38 videos" is
    // exactly the kind of caveat that made this panel unreadable.
    function dateLine(data) {
      var d = data && typeof data === 'object' ? data : {}
      return typeof d.date === 'string' && d.date !== '' ? d.date : ''
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

      // A malformed amplification list must not take the panel down with it.
      var rows = Array.isArray(data.amplification) ? data.amplification.slice(0, 4) : []

      // Older summaries have no attribution; build a lookup that tolerates both
      // a missing field and malformed entries.
      var attrMap = {}
      if (Array.isArray(data.attribution)) {
        data.attribution.forEach(function (item) {
          if (!item || item.id === undefined || item.id === null) return
          attrMap[String(item.id)] = item
        })
      }

      return h(
        'div',
        null,
        feedFocusBlock(data.feedFocus),
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
        categoryBlock(data.categories),
        breakoutBlock(data.breakout),
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

      var badge = badgeInfo(data)
      var label = badge.label

      return h(
        'div',
        { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
        h(
          'button',
          {
            type: 'button',
            title: badge.tooltip,
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
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    marginBottom: '8px',
                  },
                },
                h('span', { style: { fontWeight: 600 } }, 'B站首页'),
                h('span', { style: Object.assign({}, DIM, { fontSize: '11px' }) }, dateLine(data)),
              ),
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
          return installStyles()
        }, 'bili-cocoon: styles')
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
