import { expect, test } from 'claude-code/testing'

// Draws the /chats pane on the desktop with a few groups and chats, and with a card open, so a
// tree the desktop refuses shows up here (the app hides the reason). Run: claude plugin test <mod>
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

const CASES: [string, string, boolean][] = [
  ['', '', false],
  ['mygroups|menu|all', '', false],
  ['mygroups|menu|all', 'rename|g-1', false],
  ['mygroups|menu|all', 'confirm|g-1', false],
  ['projects|menu|all', '', false],
  ['menu|list|demo-cowork-01', '', false],
  ['menu|list|demo-cowork-02', 'confirm|g-1', false],
  ['gmenu|group|g-1', 'confirm|g-1', false],
  ['', '', true],
]
for (const [open, step, hasUndo] of CASES)
  test(`the pane draws on the desktop (open "${open}", step "${step}", undo ${hasUndo})`, async ($, on) => {
    on('state.get', (_, e) => {
      const k = (e as { key?: string }).key
      if (k === 'moving') return { value: { value: open, version: 1 } }
      if (k === 'groups') return { value: { value: [{ id: 'g-1', name: 'This week', chats: ['demo-cowork-02'] }], version: 1 } }
      if (k === 'view')
        return {
          value: {
            value: { shape: 'view-4', value: { chats: [chat('demo-cowork-01', 'Plan the spring planting calendar', true), chat('demo-cowork-02', 'Order seeds before the sale ends')], bars: [{ label: 'Context', percent: 20, note: '1K / 1M', isActive: true, segments: [{ color: '#4a8fe7', percent: 10 }, { color: '#e8743b', percent: 2 }] }], projects: ['🌱 Garden Planner'], projectLinks: {}, usage: '', updatedAt: 1, cacheAt: 0 } },
            version: 1,
          },
        }
      const d: Record<string, unknown> = { marks: {}, hiddenProjects: null, isOpen: true, projectOrder: [], undoDelete: hasUndo ? { group: { id: 'g-9', name: 'Big ideas', chats: [] }, index: 0, at: 1 } : null, cardStep: step, tab: open.startsWith('gmenu') ? 'group:g-1' : 'Recent' }
      return { value: { value: k !== undefined && k in d ? d[k] : null, version: 1 } }
    })
    on('clock.now', () => ({ value: 1_000_000 }))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const t = await ui.find({ type: 'Text', text: /Working now/ })
    expect(t?.text).toBe('Working now (1)')
    if (step.startsWith('confirm')) expect((await ui.find({ type: 'Text', text: /Delete group "This week"\?/ }))?.text).toBe('Delete group "This week"?')
    if (hasUndo) expect((await ui.find({ type: 'Text', text: /deleted/ }))?.text).toBe('"Big ideas" deleted')
    if (open === 'mygroups|menu|all' && step === '') expect((await ui.find({ type: 'Text', text: /Edit groups/ }))?.text).toBe('Edit groups')
    await ui.unmount()
  })

// The last line shows the version of the code that draws the panel, read from plugin.json.
test('the panel shows its version', async ($, on) => {
  on('state.get', (_, e) => {
    const k = (e as { key?: string }).key
    if (k === 'view')
      return { value: { value: { shape: 'view-4', value: { chats: [chat('demo-cowork-01', 'Plan the spring planting calendar')], bars: [], projects: [], projectLinks: {}, usage: '', updatedAt: 1, cacheAt: 0 } }, version: 1 } }
    const d: Record<string, unknown> = { marks: {}, groups: [], hiddenProjects: null, isOpen: true, projectOrder: [], moving: '', cardStep: '', undoDelete: null, tab: 'Recent' }
    return { value: { value: k !== undefined && k in d ? d[k] : null, version: 1 } }
  })
  on('clock.now', () => ({ value: 1_000_000 }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: JSON.stringify({ name: 'chats-panel', version: '9.8.7' }) }
    throw new Error(`no such file: ${e.path}`)
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /v9\.8\.7/ }))?.text).toBe('/chats v9.8.7')
  await ui.unmount()
})
