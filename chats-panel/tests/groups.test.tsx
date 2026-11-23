import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'chats-panel',
  component: 'Pane',
  requestId: 'chat-list',
  props: { title: 'Chats', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

// The test kit has no file access, so the plugin's demo/demo.json is served from this copy of its
// schema (same field names, a few of its chats).
const FIXTURE = {
  projects: [
    { id: 'demo-project-garden', name: '🌱 Garden Planner' },
    { id: 'demo-project-recipes', name: 'Recipe Book' },
    { id: 'demo-project-old', name: 'Old Experiments' },
  ],
  hiddenProjects: ['Old Experiments'],
  chats: [
    { id: 'demo-cowork-01', kind: 'cowork', title: 'Plan the spring planting calendar', project: '🌱 Garden Planner', minutesAgo: 0, isWorking: true },
    { id: 'demo-code-01', kind: 'code', title: 'Fix the login form tests', minutesAgo: 0, isWorking: true },
    { id: 'demo-cowork-02', kind: 'cowork', title: '!*** Order seeds before the sale ends', project: '🌱 Garden Planner', minutesAgo: 4 },
    { id: 'demo-cowork-03', kind: 'cowork', title: 'Weekly meal plan', project: 'Recipe Book', minutesAgo: 12 },
    { id: 'demo-cowork-10', kind: 'cowork', title: 'Try a new prompt style', project: 'Old Experiments', minutesAgo: 5000 },
  ],
  marks: { 'demo-cowork-03': { important: true } },
  groups: [{ id: 'g-demo-1', name: 'This week', chats: ['demo-cowork-02', 'demo-cowork-03'] }, { id: 'g-demo-2', name: 'Seeds', chats: [] }],
  usage: [{ label: '5-hour limit', percentUsed: 23, resetsInMinutes: 200 }],
  context: { tokens: 164500, window: 1000000, segments: [{ name: 'Messages', tokens: 120000 }] },
  savedCopyMinutesAgo: 2,
}

const HOME = '/home/demo'
const DATA = `${HOME}/Library/Application Support/ChatsBar`

// Demo mode on (CHATSBAR_DEMO=1): the panel is built from demo.json alone. Anything that would
// reach real Claude data, or open a chat, makes the hook below throw and the test fail.
test('a chat can be in two groups: add and remove', async ($, on) => {
  const files = new Map<string, string>()
  const touched: string[] = []
  const toasts: string[] = []
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.env(on, { HOME, CHATSBAR_DEMO: '1' })
  mock.store(on)
  on('fs.read', (_, e) => {
    touched.push(e.path)
    if (e.path.endsWith('/demo/demo.json')) return { value: JSON.stringify(FIXTURE) }
    const f = files.get(e.path)
    if (f === undefined) throw new Error(`no such file: ${e.path}`)
    return { value: f }
  })
  on('fs.exists', (_, e) => {
    touched.push(e.path)
    return { value: files.has(e.path) }
  })
  on('fs.write', (_, e) => {
    touched.push(e.path)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: (files.get(e.path) ?? '').length, mtimeMs: 1, isLink: false } }))
  on('fs.list', (_, e) => {
    throw new Error(`demo mode must not list ${e.path}`)
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', () => ({ value: { command: 'chats' } }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', () => {
    throw new Error('demo mode must open nothing')
  })
  on('mcp.call', () => {
    throw new Error('demo mode must not ask the app')
  })

  await $.command.run({ command: 'chats', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const groupsFile = () => (JSON.parse(files.get(`${DATA}/demo/groups.json`) ?? '{}') as { groups: { id: string; chats: string[] }[] }).groups
  const chatsOf = (gid: string) => groupsFile().find(g => g.id === gid)?.chats ?? []
  const card = 'list-demo-cowork-02'
  const ticks = async () =>
    (await ui.findAll({ type: 'Text', text: '\u2713' })).length

  // Open the card of "Order seeds" (in "This week" only): one tick, on "This week".
  await ui.press({ key: `more-${card}-btn` })
  expect(await ticks()).toBe(1)

  // Click "Seeds": the chat is now in both groups. The card closes; open again: two ticks.
  await ui.press({ key: `pm-g-${card}-g-demo-2-btn` })
  expect(chatsOf('g-demo-1')).toContain('demo-cowork-02')
  expect(chatsOf('g-demo-2')).toEqual(['demo-cowork-02'])
  expect(await ticks()).toBe(0)
  await ui.press({ key: `more-${card}-btn` })
  expect(await ticks()).toBe(2)
  expect(toasts).toContain('Put in "Seeds"')

  // The shape of groups.json stays the same.
  for (const g of groupsFile()) expect(Object.keys(g).sort()).toEqual(['chats', 'id', 'name'])

  // Click "This week": out of it, still in "Seeds".
  await ui.press({ key: `pm-g-${card}-g-demo-1-btn` })
  await ui.press({ key: `more-${card}-btn` })
  expect(chatsOf('g-demo-1')).not.toContain('demo-cowork-02')
  expect(chatsOf('g-demo-1')).toContain('demo-cowork-03')
  expect(chatsOf('g-demo-2')).toEqual(['demo-cowork-02'])
  expect(toasts).toContain('Taken out of "This week"')

  // In both again, then "No group": out of every group.
  await ui.press({ key: `pm-g-${card}-g-demo-1-btn` })
  expect(chatsOf('g-demo-1')).toContain('demo-cowork-02')
  await ui.press({ key: `more-${card}-btn` })
  await ui.press({ key: `pm-none-${card}-btn` })
  expect(chatsOf('g-demo-1')).toEqual(['demo-cowork-03'])
  expect(chatsOf('g-demo-2')).toEqual([])
  expect(toasts).toContain('Taken out of 2 groups')
  await ui.unmount()
})
