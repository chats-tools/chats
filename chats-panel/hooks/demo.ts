import type { EngineInterface } from 'claude-code'

import type { ChatRow } from '../types'
import type { AppCache } from './appcache'

// Demo mode: made-up data for screenshots, and to try the panel without any Claude data.
// ChatsBar's chats.py reads the same file with the same rules.
//
//  - On when the file ~/Library/Application Support/ChatsBar/demo-mode exists, or the environment
//    variable CHATSBAR_DEMO is "1". The file is the only switch; the panel has no setting for it.
//  - The data comes from demo/demo.json in the plugin folder.
//  - Marks, groups and project settings then live in ~/Library/Application Support/ChatsBar/demo/,
//    so the real files are never touched. A missing file there is filled from demo.json.
//  - In demo mode the panel reads no real Claude data (no saved app copy, no session list, no
//    usage card, no logs, no transcripts) and a click on a chat opens nothing.

export const DEMO_TOAST = 'Demo chat: nothing to open'

// kind to the part of the claude:// link, as the real chats have
const LINK_PART = { cowork: 'cowork', code: 'epitaxy', chat: 'chat' } as const
type Kind = keyof typeof LINK_PART

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const text = (x: unknown) => (typeof x === 'string' && x !== '' ? x : undefined)
const numberOr = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d)

export type DemoChat = {
  id: string
  kind: Kind
  title: string
  project?: string
  minutesAgo: number
  isWorking: boolean
  isScheduled: boolean
}
export type DemoUsage = { label: string; percentUsed: number; resetsInMinutes: number }
export type DemoContext = { tokens: number; window: number; parts: { name: string; tokens: number }[] }

/** demo.json after checking: every field has the right type, bad entries are left out. */
export type Demo = {
  projects: { id: string; name: string }[]
  hiddenProjects: string[]
  chats: DemoChat[]
  marks: Obj
  groups: unknown[]
  usage: DemoUsage[]
  context: DemoContext | undefined
  savedCopyMinutesAgo: number
}

export const emptyDemo: Demo = {
  projects: [],
  hiddenProjects: [],
  chats: [],
  marks: {},
  groups: [],
  usage: [],
  context: undefined,
  savedCopyMinutesAgo: 0,
}

/** Checks the parsed demo.json; undefined when it is not an object. */
export function parseDemo(raw: unknown): Demo | undefined {
  if (!isObj(raw)) return undefined
  const list = (x: unknown) => (Array.isArray(x) ? x.filter(isObj) : [])
  const projects = list(raw.projects).flatMap(p => {
    const id = text(p.id)
    const name = text(p.name)
    return id !== undefined && name !== undefined ? [{ id, name }] : []
  })
  const chats = list(raw.chats).flatMap((c): DemoChat[] => {
    const id = text(c.id)
    const kind = c.kind
    if (id === undefined || (kind !== 'cowork' && kind !== 'code' && kind !== 'chat')) return []
    const project = text(c.project)
    return [
      {
        id,
        kind,
        title: text(c.title) ?? 'Untitled',
        ...(project !== undefined ? { project } : {}),
        minutesAgo: numberOr(c.minutesAgo, 0),
        isWorking: c.isWorking === true,
        isScheduled: c.isScheduled === true,
      },
    ]
  })
  const usage = list(raw.usage).flatMap((u): DemoUsage[] => {
    const label = text(u.label)
    return label === undefined ? [] : [{ label, percentUsed: numberOr(u.percentUsed, 0), resetsInMinutes: numberOr(u.resetsInMinutes, 0) }]
  })
  let context: DemoContext | undefined
  if (isObj(raw.context)) {
    const parts = list(raw.context.segments).flatMap(s => {
      const name = text(s.name)
      return name === undefined ? [] : [{ name, tokens: numberOr(s.tokens, 0) }]
    })
    context = { tokens: numberOr(raw.context.tokens, 0), window: numberOr(raw.context.window, 1_000_000), parts }
  }
  return {
    projects,
    hiddenProjects: Array.isArray(raw.hiddenProjects) ? raw.hiddenProjects.filter((x): x is string => typeof x === 'string') : [],
    chats,
    marks: isObj(raw.marks) ? raw.marks : {},
    groups: Array.isArray(raw.groups) ? raw.groups : [],
    usage,
    context,
    savedCopyMinutesAgo: numberOr(raw.savedCopyMinutesAgo, 0),
  }
}

/** What the panel's refresh needs, built from the demo data and the time now. */
export type DemoView = {
  /** The same shape the app's saved copy gives, so the rest of the refresh is unchanged. */
  cache: AppCache
  /** Usage windows as the usage card gives them; resetsAt is an ISO time */
  windows: { label: string; percentUsed: number; resetsAt: string }[]
  context: DemoContext | undefined
}

export function buildDemoView(d: Demo, now: number): DemoView {
  const chats: ChatRow[] = d.chats.map(c => ({
    id: c.id,
    kind: c.kind,
    title: c.title,
    lastActivityAt: now - c.minutesAgo * 60_000,
    isWorking: c.isWorking,
    project: c.project,
    link: `claude://claude.ai/${LINK_PART[c.kind]}/${c.id}`,
    ...(c.isScheduled ? { isScheduled: true } : {}),
  }))
  // Newest first; the sort is stable, so equal times keep the file's order.
  chats.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  const projectLinks: Record<string, string> = {}
  for (const p of d.projects) projectLinks[p.name] = `claude://claude.ai/project/${p.id}`
  return {
    cache: { chats, projects: d.projects.map(p => p.name), projectLinks, savedAt: now - d.savedCopyMinutesAgo * 60_000 },
    windows: d.usage.map(u => ({ label: u.label, percentUsed: u.percentUsed, resetsAt: new Date(now + u.resetsInMinutes * 60_000).toISOString() })),
    context: d.context,
  }
}

/** The data files a missing demo folder is filled with, from demo.json. */
export function demoSeeds(d: Demo) {
  return {
    'marks.json': d.marks,
    'groups.json': { groups: d.groups },
    'settings.json': {
      hiddenProjects: d.hiddenProjects,
      projectOrder: [] as string[],
      projectIds: Object.fromEntries(d.projects.map(p => [p.id, p.name])),
    },
  }
}

// ---------- the engine side ----------

async function dataRoot($: EngineInterface): Promise<string> {
  return `${(await $.env.get('HOME')) ?? ''}/Library/Application Support/ChatsBar`
}

/** Checked on each refresh: two cheap calls. */
export async function isDemoOn($: EngineInterface): Promise<boolean> {
  if ((await $.env.get('CHATSBAR_DEMO').catch(() => undefined)) === '1') return true
  return await $.fs.exists(`${await dataRoot($)}/demo-mode`).catch(() => false)
}

/** The folder of marks.json, groups.json and settings.json. */
export async function dataDir($: EngineInterface, isDemo: boolean): Promise<string> {
  const root = await dataRoot($)
  return isDemo ? `${root}/demo` : root
}

let loaded: Demo | undefined

/** demo/demo.json from the plugin folder (read once); undefined when missing or not usable. */
export async function loadDemo($: EngineInterface): Promise<Demo | undefined> {
  if (loaded !== undefined) return loaded
  try {
    loaded = parseDemo(JSON.parse(await $.fs.read(`${$.plugin.root}/demo/demo.json`)))
  } catch {
    loaded = undefined
  }
  return loaded
}

/** A demo data file that is missing is written from demo.json; one that exists is left alone. */
export async function seedDemoFiles($: EngineInterface, d: Demo): Promise<void> {
  const dir = await dataDir($, true)
  for (const [name, content] of Object.entries(demoSeeds(d))) {
    const path = `${dir}/${name}`
    if (!(await $.fs.exists(path).catch(() => true))) await $.fs.write(path, JSON.stringify(content, null, 2)).catch(() => undefined)
  }
}
