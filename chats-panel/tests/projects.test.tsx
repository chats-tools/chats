import { expect, test } from 'claude-code/testing'

import { buildDemoView, parseDemo } from '../hooks/demo'

// The project order and hidden rule, and the pure demo view. Project names are from demo/demo.json.
const PANE = {
  plugin: 'chats-panel',
  component: 'Pane',
  requestId: 'chat-list',
  props: { title: 'Chats', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const FOUND = ['🌱 Garden Planner', 'Recipe Book', 'Home Office', 'Travel 2027', 'Old Experiments']

// [name, projectOrder, hiddenProjects, the project buttons expected, in order]
const CASES: [string, string[], string[] | null, string[]][] = [
  ['no settings: nothing hidden, the app\'s order', [], null, FOUND],
  ['order: listed names first, the rest after in the app\'s order', ['Home Office', 'Recipe Book'], null, ['Home Office', 'Recipe Book', '🌱 Garden Planner', 'Travel 2027', 'Old Experiments']],
  ['hidden: exact names only', [], ['Old Experiments', 'Recipe'], ['🌱 Garden Planner', 'Recipe Book', 'Home Office', 'Travel 2027']],
  ['an empty hidden list hides nothing', [], [], FOUND],
]
for (const [name, order, hidden, expected] of CASES)
  test(`projects: ${name}`, async ($, on) => {
    on('state.get', (_, e) => {
      const k = (e as { key?: string }).key
      if (k === 'view')
        return {
          value: { value: { shape: 'view-4', value: { chats: [], bars: [], projects: FOUND, projectLinks: {}, usage: '', updatedAt: 1, cacheAt: 0 } }, version: 1 },
        }
      const d: Record<string, unknown> = { marks: {}, groups: [], hiddenProjects: hidden, projectOrder: order, moving: '', cardStep: '', undoDelete: null, tab: 'Recent', isOpen: true }
      return { value: { value: k !== undefined && k in d ? d[k] : null, version: 1 } }
    })
    on('clock.now', () => ({ value: 1_000_000 }))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const labels = (await ui.findAll({ type: 'Button' })).map(b => b.text)
    expect(labels.filter(l => FOUND.includes(l))).toEqual(expected)
    await ui.unmount()
  })

test('the demo view is built from demo.json fields', () => {
  const demo = parseDemo({
    projects: [{ id: 'demo-project-garden', name: '🌱 Garden Planner' }],
    chats: [
      { id: 'demo-cowork-01', kind: 'cowork', title: 'Plan the spring planting calendar', project: '🌱 Garden Planner', minutesAgo: 0, isWorking: true },
      { id: 'demo-code-02', kind: 'code', title: 'Add dark mode to the settings page', minutesAgo: 25 },
      { id: 'demo-chat-01', kind: 'chat', title: 'Explain compound interest', minutesAgo: 110 },
      { id: 'demo-cowork-04', kind: 'cowork', title: 'Morning news digest', minutesAgo: 40, isScheduled: true },
      { id: '', kind: 'cowork', title: 'no id: left out', minutesAgo: 1 },
    ],
    usage: [{ label: '5-hour limit', percentUsed: 23, resetsInMinutes: 200 }],
    context: { tokens: 164500, window: 1000000, segments: [{ name: 'Messages', tokens: 120000 }] },
    savedCopyMinutesAgo: 2,
  })
  expect(demo).toBeDefined()
  if (demo === undefined) return
  const now = 1_700_000_000_000
  const v = buildDemoView(demo, now)
  expect(v.cache.chats.map(c => [c.id, c.link])).toEqual([
    ['demo-cowork-01', 'claude://claude.ai/cowork/demo-cowork-01'],
    ['demo-code-02', 'claude://claude.ai/epitaxy/demo-code-02'],
    ['demo-cowork-04', 'claude://claude.ai/cowork/demo-cowork-04'],
    ['demo-chat-01', 'claude://claude.ai/chat/demo-chat-01'],
  ])
  expect(v.cache.chats[0]?.isWorking).toBe(true)
  expect(v.cache.chats[0]?.lastActivityAt).toBe(now)
  expect(v.cache.chats[1]?.lastActivityAt).toBe(now - 25 * 60_000)
  expect(v.cache.chats.find(c => c.id === 'demo-cowork-04')?.isScheduled).toBe(true)
  expect(v.cache.projects).toEqual(['🌱 Garden Planner'])
  expect(v.cache.projectLinks).toEqual({ '🌱 Garden Planner': 'claude://claude.ai/project/demo-project-garden' })
  expect(v.cache.savedAt).toBe(now - 2 * 60_000)
  expect(v.windows).toEqual([{ label: '5-hour limit', percentUsed: 23, resetsAt: new Date(now + 200 * 60_000).toISOString() }])
  expect(v.context).toEqual({ tokens: 164500, window: 1000000, parts: [{ name: 'Messages', tokens: 120000 }] })
})
