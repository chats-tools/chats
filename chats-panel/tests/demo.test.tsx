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
  groups: [{ id: 'g-demo-1', name: 'This week', chats: ['demo-cowork-02', 'demo-cowork-03'] }],
  usage: [{ label: '5-hour limit', percentUsed: 23, resetsInMinutes: 200 }],
  context: { tokens: 164500, window: 1000000, segments: [{ name: 'Messages', tokens: 120000 }] },
  savedCopyMinutesAgo: 2,
}

const HOME = '/home/demo'
const DATA = `${HOME}/Library/Application Support/ChatsBar`

// Demo mode on (CHATSBAR_DEMO=1): the panel is built from demo.json alone. Anything that would
// reach real Claude data, or open a chat, makes the hook below throw and the test fail.
test('demo mode end to end', async ($, on) => {
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

  // The two working chats of demo.json, a shown project, and a group; the hidden project is not a button.
  expect((await ui.find({ type: 'Text', text: /Working now/ }))?.text).toBe('Working now (2)')
  expect(await ui.find({ type: 'Button', text: '🌱 Garden Planner' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'Recipe Book' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'Old Experiments' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: 'This week (2)' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /saved copy/ }))?.text).toBe("Cowork data: the app's saved copy, 2m old.")
  expect((await ui.find({ type: 'Text', text: /Context/ }))?.text).toBe('Context · this Claude Code chat')

  // A click on a demo chat opens nothing and says so.
  await ui.post({ open: 'claude://claude.ai/cowork/demo-cowork-01', type: 'down' }, { in: 'line-working-demo-cowork-01' })
  expect(toasts).toContain('Demo chat: nothing to open')

  // Data files: only the demo folder (and the refresh signal), seeded from demo.json.
  const writes = [...files.keys()]
  expect(writes.filter(p => p.startsWith(`${DATA}/demo/`)).sort()).toEqual(
    ['groups.json', 'marks.json', 'settings.json'].map(n => `${DATA}/demo/${n}`),
  )
  expect(JSON.parse(files.get(`${DATA}/demo/settings.json`) ?? '{}')).toEqual({
    hiddenProjects: ['Old Experiments'],
    projectOrder: [],
    projectIds: { 'demo-project-garden': '🌱 Garden Planner', 'demo-project-recipes': 'Recipe Book', 'demo-project-old': 'Old Experiments' },
  })
  expect(JSON.parse(files.get(`${DATA}/demo/marks.json`) ?? '{}')).toEqual(FIXTURE.marks)
  expect(JSON.parse(files.get(`${DATA}/demo/groups.json`) ?? '{}')).toEqual({ groups: FIXTURE.groups })
  // Nothing outside the plugin folder, ChatsBar's data folder and its cache folder was touched.
  expect(touched.filter(p => !p.includes('/demo/demo.json') && !p.startsWith(`${DATA}/`) && !p.startsWith(`${HOME}/Library/Caches/ChatsBar/`))).toEqual([])
  await ui.unmount()
})
