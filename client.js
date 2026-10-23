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
.gbp-pill{display:inline-flex;align-items:center;gap:.35rem;min-width:0;max-width:100%;padding:.1rem .45rem;border:1px solid var(--dsh-border-subtle,rgba(127,127,127,.28));border-radius:.6rem;background:transparent;color:var(--dsh-text-secondary,inherit);font:inherit;font-size:.75rem;line-height:1.35;cursor:default}
.gbp-pill[data-clickable="true"]{cursor:pointer}
.gbp-pill[data-clickable="true"]:hover{background:var(--dsh-fill-subtle,rgba(127,127,127,.1))}
.gbp-pill:focus-visible{outline:2px solid var(--dsh-accent,#247bbf);outline-offset:1px}
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

    /** Fetch one directory's branch, sharing an in-flight request per directory. */
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
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`git branch endpoint ${response.status}`)
          return await response.json()
        })
        .then((payload) => {
          const answer = {
            repo: payload?.repo === true,
            branch: typeof payload?.branch === 'string' && payload.branch !== '' ? payload.branch : null,
            detached: payload?.detached === true,
          }
          // Always overwrite: a poll is how a branch switch becomes visible.
          answers.set(directory, answer)
          return answer
        })
        .catch((error) => {
          console.error('[git-branch-pill] branch lookup failed', error)
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
     * The dock entry itself. Session props give the directory; the pill hides
     * while the answer is unknown so a non-repository never flashes a label.
     *
     * A `git checkout` changes no Session state, so the directory alone cannot
     * drive this: the entry polls while the page is visible and stops while it
     * is hidden, so one open Session costs one request per tick, not one per
     * hidden tab.
     */
    function GitBranchPill({ useSessions, sessionId, t }) {
      const directory = useSessions((snapshot) => (sessionId === undefined ? undefined : snapshot.byId[sessionId]?.cwd))
      const [answer, setAnswer] = React.useState(() => (typeof directory === 'string' ? answers.get(directory) : undefined))

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

      if (answer === undefined || !answer.repo) return null
      const label = answer.branch
      if (label === null) return null
      const text = t === undefined ? label : t(answer.detached ? 'pill.detached' : 'pill.branch', { branch: label })

      return h(
        'span',
        { className: 'gbp-anchor', 'data-composer-stat': 'git-branch' },
        h(
          'span',
          {
            className: 'gbp-pill',
            title: `${directory}\n${text}`,
            'data-git-branch': label,
            'aria-label': text,
          },
          // createElement does not flatten an array passed as the third
          // argument into children, so the icon and label go as siblings.
          h(BranchIcon),
          h('span', { className: 'gbp-label', children: text }),
        ),
      )
    }

    /** Copy for the pill; the `{branch}` placeholder carries the branch name. */
    const DICTIONARY = {
      zh: { 'pill.branch': '{branch}', 'pill.detached': '分离 HEAD · {branch}' },
      en: { 'pill.branch': '{branch}', 'pill.detached': 'detached · {branch}' },
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
