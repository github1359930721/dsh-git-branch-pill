/**
 * Git branch pill: the checked-out branch of the Session's working directory,
 * shown beside the other composer-dock pills.
 *
 * @module dsh-git-branch-pill/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-git-branch-pill',
  factory(require) {
    // `react` is a seed module of the page shell, so a hand-written factory can
    // require it directly; the @deepseek-ai/dsh-client-ui-primitives seed does
    // NOT re-export React (it only exports UI components).
    const React = require('react')
    if (typeof React?.createElement !== 'function') {
      throw new Error('git-branch-pill: the page shell did not seed the react module')
    }
    const h = React.createElement

    /** Host half route; keep in sync with index.js. */
    const ENDPOINT = '/api/dsh-git-branch'

    const CSS = `
.gbp-anchor{display:inline-flex;align-items:center;min-width:0;max-width:min(18rem,50vw)}
.gbp-pill{display:inline-flex;align-items:center;gap:.35rem;min-width:0;max-width:100%;padding:.1rem .45rem;border:1px solid var(--dsh-border-subtle,rgba(127,127,127,.28));border-radius:.6rem;background:transparent;color:var(--dsh-text-secondary,inherit);font:inherit;font-size:.75rem;line-height:1.35;cursor:pointer}
.gbp-pill:hover{background:var(--dsh-fill-subtle,rgba(127,127,127,.1))}
.gbp-pill:focus-visible{outline:2px solid var(--dsh-accent,#247bbf);outline-offset:1px}
.gbp-pill[data-state="error"]{color:var(--dsh-warning,#b8860b);border-color:var(--dsh-warning-border,rgba(184,134,11,.45));cursor:default}
.gbp-pill[data-state="error"]:hover{background:transparent}
.gbp-pill[data-state="copied"]{border-color:var(--dsh-accent,#247bbf);color:var(--dsh-accent,#247bbf)}
.gbp-icon{flex:none;display:block;opacity:.75}
.gbp-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.gbp-menu{position:fixed;z-index:2147483000;display:flex;flex-direction:column;gap:.35rem;width:min(20rem,calc(100vw - 2rem));max-height:min(24rem,60vh);padding:.5rem;border:1px solid var(--dsh-border-subtle,rgba(127,127,127,.3));border-radius:.6rem;background:var(--dsh-surface-raised,#fff);color:var(--dsh-text-primary,inherit);box-shadow:0 8px 28px rgba(0,0,0,.18);font:inherit;font-size:.8rem}
.gbp-menu-title{font-size:.75rem;font-weight:600;opacity:.7;padding:0 .25rem}
.gbp-menu-filter{width:100%;padding:.3rem .45rem;border:1px solid var(--dsh-border-subtle,rgba(127,127,127,.3));border-radius:.4rem;background:transparent;color:inherit;font:inherit;font-size:.8rem}
.gbp-menu-filter:focus-visible{outline:2px solid var(--dsh-accent,#247bbf);outline-offset:1px}
.gbp-menu-list{list-style:none;margin:0;padding:0;overflow-y:auto;display:flex;flex-direction:column;gap:.1rem}
.gbp-menu-item{display:flex;align-items:center;gap:.4rem;width:100%;padding:.32rem .45rem;border:0;border-radius:.35rem;background:transparent;color:inherit;font:inherit;font-size:.8rem;text-align:left;cursor:pointer}
.gbp-menu-item:hover:not(:disabled){background:var(--dsh-fill-subtle,rgba(127,127,127,.12))}
.gbp-menu-item[data-current="true"]{font-weight:600;cursor:default}
.gbp-menu-item:disabled{opacity:.75}
.gbp-menu-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gbp-menu-badge{flex:none;font-size:.7rem;opacity:.65}
.gbp-menu-empty,.gbp-menu-error{padding:.4rem .45rem;font-size:.75rem;opacity:.75}
.gbp-menu-error{color:var(--dsh-warning,#b8860b);opacity:1}
`

    /** Session-scoped answer cache: one Session asks for one directory. */
    const answers = new Map()
    const inFlight = new Map()

    /**
     * Poll interval. A `git checkout` is picked up within one tick; the Host
     * answers from a 2s cache, so a tick usually spawns no child process.
     */
    const POLL_MS = 3000

    /** A stuck Host must not pin the shared in-flight promise forever. */
    const FETCH_TIMEOUT_MS = 5000

    /** Once per distinct failure: a 3s poll would otherwise flood the console. */
    const reportedFailures = new Set()

    /** Record a failure once, so repeated polls stay quiet in the console. */
    function reportFailure(reason) {
      if (reportedFailures.has(reason)) return
      reportedFailures.add(reason)
      console.error(`[git-branch-pill] ${reason}`)
    }

    /**
     * Fetch one directory's branch, sharing an in-flight request per directory.
     *
     * Resolves `{repo:false}` for a confirmed non-repository and `undefined`
     * for an unknown outcome (network, auth, timeout, missing git). The two must
     * stay distinguishable: only the second is worth showing as an error.
     */
    async function readBranch(directory, fresh = false) {
      if (typeof directory !== 'string' || directory === '') return undefined
      const key = `${fresh ? 'fresh:' : ''}${directory}`
      if (!fresh) {
        const hit = answers.get(directory)
        if (hit !== undefined) return hit
      }
      const running = inFlight.get(key)
      if (running !== undefined) return running
      const query = `cwd=${encodeURIComponent(directory)}${fresh ? '&fresh=1' : ''}`
      const request = fetch(`${ENDPOINT}?${query}`, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        // Without this a stalled Host pins the shared promise and every later
        // tick reuses it, so the pill would go permanently silent.
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return await response.json()
        })
        .then((payload) => {
          const answer = {
            repo: payload?.repo === true,
            branch: typeof payload?.branch === 'string' && payload.branch !== '' ? payload.branch : null,
            detached: payload?.detached === true,
            reason: typeof payload?.reason === 'string' ? payload.reason : null,
            gitMissing: payload?.gitMissing === true,
          }
          // Always overwrite: a poll is how a branch switch becomes visible.
          answers.set(directory, answer)
          if (answer.repo) reportedFailures.delete('lookup')
          return answer
        })
        .catch((error) => {
          reportFailure(`branch lookup failed (${error?.name ?? 'Error'}: ${error?.message ?? error})`)
          return undefined
        })
        .finally(() => inFlight.delete(key))
      inFlight.set(key, request)
      return request
    }

    /** Small monochrome branch glyph drawn inline so no icon package is needed. */
    function BranchIcon() {
      return h(
        'svg',
        {
          className: 'gbp-icon',
          viewBox: '0 0 16 16',
          width: 12,
          height: 12,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          'aria-hidden': true,
        },
        h('circle', { cx: 4.5, cy: 3.5, r: 1.6 }),
        h('circle', { cx: 4.5, cy: 12.5, r: 1.6 }),
        h('circle', { cx: 11.5, cy: 5.5, r: 1.6 }),
        h('path', { d: 'M4.5 5.1v5.8' }),
        h('path', { d: 'M11.5 7.1c0 2.2-1.6 3.1-3.4 3.5' }),
      )
    }

    /**
     * The dock entry itself. Session props give the directory.
     *
     * Three outcomes stay distinguishable, because "nothing shown" is useless
     * for diagnosis: a confirmed non-repository renders nothing, a confirmed
     * repository renders the branch, and an unknown outcome (network, auth,
     * timeout, git not installed) renders a muted warning that says why.
     *
     * A `git checkout` changes no Session state, so the directory alone cannot
     * drive this: the entry polls while the page is visible and stops while it
     * is hidden, so one open Session costs one request per tick, not one per
     * hidden tab.
     */
    function GitBranchPill({ useSessions, sessionId, t }) {
      const directory = useSessions((snapshot) => (sessionId === undefined ? undefined : snapshot.byId[sessionId]?.cwd))
      const [answer, setAnswer] = React.useState(() => (typeof directory === 'string' ? answers.get(directory) : undefined))
      const [copied, setCopied] = React.useState(false)
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [anchor, setAnchor] = React.useState(null)
      const [canSwitch, setCanSwitch] = React.useState(false)
      const buttonRef = React.useRef(null)
      // Passed down from `apply` so the component stays testable on its own.
      const translate = t ?? fallbackTranslate

      // Probe the git-graph bridge once per directory: it decides whether a
      // click opens the picker or merely copies the branch name.
      React.useEffect(() => {
        if (typeof directory !== 'string' || directory === '') return undefined
        let live = true
        bridgeAvailable().then((ok) => {
          if (live) setCanSwitch(ok)
        })
        return () => {
          live = false
        }
      }, [directory])

      React.useEffect(() => {
        if (typeof directory !== 'string' || directory === '') {
          setAnswer(undefined)
          return undefined
        }
        let live = true
        let timer
        // Show the cached value immediately, then keep asking. The first tick is
        // forced past the Host cache so a branch switched while this Session was
        // not on screen resolves at once; later ticks ride the cache.
        setAnswer(answers.get(directory))
        let first = true
        const tick = () => {
          const fresh = first
          first = false
          readBranch(directory, fresh).then((value) => {
            // `undefined` means "unknown now"; keep the last good answer rather
            // than blanking a pill that was correct a second ago.
            if (live && value !== undefined) setAnswer(value)
          })
        }
        const start = () => {
          if (timer !== undefined) return
          tick()
          timer = setInterval(tick, POLL_MS)
        }
        const stop = () => {
          if (timer === undefined) return
          clearInterval(timer)
          timer = undefined
        }
        const onVisibility = () => {
          if (typeof document !== 'undefined' && document.hidden) stop()
          else start()
        }
        if (typeof document === 'undefined' || !document.hidden) start()
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
        return () => {
          live = false
          stop()
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [directory])

      // The "copied" border fades on its own; no timer outlives the component.
      React.useEffect(() => {
        if (!copied) return undefined
        const timer = setTimeout(() => setCopied(false), 1200)
        return () => clearTimeout(timer)
      }, [copied])

      if (typeof directory !== 'string' || directory === '') return null

      if (answer === undefined) {
        return h(
          PillShell,
          {
            state: 'error',
            title: `${directory}\n${translate('pill.unknown')}`,
            label: translate('pill.unknownShort'),
            sessionId,
          },
          h(WarningIcon),
        )
      }
      if (!answer.repo) {
        // A confirmed non-repository is not an error: say nothing rather than
        // clutter every plain folder Session. A missing git and a vanished
        // directory are actionable, so they get the warning pill.
        if (answer.reason === 'missing-directory') {
          return h(
            PillShell,
            {
              state: 'error',
              title: `${directory}\n${translate('pill.missingDirectory')}`,
              label: translate('pill.unknownShort'),
              sessionId,
            },
            h(WarningIcon),
          )
        }
        if (answer.gitMissing === true) {
          return h(
            PillShell,
            {
              state: 'error',
              title: `${directory}\n${translate('pill.gitMissing')}`,
              label: translate('pill.unknownShort'),
              sessionId,
            },
            h(WarningIcon),
          )
        }
        return null
      }
      if (answer.branch === null) return null

      const label = answer.branch
      const text = translate(answer.detached ? 'pill.detached' : 'pill.branch', { branch: label })
      const copy = () => {
        if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return
        navigator.clipboard.writeText(label).then(
          () => setCopied(true),
          () => undefined,
        )
      }
      const openMenu = () => {
        const rect = buttonRef.current?.getBoundingClientRect?.()
        setAnchor(rect === undefined ? null : { left: rect.left, top: rect.top })
        setMenuOpen(true)
      }
      const onClick = (event) => {
        // A1: plain click switches, Ctrl/Cmd+click copies. Without the bridge
        // there is nothing to switch with, so the click copies instead.
        if (event.ctrlKey || event.metaKey || !canSwitch) {
          copy()
          return
        }
        openMenu()
      }
      const hint = (canSwitch ? translate('pill.copyHint') : translate('pill.copyHintPlain')).split('Ctrl+click').join(
        typeof navigator !== 'undefined' && /mac/i.test(navigator.platform ?? '') ? 'Cmd+click' : 'Ctrl+click',
      )

      return h(
        'span',
        { className: 'gbp-anchor', 'data-composer-stat': 'git-branch' },
        h(
          'button',
          {
            ref: buttonRef,
            type: 'button',
            className: 'gbp-pill',
            'data-state': copied ? 'copied' : 'ready',
            'data-git-branch': label,
            'data-switchable': canSwitch ? 'true' : 'false',
            title: `${directory}\n${text}\n${hint}`,
            'aria-label': `${text} — ${hint}`,
            'aria-haspopup': canSwitch ? 'dialog' : undefined,
            'aria-expanded': canSwitch ? (menuOpen ? 'true' : 'false') : undefined,
            onClick,
          },
          // createElement does not flatten an array passed as the third
          // argument into children, so the icon and label go as siblings.
          h(BranchIcon),
          h('span', { className: 'gbp-label', children: copied ? translate('pill.copied') : text }),
          canSwitch ? h(ChevronIcon) : null,
        ),
        menuOpen && canSwitch
          ? h(BranchMenu, {
              directory,
              current: answer.detached ? '' : label,
              anchor,
              translate,
              onClose: () => setMenuOpen(false),
              onPicked: (name) => {
                setMenuOpen(false)
                // The poll would catch this within 3s; seed it so the pill
                // changes as soon as the Host confirms the switch.
                answers.set(directory, { ...answer, branch: name, detached: false })
                setAnswer({ ...answer, branch: name, detached: false })
              },
            })
          : null,
      )
    }

    /** Small down chevron shown only when the picker is available. */
    function ChevronIcon() {
      return h(
        'svg',
        {
          className: 'gbp-icon',
          viewBox: '0 0 16 16',
          width: 10,
          height: 10,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M4 6.5 8 10.5 12 6.5' }),
      )
    }

    /** Deliberately dumb shell for the non-ready states. */
    function PillShell({ state, title, label, sessionId, children }) {
      return h(
        'span',
        { className: 'gbp-anchor', 'data-composer-stat': 'git-branch', 'data-session': sessionId },
        h(
          'span',
          { className: 'gbp-pill', 'data-state': state, title },
          children,
          h('span', { className: 'gbp-label', children: label }),
        ),
      )
    }

    /** Small triangle-with-bang glyph for an unknown outcome. */
    function WarningIcon() {
      return h(
        'svg',
        {
          className: 'gbp-icon',
          viewBox: '0 0 16 16',
          width: 12,
          height: 12,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M8 2.2 14.4 13.2H1.6Z' }),
        h('path', { d: 'M8 6.2v3.1' }),
        h('path', { d: 'M8 11.4v.1' }),
      )
    }

    /** Copy for the pill; the `{branch}` placeholder carries the branch name. */
    const DICTIONARY = {
      zh: {
        'pill.branch': '{branch}',
        'pill.detached': '分离 HEAD · {branch}',
        'pill.unknownShort': '分支未知',
        'pill.unknown': '查询分支失败：网络、登录态或 Host 超时，稍后会自动重试',
        'pill.missingDirectory': '会话工作目录已不存在',
        'pill.gitMissing': '找不到 git 可执行文件：请确认已安装 git 并加入 DSH 进程的 PATH',
        'pill.copyHint': '点击切换分支，Ctrl+点击复制分支名',
        'pill.copyHintPlain': '点击复制分支名',
        'pill.copied': '已复制',
        'menu.title': '切换分支',
        'menu.loading': '正在读取分支…',
        'menu.empty': '没有本地分支',
        'menu.filter': '筛选分支',
        'menu.current': '当前分支',
        'menu.switching': '正在切换到 {branch}…',
        'menu.switched': '已切换到 {branch}',
        'menu.failed': '切换失败：{message}',
        'menu.unavailable': '需要安装 @linxin666/dsh-client-ui-git-graph 才能切换分支',
        'menu.detached': '当前为分离 HEAD，选择分支可切回',
      },
      en: {
        'pill.branch': '{branch}',
        'pill.detached': 'detached · {branch}',
        'pill.unknownShort': 'branch unknown',
        'pill.unknown': 'Branch lookup failed: network, auth or Host timeout. It retries automatically.',
        'pill.missingDirectory': 'This Session working directory no longer exists',
        'pill.gitMissing': 'No git executable found: install git and put it on the DSH process PATH',
        'pill.copyHint': 'Click to switch branch, Ctrl+click to copy the name',
        'pill.copyHintPlain': 'Click to copy the branch name',
        'pill.copied': 'copied',
        'menu.title': 'Switch branch',
        'menu.loading': 'Reading branches…',
        'menu.empty': 'No local branches',
        'menu.filter': 'Filter branches',
        'menu.current': 'current',
        'menu.switching': 'Switching to {branch}…',
        'menu.switched': 'Switched to {branch}',
        'menu.failed': 'Switch failed: {message}',
        'menu.unavailable': 'Install @linxin666/dsh-client-ui-git-graph to switch branches here',
        'menu.detached': 'Detached HEAD — pick a branch to return',
      },
    }

    /** Used only when a slot does not pass `t` (unit tests, older shells). */
    function fallbackTranslate(key, vars) {
      const template = DICTIONARY.en[key] ?? key
      if (vars === undefined) return template
      return Object.entries(vars).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), template)
    }

    //#region git-graph bridge
    /**
     * Optional bridge to `@linxin666/dsh-client-ui-git-graph`.
     *
     * That plugin already owns real `git switch` on the Host half behind a POST
     * JSON protocol, but its selector only mounts in the blank hero state. When
     * it is installed we borrow its routes so the pill can switch branches in an
     * active Session; when it is absent every call here fails closed and the pill
     * falls back to copy-only. Nothing is imported from the other package, so
     * upgrading or removing it never breaks rendering.
     */
    const GIT_GRAPH = {
      probe: '/git/config',
      branches: '/git/branches',
      status: '/git/status',
      switch: '/git/switch',
    }

    /** Cache the availability probe so a poll does not ask every tick. */
    let bridgeProbe

    /** POST JSON the way the git-graph Host half expects it. */
    async function postGit(path, payload) {
      const response = await fetch(path, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      if (body?.ok !== true) throw new Error(body?.error?.message ?? body?.error?.code ?? 'git-graph refused')
      return body.value
    }

    /**
     * Whether the git-graph bridge answers at all.
     * @returns {Promise<boolean>} true when its routes are mounted and reachable.
     */
    async function bridgeAvailable() {
      bridgeProbe ??= postGit(GIT_GRAPH.probe, {})
        .then(() => true)
        .catch(() => false)
      return await bridgeProbe
    }

    /** Drop a cached probe so a later render re-checks (after installing git-graph). */
    function resetBridgeProbe() {
      bridgeProbe = undefined
    }

    /**
     * List local branches for one directory.
     * @param {string} directory - Session working directory.
     * @returns {Promise<{ root: string, branch: string, branches: {name: string, current: boolean}[] } | null>}
     */
    async function listBranches(directory) {
      try {
        return await postGit(GIT_GRAPH.branches, { path: directory })
      } catch (error) {
        reportFailure(`git-graph branches failed (${error?.message ?? error})`)
        return null
      }
    }

    /**
     * Ask git-graph to switch this directory to `branch`.
     * @param {string} directory - Session working directory.
     * @param {string} branch - target local branch.
     * @returns {Promise<{ ok: boolean, branch?: string, message?: string }>}
     */
    async function switchBranch(directory, branch) {
      try {
        const value = await postGit(GIT_GRAPH.switch, { path: directory, branch })
        return { ok: true, branch: typeof value?.branch === 'string' ? value.branch : branch }
      } catch (error) {
        return { ok: false, message: error?.message ?? String(error) }
      }
    }
    //#endregion

    /**
     * Branch picker. Rendered into a fixed-position layer so the composer's
     * own stacking context cannot clip it; closes on Escape or an outside click.
     */
    function BranchMenu({ directory, current, anchor, onPicked, onClose, translate }) {
      const [state, setState] = React.useState({ phase: 'loading', branches: [], error: null })
      const [filter, setFilter] = React.useState('')
      const [busy, setBusy] = React.useState(null)
      const rootRef = React.useRef(null)
      const inputRef = React.useRef(null)

      React.useEffect(() => {
        let live = true
        listBranches(directory).then((view) => {
          if (!live) return
          if (view === null) {
            setState({ phase: 'error', branches: [], error: translate('menu.unavailable') })
            return
          }
          setState({ phase: 'ready', branches: view.branches ?? [], error: null })
        })
        return () => {
          live = false
        }
      }, [directory])

      React.useEffect(() => {
        inputRef.current?.focus()
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
          }
        }
        const onPointer = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) onClose()
        }
        document.addEventListener('keydown', onKey, true)
        document.addEventListener('pointerdown', onPointer, true)
        return () => {
          document.removeEventListener('keydown', onKey, true)
          document.removeEventListener('pointerdown', onPointer, true)
        }
      }, [onClose])

      const pick = async (name) => {
        if (busy !== null) return
        setBusy(name)
        const result = await switchBranch(directory, name)
        setBusy(null)
        if (result.ok) {
          onPicked(result.branch ?? name)
          return
        }
        setState((previous) => ({ ...previous, error: translate('menu.failed', { message: result.message }) }))
      }

      const items = state.branches.filter((row) => filter === '' || row.name.toLowerCase().includes(filter.trim().toLowerCase()))
      const style = anchor === null ? { position: 'fixed', left: 24, bottom: 120 } : {
        position: 'fixed',
        left: Math.max(8, Math.min(anchor.left, (typeof window === 'undefined' ? anchor.left : window.innerWidth) - 320)),
        bottom: Math.max(8, (typeof window === 'undefined' ? 800 : window.innerHeight) - anchor.top + 8),
      }

      return h(
        'div',
        {
          ref: rootRef,
          className: 'gbp-menu',
          style,
          role: 'dialog',
          'aria-label': translate('menu.title'),
          'data-git-branch-menu': 'true',
        },
        h('div', { className: 'gbp-menu-title', children: translate('menu.title') }),
        h('input', {
          ref: inputRef,
          className: 'gbp-menu-filter',
          type: 'search',
          value: filter,
          placeholder: translate('menu.filter'),
          onChange: (event) => setFilter(event.target.value),
        }),
        state.error !== null ? h('div', { className: 'gbp-menu-error', children: state.error }) : null,
        state.phase === 'loading'
          ? h('div', { className: 'gbp-menu-empty', children: translate('menu.loading') })
          : items.length === 0
            ? h('div', { className: 'gbp-menu-empty', children: translate('menu.empty') })
            : h(
                'ul',
                { className: 'gbp-menu-list' },
                items.map((row) =>
                  h(
                    'li',
                    { key: row.name },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'gbp-menu-item',
                        'data-current': row.name === current ? 'true' : 'false',
                        disabled: busy !== null || row.name === current,
                        onClick: () => pick(row.name),
                      },
                      h('span', { className: 'gbp-menu-name', children: row.name }),
                      row.name === current ? h('span', { className: 'gbp-menu-badge', children: translate('menu.current') }) : null,
                      busy === row.name ? h('span', { className: 'gbp-menu-badge', children: '…' }) : null,
                    ),
                  ),
                ),
              ),
      )
    }

    // Test seam only: the module keeps its answer cache private, so a headless
    // render check needs a way to seed it. Harmless in the page (nothing reads it).
    globalThis.__seedAnswers = (directory, answer) => {
      answers.set(directory, answer)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // `locale` arrives through inject, so `ctx.get` is always populated here.
        const locale = ctx.get('locale')
        if (locale !== undefined) ctx.effect(() => locale.register('gitBranchPill', DICTIONARY), 'git-branch-pill: copy')

        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.dshGitBranchPill = 'true'
          style.textContent = CSS
          document.head.append(style)
          return () => style.remove()
        }, 'git-branch-pill: styles')

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'git-branch',
              order: -10,
              ...(locale === undefined ? {} : { locale: 'gitBranchPill' }),
            },
            GitBranchPill,
          ),
        )
      },
    }
  },
})
