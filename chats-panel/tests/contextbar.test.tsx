import { expect, test } from 'claude-code/testing'

// A Cowork chat on screen gets an empty gray context bar, not no bar, so the list does not move.
// The two bars must draw the same parts; only the bar's own texts and Svg may differ.
const PANE = {
  plugin: 'chats-panel',
  component: 'Pane',
  requestId: 'chat-list',
  props: { title: 'Chats', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const chat = (id: string, title: string) => ({
  id, link: `claude://claude.ai/cowork/${id}`, title, kind: 'cowork', project: '🌱 Garden Planner', lastActivityAt: 1, isWorking: false,
})

// The same value as COWORK_CONTEXT_BAR in hooks/register.tsx.
const COWORK = { label: 'Context', name: 'Context · not available for Cowork chats', percent: 0, note: '', isActive: false }
const CODE = { label: 'Context', percent: 20, note: '1K / 1M', isActive: true, segments: [{ color: '#4a8fe7', percent: 10 }] }

type T = Parameters<Parameters<typeof test>[1]>
// The hooks are set once per test; "bar" picks what the view holds for the next mount.
function hooks(on: T[1]) {
  const at = { bar: CODE as object }
  on('state.get', (_, e) => {
    const k = (e as { key?: string }).key
    if (k === 'view')
      return { value: { value: { shape: 'view-4', value: { chats: [chat('demo-cowork-01', 'Plan the spring planting calendar')], bars: [at.bar], projects: ['🌱 Garden Planner'], projectLinks: {}, usage: '', updatedAt: 1, cacheAt: 0 } }, version: 1 } }
    const d: Record<string, unknown> = { marks: {}, groups: [], hiddenProjects: null, isOpen: true, projectOrder: [], moving: '', cardStep: '', undoDelete: null, tab: 'Recent' }
    return { value: { value: k !== undefined && k in d ? d[k] : null, version: 1 } }
  })
  on('clock.now', () => ({ value: 1_000_000 }))
  return at
}

async function draw($: T[0], surface: string) {
  const ui = await $.ui.mount({ ...PANE, surface })
  const nodes = await ui.findAll({})
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()
  return { types: nodes.map(n => n.type), texts }
}

for (const surface of ['desktop', 'terminal'])
  test(`the Cowork context bar draws like a real one (${surface})`, async ($, on) => {
    const at = hooks(on)
    const code = await draw($, surface)
    at.bar = COWORK
    const cowork = await draw($, surface)
    expect(code.types.length).toBeGreaterThan(10)
    // Same parts in the same order: the same height, so the list under it stays in place.
    expect(cowork.types).toEqual(code.types)
    // Only the bar's own texts differ.
    const changed = cowork.texts.filter((t, i) => t !== code.texts[i])
    if (surface === 'desktop') {
      expect(changed).toEqual(['Context · not available for Cowork chats', '—'])
    } else {
      expect(changed.length).toBeGreaterThan(0)
      expect(changed.every(t => /—|Context/.test(t ?? ''))).toBe(true)
    }
  })
