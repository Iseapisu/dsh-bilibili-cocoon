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
    // @keyframes, and each sector should swing into place rather than appear fully
    // drawn. The panel unmounts when it closes, so reopening replays it. The
    // prefers-reduced-motion block is not optional — a spinning pie is exactly the
    // kind of motion someone asking for less of it does not want.
    var STYLE_ID = 'dsh-bili-cocoon-styles'
    var STYLES = [
      '@keyframes cocoon-seg-in {',
      '  from { transform: rotate(-120deg) scale(.3) }',
      '  to { transform: rotate(0deg) scale(1) }',
      '}',
      '.cocoon-seg {',
      '  transform-box: view-box;',
      '  transform-origin: var(--seg-center, 54px) var(--seg-center, 54px);',
      '  animation: cocoon-seg-in .55s cubic-bezier(.22,.85,.3,1) both;',
      '  animation-delay: var(--seg-delay, 0ms);',
      '  cursor: pointer;',
      '}',
      '@keyframes cocoon-tag-in {',
      '  from { opacity: 0; transform: translateX(6px) scale(.96) }',
      '  to { opacity: 1; transform: none }',
      '}',
      '@keyframes cocoon-glyph-in {',
      '  from { opacity: 0; transform: rotate(-140deg) scale(.35) }',
      '  to { opacity: 1; transform: rotate(0) scale(1) }',
      '}',
      '.cocoon-tag {',
      '  animation: cocoon-tag-in .42s cubic-bezier(.22,.85,.3,1) backwards;',
      '  animation-delay: var(--tag-delay, 0ms);',
      '  cursor: pointer;',
      '}',
      '.cocoon-tag-glyph {',
      '  transform-box: fill-box;',
      '  transform-origin: center;',
      '  animation: cocoon-glyph-in .5s cubic-bezier(.22,.85,.3,1) both;',
      '  animation-delay: var(--tag-delay, 0ms);',
      '}',
      '.cocoon-tag > svg { transition: transform .18s cubic-bezier(.3,1.5,.5,1) }',
      '.cocoon-tag:hover > svg, .cocoon-tag.is-hot > svg { transform: scale(1.28) rotate(6deg) }',
      '@keyframes cocoon-chip-in {',
      '  from { opacity: 0; transform: translateY(2px) scale(.94) }',
      '  to { opacity: 1; transform: none }',
      '}',
      '@keyframes cocoon-dot-in {',
      '  from { transform: scale(.2); opacity: 0 }',
      '  to { transform: scale(1); opacity: 1 }',
      '}',
      '.cocoon-chip { animation: cocoon-chip-in .34s cubic-bezier(.22,.85,.3,1) backwards }',
      '.cocoon-chip-dot {',
      '  transform-box: fill-box;',
      '  transform-origin: center;',
      '  animation: cocoon-dot-in .4s cubic-bezier(.3,1.5,.5,1) backwards;',
      '}',
      '@media (prefers-reduced-motion: reduce) {',
      '  .cocoon-seg, .cocoon-tag, .cocoon-tag-glyph, .cocoon-chip, .cocoon-chip-dot { animation: none }',
      '  .cocoon-tag > svg { transform: none }',
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

    // Partition pie. The panel is a fixed 380px wide, so the ring and the legend
    // take fixed sizes rather than a flex ratio that reflows on every render.
    var PIE_SIZE = 108
    var PIE_R = 54
    var PIE_R_INNER = 32
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
    var PIE_LEGEND = {
      flex: 1,
      minWidth: 0,
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      fontSize: '11px',
      lineHeight: '1.8',
    }
    // Tags flow and wrap by their own content width; a full-width row made a
    // 14-partition legend read as a table instead of a set of tags.
    var TAG_FLOW = { display: 'flex', flexWrap: 'wrap', gap: '4px', minWidth: 0 }

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
          themeChip(themeHue(typeof top.id === 'string' ? top.id : null, name), name, {
            fontSize: '12px',
            padding: '2px 8px',
            boxSizing: 'border-box',
          }),
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
      var themeName = typeof a.name === 'string' && a.name !== '' ? a.name : null

      var cells = [
        h(
          'span',
          { key: 'name', style: { display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 } },
          canExpand ? h('span', { style: { opacity: 0.6, flex: 'none' } }, open ? '▾' : '▸') : null,
          // No id and no name: nothing to colour by, so it stays plain text. A
          // missing id with a real name still gets its name's fixed hue.
          themeName === null && id === ''
            ? h(
                'span',
                { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                '未知主题',
              )
            : themeChip(themeHue(id === '' ? null : id, themeName), themeName === null ? '未知主题' : themeName, {
                fontSize: '11px',
                padding: '0 6px',
              }),
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

    // A donut sector as an SVG path. Angles are degrees clockwise from 12 o'clock,
    // where a pie chart conventionally starts.
    function arcPath(cx, cy, rOuter, rInner, a0, a1) {
      var rad = function (a) {
        return ((a - 90) * Math.PI) / 180
      }
      var pt = function (r, a) {
        return [cx + r * Math.cos(rad(a)), cy + r * Math.sin(rad(a))]
      }
      var p0 = pt(rOuter, a0)
      var p1 = pt(rOuter, a1)
      var p2 = pt(rInner, a1)
      var p3 = pt(rInner, a0)
      var large = a1 - a0 > 180 ? 1 : 0
      return (
        'M' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) +
        ' A' + rOuter + ' ' + rOuter + ' 0 ' + large + ' 1 ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2) +
        ' L' + p2[0].toFixed(2) + ' ' + p2[1].toFixed(2) +
        ' A' + rInner + ' ' + rInner + ' 0 ' + large + ' 0 ' + p3[0].toFixed(2) + ' ' + p3[1].toFixed(2) +
        ' Z'
      )
    }

    // Every partition that actually appears gets its own sector, so there is no
    // merged grey "rest" wedge — that wedge was the largest shape on the ring and
    // read as the account's top category, which is backwards. Colours are generated
    // instead of listed because a 14-slice ring needs 14 of them: one hue step per
    // sector with alternating lightness, so neighbours differ in two ways at once.
    // sliceHue is the single source of that hue: the legend tag derives its tint
    // from the same number, so a tag and its sector always read as the same colour.
    function sliceHue(i, n) {
      return Math.round(((i * 360) / Math.max(n, 1) + 200) % 360)
    }

    function sliceColor(i, n) {
      var light = i % 2 === 0 ? 62 : 51
      return 'hsl(' + sliceHue(i, n) + ', 46%, ' + light + '%)'
    }

    // Theme identity colour. This is a fixed table rather than something derived
    // per block: the same theme shows up in the lead block, the theme table and
    // the breakout list, and it has to look like the same theme in all three. The
    // partition pie below uses sliceHue instead — those hues rotate by position
    // and answer "how big is this slice", a different question from "which theme
    // is this".
    var THEME_COLORS = [
      ['ai', 'AI / 大模型', 198],
      ['game', '游戏', 270],
      ['tech', '科技数码', 162],
      ['knowledge', '知识科普', 54],
      ['life', '生活日常', 126],
      ['food', '美食', 18],
      ['animal', '动物萌宠', 90],
      ['fun', '搞笑整活', 342],
      ['screen', '影视动漫', 306],
      ['music', '音乐', 234],
    ]
    var THEME_HUE_BY_ID = {}
    var THEME_HUE_BY_NAME = {}
    THEME_COLORS.forEach(function (row) {
      THEME_HUE_BY_ID[row[0]] = row[2]
      THEME_HUE_BY_NAME[row[1]] = row[2]
    })

    // id first, then name, then a stable hash so an unknown theme still gets a
    // colour that does not change between renders or blocks.
    function themeHue(id, name) {
      if (typeof id === 'string' && THEME_HUE_BY_ID[id] !== undefined) return THEME_HUE_BY_ID[id]
      if (typeof name === 'string' && THEME_HUE_BY_NAME[name] !== undefined) return THEME_HUE_BY_NAME[name]
      var seed = (typeof id === 'string' && id) || (typeof name === 'string' && name) || ''
      var hash = 0
      for (var i = 0; i < seed.length; i++) hash = (hash * 131 + seed.charCodeAt(i)) % 360
      return hash
    }

    // One shared chip for every place a theme name is shown, so the three blocks
    // cannot drift apart in look or colour. The dot is an identity mark; it is
    // deliberately not a sector — a sector in the pie legend means "this share".
    function themeChip(hue, label, extraStyle) {
      return h(
        'span',
        {
          className: 'cocoon-chip',
          style: Object.assign(
            {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              padding: '1px 7px',
              borderRadius: '999px',
              fontSize: '11px',
              lineHeight: 1.5,
              maxWidth: '100%',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              background: 'hsla(' + hue + ', 48%, 52%, 0.20)',
              border: '1px solid hsla(' + hue + ', 48%, 60%, 0.42)',
              color: 'hsl(' + hue + ', 60%, 84%)',
            },
            extraStyle || {},
          ),
        },
        h(
          'svg',
          {
            width: 8,
            height: 8,
            viewBox: '0 0 8 8',
            'aria-hidden': 'true',
            style: { flex: 'none', display: 'block' },
          },
          h('circle', {
            className: 'cocoon-chip-dot',
            cx: 4,
            cy: 4,
            r: 3,
            fill: 'hsl(' + hue + ', 48%, 62%)',
          }),
        ),
        label,
      )
    }

    var LEGEND_COLLAPSED = 3

    // The home feed's partition mix as a donut. SVG rather than a conic-gradient
    // because each sector has to answer the pointer on its own: hovering a slice
    // dims the others and names it in the hole. A conic-gradient is one background
    // image — it cannot tell which sector the cursor is over.
    function CategoryBlock(props) {
      var hoverState = React.useState(null)
      var hovered = hoverState[0]
      var setHovered = hoverState[1]

      var openState = React.useState(false)
      var expanded = openState[0]
      var setExpanded = openState[1]

      var cats = props.cats
      if (!cats || typeof cats !== 'object') return null
      var items = Array.isArray(cats.items) ? cats.items : []
      if (!items.length) return null

      var slices = []
      items.forEach(function (it) {
        if (!it || typeof it !== 'object') return
        var share = num(it.share)
        if (share === null || share <= 0) return
        var name = typeof it.name === 'string' && it.name !== '' ? it.name : '未分类'
        slices.push({
          name: name,
          share: share,
          hue: sliceHue(slices.length, items.length),
          color: sliceColor(slices.length, items.length),
        })
      })
      if (!slices.length) return null

      var covered = num(cats.covered)
      var total = num(cats.total)
      var counter = covered !== null && total !== null ? covered + ' / ' + total + ' 个分区' : null
      var hot = hovered !== null && slices[hovered] ? slices[hovered] : null
      var cx = PIE_SIZE / 2
      var acc = 0
      var rows = expanded ? slices : slices.slice(0, LEGEND_COLLAPSED)
      var collapsed = slices.length > LEGEND_COLLAPSED

      return h(
        'div',
        { style: PIE_SECTION },
        h('div', { style: PIE_HEAD }, h('span', null, '分区构成'), h('span', null, counter)),
        h(
          'div',
          { style: PIE_BODY },
          h(
            'div',
            { style: { position: 'relative', width: PIE_SIZE + 'px', height: PIE_SIZE + 'px', flex: 'none' } },
            // Keyed on `expanded` so toggling the legend remounts the ring and the
            // sector entrance replays with it — the chart answers the click too.
            h(
              'svg',
              {
                key: expanded ? 'open' : 'closed',
                width: PIE_SIZE,
                height: PIE_SIZE,
                viewBox: '0 0 ' + PIE_SIZE + ' ' + PIE_SIZE,
                role: 'img',
                'aria-label': '分区构成饼图',
              },
              slices.map(function (s, i) {
                var a0 = acc * 360
                acc += s.share
                var a1 = acc * 360
                var isHot = hovered === i
                var dimmed = hovered !== null && !isHot
                return h('path', {
                  key: 's' + i,
                  d: arcPath(cx, cx, PIE_R, PIE_R_INNER, a0, a1),
                  fill: s.color,
                  className: 'cocoon-seg',
                  style: {
                    '--seg-delay': i * 38 + 'ms',
                    '--seg-center': cx + 'px',
                    opacity: dimmed ? 0.3 : 1,
                    stroke: isHot ? '#ffffff' : 'rgba(28, 30, 34, 0.55)',
                    strokeWidth: isHot ? 1.5 : 0.5,
                    transition: 'opacity 150ms ease, stroke 150ms ease',
                  },
                  onMouseEnter: function () {
                    setHovered(i)
                  },
                  onMouseLeave: function () {
                    setHovered(null)
                  },
                })
              }),
            ),
            h(
              'div',
              {
                style: {
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: PIE_SIZE + 'px',
                  height: PIE_SIZE + 'px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  pointerEvents: 'none',
                  textAlign: 'center',
                  lineHeight: 1.25,
                },
              },
              hot ? h('span', { style: { fontSize: '10px', opacity: 0.8 } }, hot.name) : null,
              hot ? h('span', { style: { fontSize: '13px', fontWeight: 600 } }, pct(hot.share)) : null,
            ),
          ),
          h(
            'div',
            // Keyed on `expanded` as well, so folding the legend out remounts the
            // tags and their stagger replays, the same way the ring replays its
            // sectors.
            { key: expanded ? 'open' : 'closed', style: PIE_LEGEND },
            h(
              'div',
              { style: TAG_FLOW },
              rows.map(function (s, i) {
                var isHot = hovered === i
                var dimmed = hovered !== null && !isHot
                var hue = s.hue
                return h(
                  'div',
                  {
                    key: 'p' + i,
                    className: isHot ? 'cocoon-tag is-hot' : 'cocoon-tag',
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                      flex: '0 0 auto',
                      maxWidth: '100%',
                      padding: '2px 7px 2px 3px',
                      borderRadius: '999px',
                      background: 'hsla(' + hue + ', 48%, 52%, ' + (isHot ? 0.36 : 0.2) + ')',
                      border: '1px solid hsla(' + hue + ', 48%, 60%, ' + (isHot ? 0.9 : 0.42) + ')',
                      '--tag-delay': 140 + i * 30 + 'ms',
                      opacity: dimmed ? 0.4 : 1,
                      transition: 'background 150ms ease, border-color 150ms ease, opacity 150ms ease',
                    },
                    onMouseEnter: function () {
                      setHovered(i)
                    },
                    onMouseLeave: function () {
                      setHovered(null)
                    },
                  },
                  // The 16px glyph is the same sector again, in the same fill
                  // string, so its colour can never drift from the ring.
                  h(
                    'svg',
                    {
                      width: 16,
                      height: 16,
                      viewBox: '0 0 16 16',
                      'aria-hidden': 'true',
                      style: { flex: 'none', display: 'block' },
                    },
                    h(
                      'g',
                      { className: 'cocoon-tag-glyph' },
                      h('path', { d: arcPath(8, 8, 6.6, 3.0, 0, s.share * 360), fill: s.color }),
                    ),
                  ),
                  h(
                    'span',
                    {
                      style: {
                        minWidth: 0,
                        fontSize: '11px',
                        color: 'hsl(' + hue + ', 60%, 84%)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      },
                    },
                    s.name,
                  ),
                  h(
                    'span',
                    {
                      style: {
                        flex: 'none',
                        color: 'hsl(' + hue + ', 45%, 90%)',
                        opacity: 0.75,
                        fontVariantNumeric: 'tabular-nums',
                      },
                    },
                    pct(s.share),
                  ),
                )
              }),
            ),
            collapsed
              ? h(
                  'div',
                  {
                    onClick: function () {
                      setExpanded(!expanded)
                    },
                    style: {
                      marginTop: '2px',
                      fontSize: '11px',
                      opacity: 0.55,
                      cursor: 'pointer',
                      textAlign: 'right',
                      userSelect: 'none',
                    },
                  },
                  expanded ? '收起' : '全部 ' + slices.length + ' 个 · 展开',
                )
              : null,
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
    var BREAKOUT_META = { display: 'flex', alignItems: 'center', gap: '3px', marginTop: '1px' }

    // One row: the title is the link, the line under it names the uploader and
    // shows the theme as the same fixed-colour chip used higher up. Anything
    // missing degrades to a phrase or disappears - never to the string
    // 'undefined' or to NaN.
    function breakoutItem(v, i) {
      var item = v && typeof v === 'object' ? v : {}
      var title = typeof item.title === 'string' && item.title !== '' ? item.title : '未知标题'
      var upName = typeof item.upName === 'string' && item.upName !== '' ? item.upName : '未知 UP'
      var themeName = typeof item.themeName === 'string' && item.themeName !== '' ? item.themeName : null
      var themeId = typeof item.theme === 'string' && item.theme !== '' ? item.theme : null

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
        // The plain-text reading order is still "UP主 · 主题名": the separator is
        // its own node and the chip's label follows it.
        h(
          'div',
          { style: BREAKOUT_META },
          h('span', { style: DIM }, upName),
          themeName === null ? null : h('span', { style: Object.assign({}, DIM, { flex: 'none' }) }, '·'),
          themeName === null ? null : themeChip(themeHue(themeId, themeName), themeName),
        ),
      )
    }

    // Nothing at all when the summary has no block, no items, or a malformed one:
    // an old host and an empty guest sample must both leave the panel as it was.
    function breakoutBlock(breakout) {
      if (!breakout || typeof breakout !== 'object') return null
      var items = Array.isArray(breakout.items) ? breakout.items : []
      if (!items.length) return null

      // One fixed label, no lead-in sentence and no item count: the list is
      // self-describing once the uploader and theme sit under each title.
      var head = '破茧推荐'

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
        h(CategoryBlock, { cats: data.categories }),
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
