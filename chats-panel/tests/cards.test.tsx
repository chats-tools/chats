import { expect, test } from 'claude-code/testing'

// Draws the pane with each card open. A drawn Svg sits on a layer above a card and shows through
// it. So while a card is open, no drawn dot is left, and a title gear is left out unless its
// card is the open one. Chat-line gears stay drawn: no card covers them. With no card open,
// the gears and dots stay drawn (the look does not change).
const PANE = {
  plugin: 'chats-panel',
  component: 'Pane',
  requestId: 'chat-list',
  props: { title: 'Chats', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

// Names and ids from demo/demo.json.
const chat = (id: string, title: string, isWorking = false) => ({
  id, link: `claude://claude.ai/cowork/${id}`, title, kind: 'cowork', project: '🌱 Garden Planner', lastActivityAt: 1, isWorking,
})

// [what is open, the card's name, the step inside the card]
const CARDS: [string, string, string][] = [
  ['', 'no card', ''],
  ['menu|list|demo-cowork-01', 'chat card', ''],
  ['menu|list|demo-cowork-02', 'chat card, are you sure', 'confirm|g-1'],
  ['mygroups|menu|all', 'Edit groups', ''],
  ['mygroups|menu|all', 'Edit groups, rename', 'rename|g-1'],
  ['mygroups|menu|all', 'Edit groups, are you sure', 'confirm|g-1'],
  ['projects|menu|all', 'Projects card', ''],
  ['gmenu|group|g-1', 'group card', ''],
  ['gmenu|group|g-1', 'group card, are you sure', 'confirm|g-1'],
]

const GEAR = 'Menu'
const DOTS = ['working', 'idle']

for (const [open, name, step] of CARDS)
  test(`nothing drawn shows through the card (${name})`, async ($, on) => {
    on('state.get', (_, e) => {
      const k = (e as { key?: string }).key
      if (k === 'moving') return { value: { value: open, version: 1 } }
      if (k === 'groups') return { value: { value: [{ id: 'g-1', name: 'This week', chats: ['demo-cowork-02'] }], version: 1 } }
      if (k === 'view')
        return {
          value: {
            value: { shape: 'view-4', value: { chats: [chat('demo-cowork-01', 'Plan the spring planting calendar', true), chat('demo-cowork-02', 'Order seeds before the sale ends'), chat('demo-cowork-03', 'Weekly meal plan')], bars: [{ label: 'Context', percent: 20, note: '1K / 1M', isActive: true, segments: [{ color: '#4a8fe7', percent: 10 }] }], projects: ['🌱 Garden Planner'], projectLinks: {}, usage: '', updatedAt: 1, cacheAt: 0 } },
            version: 1,
          },
        }
      const d: Record<string, unknown> = { marks: {}, hiddenProjects: null, isOpen: true, projectOrder: [], undoDelete: null, cardStep: step, tab: open.startsWith('gmenu') ? 'group:g-1' : 'Recent' }
      return { value: { value: k !== undefined && k in d ? d[k] : null, version: 1 } }
    })
    on('clock.now', () => ({ value: 1_000_000 }))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const alts = (await ui.findAll({ type: 'Svg' })).map(s => String((s.props as { alt?: unknown }).alt ?? ''))
    const gears = alts.filter(a => a === GEAR).length
    const dots = alts.filter(a => DOTS.includes(a)).length
    // Chat-line gears stay drawn (no card covers cells 0-1). Title gears: drawn with no card
    // open; while a card is open, only the open card's own title gear stays.
    const chatLines = open.startsWith('gmenu') ? 1 : 3 // chats in the list (the group has one)
    const titleGears = open.startsWith('gmenu') ? 3 : 2 // My groups, Cowork Projects (+ the group)
    const openIsTitle = open !== '' && !open.startsWith('menu|')
    if (open === '') {
      expect(gears).toBe(chatLines + titleGears)
      expect(dots).toBeGreaterThan(0)
    } else {
      expect(gears).toBe(chatLines + (openIsTitle ? 1 : 0))
      expect(dots).toBe(0)
    }
    await ui.unmount()
  })
