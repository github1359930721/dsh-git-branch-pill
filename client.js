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
      // Passed down from `apply` so the component stays testable on its own.
      const translate = t ?? fallbackTranslate

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

      return h(
        'span',
        { className: 'gbp-anchor', 'data-composer-stat': 'git-branch' },
        h(
          'button',
          {
            type: 'button',
            className: 'gbp-pill',
            'data-state': copied ? 'copied' : 'ready',
            'data-git-branch': label,
            title: `${directory}\n${text}\n${translate('pill.copyHint')}`,
            'aria-label': `${text} — ${translate('pill.copyHint')}`,
            onClick: copy,
          },
          // createElement does not flatten an array passed as the third
          // argument into children, so the icon and label go as siblings.
          h(BranchIcon),
          h('span', { className: 'gbp-label', children: copied ? translate('pill.copied') : text }),
        ),
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
        'pill.copyHint': '点击复制分支名',
        'pill.copied': '已复制',
      },
      en: {
        'pill.branch': '{branch}',
        'pill.detached': 'detached · {branch}',
        'pill.unknownShort': 'branch unknown',
        'pill.unknown': 'Branch lookup failed: network, auth or Host timeout. It retries automatically.',
        'pill.missingDirectory': 'This Session working directory no longer exists',
        'pill.gitMissing': 'No git executable found: install git and put it on the DSH process PATH',
        'pill.copyHint': 'Click to copy the branch name',
        'pill.copied': 'copied',
      },
    }

    /** Used only when a slot does not pass `t` (unit tests, older shells). */
    function fallbackTranslate(key, vars) {
      const template = DICTIONARY.en[key] ?? key
      if (vars === undefined) return template
      return Object.entries(vars).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), template)
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
