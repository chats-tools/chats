import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { ChatGroupDef, ChatRow, ChatView, Marks, UsageBar } from '../types'
import { readAppCache } from './appcache'
import type { AppCache } from './appcache'
import { DEMO_TOAST, buildDemoView, dataDir, emptyDemo, isDemoOn, loadDemo, seedDemoFiles } from './demo'
import type { Demo } from './demo'

// chats-panel
//   "Chats" pane (/chats): one tab per Cowork project, plus Recent, No project and Code.
//   A press on a chat opens it in the Claude app through its claude:// link.
//
// Sources, all on this Mac:
//   - Cowork chats and projects: the Claude app's own saved sidebar cache (appcache.ts).
//     Fallback when that cannot be read: Cowork session files (titles, no projects).
//   - Code tab chats: the desktop app's session list (it knows which are running).
//   - Usage: the desktop app's usage card, else this session's own reading.
//   - Demo mode (demo.ts) replaces all of the above with made-up data from demo/demo.json.
//
// Files written, all by this panel: marks.json, groups.json and settings.json in
// ~/Library/Application Support/ChatsBar (shared with the ChatsBar menu bar app), the refresh
// signal in ~/Library/Caches/ChatsBar, and the mod's own $.store. Nothing else.

type Chat = ChatRow
type Window = { label: string; percentUsed: number; resetsAt?: string; savedAt?: number }
const SAVED_KEY = 'lastUsageWindows'

const PANE = 'chat-list'
// The slash command that opens the panel.
const COMMAND = 'chats'
// Esc cancels an open card or "are you sure". The panel hears Esc only as a close of the whole
// pane (`closeOnEscape`), so that is on only while a card is open, and the ui.close hook below
// turns that close into "close the card" and keeps the panel open.
async function setEsc($: EngineInterface, on: boolean) {
  await $.ui.open({ id: PANE, title: 'Chats', ...(on ? { closeOnEscape: true as const } : {}) }).catch(() => undefined)
}
const REFRESH_MS = 20_000
const TAB_COUNT = 12

const view = atom(
  { plugin: 'chats-panel', key: 'view' } as const,
  { chats: [], bars: [], projects: [], projectLinks: {}, usage: '', updatedAt: 0, cacheAt: 0 } as ChatView,
  { shape: 'view-4' },
)
// Usage bars: on a surface that draws Svg (the desktop app) a thin bar with a gray track, as the
// Claude app's usage menu; elsewhere (the terminal) BAR_CELLS squares ■□.
const BAR_CELLS = 10
// The bar names as the Claude app's usage menu writes them.
const BAR_NAMES: Record<string, string> = { '5h': '5-hour limit', Week: 'Weekly · all models', Fable: 'Weekly · Fable', Context: 'Context · this Claude Code chat' }
// The colors of the context bar's parts, as the Claude app's Context card; any other part gray.
const CONTEXT_COLORS: Record<string, string> = {
  Messages: '#4a8fe7',
  'MCP tools': '#e8743b',
  'System tools': '#2bb58a',
  'System prompt': '#e5a93b',
}
// The project order and the hidden projects live only in settings.json (see "project setup"
// below). A hidden project's chats still show under Recent and Working now; only its button goes.
const tab = atom({ plugin: 'chats-panel', key: 'tab' } as const, 'Recent')
const marks = atom({ plugin: 'chats-panel', key: 'marks' } as const, {} as Marks)
const groups = atom({ plugin: 'chats-panel', key: 'groups' } as const, [] as ChatGroupDef[])
// What is open, as "<what>|<slot>|<id>"; '' when nothing is. <what> is:
//   "new": the name field of a new group for chat <id>;  "rename": the name field of group <id>
//   (slot "group": under a picked group's name);  "grename": the name field of the group of chat <id>;
//   and the floating cards the gears open: "menu" for chat <id>, "gmenu" for group <id>,
//   "projects|menu|all" (projects to show), "mygroups|menu|all" (Edit groups).
const moving = atom({ plugin: 'chats-panel', key: 'moving' } as const, '')
// Safe delete: a delete asks "Delete group …?" first, and the deleted group can be brought back
// for UNDO_MS.
const undoDelete = atom({ plugin: 'chats-panel', key: 'undoDelete' } as const, null as { group: ChatGroupDef; index: number; at: number } | null)
// A step inside an open card: "confirm|<group id>" (the "are you sure" question) or
// "rename|<group id>" (the name field in the Edit groups card); '' when none.
const cardStep = atom({ plugin: 'chats-panel', key: 'cardStep' } as const, '')
const UNDO_MS = 20_000
// The menus: a gear after each chat, after "My groups", after "Cowork Projects" and after a picked
// group's name opens a floating card of plain buttons (a Box with position "absolute": it floats
// over the lines below and pushes nothing down). The panel has no pop-up menu element of its own,
// and a drop-down (Select) always shows and ticks one of its lines as its face, which is confusing.
// Where the surface cannot draw an Svg (the terminal), the gear is the letter MENU_ICON.
const MENU_ICON = '⚙'
// The card's own colors, so the lines under it do not show through. The panel gives no
// light/dark reading and no theme color for a background, so this is a fixed dark gray.
// Change it here for a light app (for example '#f2f2f2').
const POPUP_BG = '#262626'
const POPUP_BORDER = '#4a4a4a'
// The gray of a card line under the pointer (see-through, as on the chat lines).
const HOVER_GRAY = '#80808033'
// The gear is an Svg drawn in a Box, with a clear Button over it (a Button holds only text: an Svg
// inside one makes the whole pane fail). GEAR_PX is the square the gear sits in (gray on hover and
// while its card is open); GEAR_ICON_PX the gear itself.
const GEAR_PX = 16
const GEAR_ICON_PX = 12
/** The gear drawing: the Lucide "settings" icon (ISC license, see THIRD_PARTY_NOTICES.md), centered in its square. */
const gearSvg = (isOpen: boolean) => {
  const pad = ((GEAR_PX - GEAR_ICON_PX) / GEAR_ICON_PX) * 12
  const vb = `${-pad} ${-pad} ${24 + 2 * pad} ${24 + 2 * pad}`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">` +
    (isOpen ? `<rect x="${-pad}" y="${-pad}" width="${24 + 2 * pad}" height="${24 + 2 * pad}" rx="4" fill="#808080" fill-opacity="0.3"/>` : '') +
    `<g fill="none" stroke="${isOpen ? '#e0e0e0' : '#a8a8a8'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>` +
    `<circle cx="12" cy="12" r="3"/></g></svg>`
  )
}
// Extra room under a section title whose next line is buttons: the top margin of an empty Box,
// in the desktop's own small spacing step (the terminal draws it as 0 rows). An empty Svg takes no room.
const TITLE_GAP = 'xs' as const
// Where a card starts, in cells from its line's left edge: right of the gear.
const POPUP_LEFT = 3
// The state dot before each chat: a drawn circle of DOT_PX pixels where the surface draws Svg,
// else the letter "⦁".
const DOT_PX = 9
/** The state dot as a drawing: green working, gray idle. */
const dotSvg = (isWorking: boolean) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="${isWorking ? '#3fb950' : '#8a8a8a'}"/></svg>`
// A chat's card opens upward when it is taller than the rows under its line, so the end of the
// panel does not cut it off. Under the list there are at least this many rows: Refresh, the
// 5 legend lines and the age line, less one to be safe.
const ROWS_UNDER_LIST = 6
// The chat line itself opens the chat: a Client (hooks/chatline.tsx) draws the line's styled Text
// and hears the pointer; a click posts the link to the ui.message hook below, which opens it.
// (A claude:// Link in a pane does nothing on the desktop, and text inside a Button loses its
// style.) A surface with no Client (mobile, VS Code) gets an "↗" button before the line instead.
// The project order and hidden projects, as exact names, from settings.json.
const projectOrder = atom({ plugin: 'chats-panel', key: 'projectOrder' } as const, [] as string[])
const hiddenProjects = atom({ plugin: 'chats-panel', key: 'hiddenProjects' } as const, null as string[] | null)
// /chats was opened in this chat. Module variables (isOn, the timers) start over on
// /reload-plugins, but $.state stays, so session.start (run again by a reload) turns the panel's
// updates back on by itself.
const isOpen = atom({ plugin: 'chats-panel', key: 'isOpen' } as const, false)

const fileCache = new Map<string, { mtimeMs: number; meta: Record<string, unknown> | null }>()
let timer: { cancel: () => void } | undefined
let signalTimer: { cancel: () => void } | undefined
let isBusy = false
// Off until /chats opens the panel: an installed mod loads in every chat, and most chats never use it.
let isOn = false
// When this chat's main loop last ended a turn; its own rate-limit reading is from then.
let lastTurnAt = 0
// This chat: the app's session list leaves it out, so the mod adds it itself.
// Running = between the main loop's turn.start and turn.complete.
let isSelfRunning = false


const ago = (ms: number) => {
  const m = Math.round(ms / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

// Time to a reset, as the Claude app's own usage menu writes it: minutes under an hour, whole
// hours under a day, else whole days ("45m", "3h", "1d").
const until = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const m = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

// Right-to-left text: the first letter (after emoji, stars, digits, spaces) is in the Hebrew
// block (U+0590 to U+05FF), written as escapes.
const isRtl = (s: string) => /^[^\p{L}]*[\u0590-\u05FF]/u.test(s)
// Unicode "right-to-left isolate" marks (U+2067, U+2069), so mixed text keeps its order.
const rtl = (s: string) => `\u2067${s}\u2069`

// Token counts as the Claude app writes them: 164500 is "164.5K", 1000000 is "1M".
const tokenText = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}K` : `${n}`)

const kindLabel = (c: Chat) => (c.kind === 'code' ? 'Code' : c.kind === 'chat' ? 'Chat' : 'Cowork')

// A Client line posts "down" and then "up" for one click: the second is skipped.
let lastOpen = { link: '', at: 0 }

// Only a chat in the current list or a project page opens: this shape and nothing else.
const OPENABLE_LINK = /^claude:\/\/claude\.ai\/(cowork|epitaxy|chat|project)\/[A-Za-z0-9_-]+$/

// Opens a claude:// link in the Claude app. In demo mode nothing is opened.
async function openLink($: EngineInterface, link: string, failText: string) {
  if (await isDemoOn($)) {
    $.ui.toast(DEMO_TOAST)
    return
  }
  if (!OPENABLE_LINK.test(link)) {
    $.ui.toast(failText)
    return
  }
  const r = await $.process.run(['/usr/bin/open', link])
  if (r.exitCode !== 0) $.ui.toast(failText)
}

function openChat($: EngineInterface, c: Chat) {
  return openLink($, c.link, `Could not open "${c.title}"`)
}

// ---------- fallback: Cowork session files (no projects) ----------

async function readMeta($: EngineInterface, path: string, mtimeMs: number) {
  const hit = fileCache.get(path)
  if (hit && hit.mtimeMs === mtimeMs) return hit.meta
  let meta: Record<string, unknown> | null = null
  try {
    const d = JSON.parse(await $.fs.read(path)) as Record<string, unknown>
    meta = {
      sessionId: d.sessionId,
      cliSessionId: d.cliSessionId,
      // The chat's folder: names its transcript's folder.
      cwd: d.cwd,
      title: d.title,
      lastActivityAt: d.lastActivityAt,
      isArchived: d.isArchived,
    }
  } catch {
    meta = null
  }
  fileCache.set(path, { mtimeMs, meta })
  return meta
}

async function orgDirs($: EngineInterface, base: string) {
  const out: string[] = []
  if (!(await $.fs.exists(base))) return out
  for (const acct of await $.fs.list(base)) {
    if (acct.kind !== 'dir' || acct.name === 'skills-plugin') continue
    for (const org of await $.fs.list(`${base}/${acct.name}`)) {
      if (org.kind === 'dir') out.push(`${base}/${acct.name}/${org.name}`)
    }
  }
  return out
}

async function coworkFileChats($: EngineInterface, appDir: string): Promise<Chat[]> {
  const chats: Chat[] = []
  for (const dir of await orgDirs($, `${appDir}/local-agent-mode-sessions`)) {
    for (const f of await $.fs.list(dir)) {
      if (f.kind !== 'file' || !/^local_.*\.json$/.test(f.name)) continue
      const m = await readMeta($, `${dir}/${f.name}`, f.mtimeMs)
      if (!m || m.isArchived === true) continue
      const id = String(m.sessionId)
      chats.push({
        id,
        kind: 'cowork',
        title: String(m.title ?? 'Untitled'),
        lastActivityAt: Number(m.lastActivityAt) || f.mtimeMs,
        isWorking: false,
        link: `claude://claude.ai/cowork/${id}`,
      })
    }
  }
  return chats
}

// ---------- Code tab ----------

// This chat's own row, from the Code tab's session file whose cliSessionId is ours.
async function selfChat($: EngineInterface, appDir: string, now: number): Promise<Chat | undefined> {
  const me = await $.session.id()
  for (const dir of await orgDirs($, `${appDir}/claude-code-sessions`)) {
    for (const f of await $.fs.list(dir)) {
      if (f.kind !== 'file' || !/^local_.*\.json$/.test(f.name)) continue
      const m = await readMeta($, `${dir}/${f.name}`, f.mtimeMs)
      if (!m || m.cliSessionId !== me) continue
      const id = String(m.sessionId)
      return {
        id,
        kind: 'code',
        title: `${String(m.title ?? 'This chat')} (this chat)`,
        lastActivityAt: isSelfRunning ? now : Number(m.lastActivityAt) || f.mtimeMs,
        isWorking: isSelfRunning,
        link: `claude://claude.ai/epitaxy/${id}`,
      }
    }
  }
  return undefined
}

async function codeChats($: EngineInterface): Promise<Chat[]> {
  const r = await $.mcp.call('ccd_session_mgmt', 'list_sessions', { limit: 30 })
  const block = r.content.find(b => b.type === 'text') as { text?: string } | undefined
  if (r.isError || !block?.text) return []
  const rows = JSON.parse(block.text) as Array<Record<string, unknown>>
  return rows.map(s => ({
    id: String(s.sessionId),
    kind: 'code' as const,
    title: String(s.title ?? 'Untitled'),
    lastActivityAt: Date.parse(String(s.lastActivityAt)) || 0,
    isWorking: s.isRunning === true,
    link: `claude://claude.ai/epitaxy/${String(s.sessionId)}`,
  }))
}

// ---------- usage ----------

async function usageWindows($: EngineInterface): Promise<Window[]> {
  try {
    const r = await $.mcp.call('ccd_session_mgmt', 'get_usage', {})
    const block = r.content.find(b => b.type === 'text') as { text?: string } | undefined
    if (!r.isError && block?.text) {
      const plan = (JSON.parse(block.text) as { plan?: { status?: string; windows?: Window[] } }).plan
      if (plan?.status === 'ok' && plan.windows) {
        // Keep the per-model readings: the fallback below has none.
        await $.store.set(SAVED_KEY, { at: await $.clock.now(), windows: plan.windows }).catch(() => undefined)
        return plan.windows
      }
    }
  } catch {
    // fall through
  }
  const { rateLimits } = await $.session.usage()
  const live: Window[] = rateLimits.map(w => ({
    label: w.kind === 'five_hour' ? '5-hour limit' : w.kind === 'seven_day' ? 'Weekly · all models' : w.kind,
    percentUsed: w.percentUsed,
    resetsAt: w.resetsAt,
  }))
  // The usage card did not answer. This chat's reading is from its last API call, so it goes
  // stale while other chats use the limits. Per window, keep the newer of that reading and the
  // last saved card reading, with its time, so the bar can say how old it is.
  const now = await $.clock.now()
  const liveAt = isSelfRunning ? now : lastTurnAt
  const saved = (await $.store.get(SAVED_KEY).catch(() => undefined)) as { at?: number; windows?: Window[] } | undefined
  const savedAt = saved?.at ?? 0
  const byLabel = new Map<string, Window>()
  for (const w of saved?.windows ?? []) byLabel.set(w.label, { ...w, savedAt })
  for (const w of live) {
    const old = byLabel.get(w.label)
    if (old === undefined || liveAt >= savedAt) byLabel.set(w.label, { ...w, savedAt: liveAt })
  }
  return [...byLabel.values()]
}

// A saved copy older than this gets a warning that says to restart the Claude app.
const STALE_AFTER_MS = 15 * 60 * 1000

// ---------- shared refresh signal ----------
// A Refresh click or a launch (ChatsBar start, /chats open) writes this file; every open view
// watches it, reads again and restarts its 20-second cycle, so all open views refresh together.
const SIGNAL_MS = 1000 // ChatsBar checks every second too
let signalSeen = -1 // modified time of the signal last acted on; -1 until the first check

async function signalPath($: EngineInterface) {
  return `${(await $.env.get('HOME')) ?? ''}/Library/Caches/ChatsBar/refresh-signal`
}

async function signalTime($: EngineInterface) {
  const p = await signalPath($)
  return (await $.fs.exists(p)) ? (await $.fs.stat(p)).mtimeMs : 0
}

async function sendSignal($: EngineInterface) {
  await $.fs.write(await signalPath($), `panel ${await $.clock.now()}`)
  signalSeen = await signalTime($) // our own click: do not react to it again
}

// The 20-second read cycle. Every signal restarts it, so all open views read at the same moments.
function restartCycle($: EngineInterface) {
  timer?.cancel()
  timer = $.clock.every(REFRESH_MS, () => void refresh($))
}

async function checkSignal($: EngineInterface) {
  if (!isOn) return
  const t = await signalTime($).catch(() => signalSeen)
  if (signalSeen < 0) signalSeen = t
  else if (t !== signalSeen) {
    signalSeen = t
    restartCycle($)
    void refresh($)
    return
  }
  // Another Code tab chat came on screen: draw its context bar now, not in 20 seconds.
  // (Demo mode reads no log.)
  if (await isDemoOn($).catch(() => false)) return
  const f = await shownCodeChat($).catch(() => drawnFocus)
  if (f !== drawnFocus) void refresh($)
}

// ---------- marks ----------
// Bold and Important per chat. One file for this panel and ChatsBar (right-click there), keyed by
// the chat's id in lower case (the last part of its claude:// link). Same rule as chats.py.
// The three data files sit in ChatsBar's folder; in demo mode in its "demo" subfolder.
async function dataFile($: EngineInterface, name: string) {
  return `${await dataDir($, await isDemoOn($))}/${name}`
}

function marksPath($: EngineInterface) {
  return dataFile($, 'marks.json')
}

// Marks from the title: "***" before the first letter makes the chat bold, "!" there makes it
// Important (orange). Same rule as titleMarks in ChatsBar's chats.py.
// They add to the right-click / "⋯" menu marks in marks.json.
const titleMarks = (title: string) => {
  const head = /^[^\p{L}\p{N}]*/u.exec(title)?.[0] ?? ''
  return { bold: head.includes('***'), important: head.includes('!') }
}

const markKey = (link: string) => (link.replace(/\/+$/, '').split('/').pop() ?? link).toLowerCase()

async function readMarks($: EngineInterface): Promise<Marks> {
  try {
    const p = await marksPath($)
    if (!(await $.fs.exists(p))) return {}
    const d = JSON.parse(await $.fs.read(p)) as unknown
    if (typeof d !== 'object' || d === null || Array.isArray(d)) return {}
    const out: Marks = {}
    for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
      if (typeof v !== 'object' || v === null) continue
      const m = v as Record<string, unknown>
      out[k] = { bold: m.bold === true, important: m.important === true }
    }
    return out
  } catch {
    return {}
  }
}

async function toggleMark($: EngineInterface, link: string, which: 'bold' | 'important') {
  const all = await readMarks($) // the file, not the atom: ChatsBar may have changed it
  const k = markKey(link)
  const m = { ...all[k], [which]: !all[k]?.[which] }
  const kept = Object.fromEntries(Object.entries(m).filter(([, v]) => v === true))
  if (Object.keys(kept).length === 0) delete all[k]
  else all[k] = kept
  await $.fs.write(await marksPath($), JSON.stringify(all, null, 2))
  await update($, marks, () => all)
  await sendSignal($).catch(() => undefined) // ChatsBar and other panels redraw
}

// ---------- groups ----------
// Subjects you name, like Chrome tab groups, for Code and Cowork chats together. One file for
// this panel and ChatsBar (which has drag and drop; the "Organize groups" button opens it):
//   {"groups": [{"id": "g-<ms>", "name": "Big ideas", "chats": ["<chat key>", ...]}]}
// The chat key is the same as for marks. A chat is in one group at most. Groups show newest first:
// by the last activity of their newest chat. Same rules as ChatsBar's chats.py.
function groupsPath($: EngineInterface) {
  return dataFile($, 'groups.json')
}

async function readGroupFile($: EngineInterface): Promise<Record<string, unknown>> {
  try {
    const p = await groupsPath($)
    if (!(await $.fs.exists(p))) return {}
    const d = JSON.parse(await $.fs.read(p)) as unknown
    return typeof d === 'object' && d !== null && !Array.isArray(d) ? (d as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const groupList = (o: Record<string, unknown>): ChatGroupDef[] =>
  (Array.isArray(o.groups) ? (o.groups as unknown[]) : []).flatMap(g => {
    if (typeof g !== 'object' || g === null) return []
    const r = g as Record<string, unknown>
    if (typeof r.id !== 'string') return []
    const ks = Array.isArray(r.chats) ? r.chats.filter((k): k is string => typeof k === 'string') : []
    return [{ id: r.id, name: typeof r.name === 'string' && r.name !== '' ? r.name : 'Group', chats: ks }]
  })

async function readGroups($: EngineInterface) {
  return groupList(await readGroupFile($))
}

/** Reads the file again (ChatsBar may have changed it), changes it, writes, tells every view. */
// The version in .claude-plugin/plugin.json of the code that runs, shown on the panel's last
// line. Each open Code chat runs its own copy of the mod, and /reload-plugins updates only the
// chat where it is typed: this line shows which copy draws the panel. Read once per load.
let versionRead: string | undefined
async function modVersion($: EngineInterface): Promise<string> {
  if (versionRead === undefined) {
    try {
      const j: unknown = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))
      const v = typeof j === 'object' && j !== null ? (j as { version?: unknown }).version : undefined
      versionRead = typeof v === 'string' ? v : ''
    } catch {
      versionRead = ''
    }
  }
  return versionRead
}

async function changeGroups($: EngineInterface, fn: (gs: ChatGroupDef[]) => ChatGroupDef[]) {
  const o = await readGroupFile($)
  const gs = fn(groupList(o))
  await $.fs.write(await groupsPath($), JSON.stringify({ ...o, groups: gs }, null, 2))
  await update($, groups, () => gs)
  await sendSignal($).catch(() => undefined) // ChatsBar and other panels redraw
}

/** Deletes a group (after its "are you sure"), and keeps it UNDO_MS for Undo. Chats stay. */
async function deleteGroup($: EngineInterface, id: string) {
  const gs = groupList(await readGroupFile($))
  const index = gs.findIndex(g => g.id === id)
  const group = gs[index]
  if (group === undefined) return
  await changeGroups($, x => x.filter(g => g.id !== id))
  const at = await $.clock.now()
  await update($, undoDelete, () => ({ group, index, at }))
  void $.clock.sleep(UNDO_MS).then(() => update($, undoDelete, v => (v?.at === at ? null : v)))
}

/** Undo: the group comes back in its place, with its chats. */
async function undoDeleteGroup($: EngineInterface) {
  const u = await read($, undoDelete)
  if (u === null) return
  await changeGroups($, gs => (gs.some(g => g.id === u.group.id) ? gs : [...gs.slice(0, u.index), u.group, ...gs.slice(u.index)]))
  await update($, undoDelete, () => null)
  $.ui.toast(`Group "${u.group.name}" is back`)
}

const moveChat = (key: string, gid: string | undefined) => (gs: ChatGroupDef[]) =>
  gs.map(g => {
    const ks = g.chats.filter(k => k !== key)
    return { ...g, chats: g.id === gid ? [key, ...ks] : ks }
  })

async function newGroup($: EngineInterface, name: string, key: string) {
  const n = name.trim()
  if (n === '') return
  const id = `g-${await $.clock.now()}`
  // The list stays where it is, so more chats can be put in the new group.
  await changeGroups($, gs => moveChat(key, id)([...gs, { id, name: n, chats: [] }]))
}

// ---------- project setup ----------
// The projects to hide, picked with the gear next to "Cowork Projects" here or "Projects…" in
// ChatsBar, and the order of the project buttons. One file for both views, exact names:
//   {"hiddenProjects": ["Old Experiments"], "projectOrder": ["Garden Planner"],
//    "projectIds": {"<project id>": "<last known name>"}}
// A new project shows until you hide it. With no file (or no key), nothing is hidden and the
// projects keep the app's own order. Same rule as hidden_setting/is_hidden/project_rank in
// ChatsBar's chats.py.
function settingsPath($: EngineInterface) {
  return dataFile($, 'settings.json')
}

async function readSettings($: EngineInterface): Promise<Record<string, unknown>> {
  try {
    const p = await settingsPath($)
    if (!(await $.fs.exists(p))) return {}
    const d = JSON.parse(await $.fs.read(p)) as unknown
    return typeof d === 'object' && d !== null && !Array.isArray(d) ? (d as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const hiddenList = (o: Record<string, unknown>) =>
  Array.isArray(o.hiddenProjects) ? o.hiddenProjects.filter((x): x is string => typeof x === 'string') : null

/** Exact names; null (no file, or no key) hides nothing. */
const isHiddenBy = (hidden: string[] | null) => (name: string) => hidden !== null && hidden.includes(name)

/** Names in `order` first, in that order; all others after, in their own order (sort is stable). */
const rankOf = (order: string[]) => (name: string) => {
  const i = order.indexOf(name)
  return i === -1 ? order.length : i
}

/** Shows or hides one project. The first pick starts from the hidden list now (empty when none). */
async function setShown($: EngineInterface, name: string, isShown: boolean) {
  const o = await readSettings($) // the file, not the atom: ChatsBar may have changed it
  const hidden = (hiddenList(o) ?? []).filter(p => p !== name)
  if (!isShown) hidden.push(name)
  await $.fs.write(await settingsPath($), JSON.stringify({ ...o, hiddenProjects: hidden }, null, 2))
  await update($, hiddenProjects, () => hidden)
  await sendSignal($).catch(() => undefined) // ChatsBar and other panels redraw
}

/**
 * Project renames are followed by the project's id, so a renamed project keeps its place and stays
 * hidden or shown. settings.json keeps {"projectIds": {id: last name}} and your order as exact
 * names, "projectOrder" (seeded as [] when missing). When a known id has a new name, the old name
 * is replaced in "hiddenProjects" and "projectOrder". The id is the last part of the project's
 * claude:// link. Same rule as follow_renames in ChatsBar's chats.py.
 */
async function followRenames($: EngineInterface, links: Record<string, string>, o: Record<string, unknown>) {
  const cur: Record<string, string> = {}
  for (const [name, link] of Object.entries(links)) cur[link.replace(/\/+$/, '').split('/').pop() ?? link] = name
  if (Object.keys(cur).length === 0) return o
  const ids = typeof o.projectIds === 'object' && o.projectIds !== null && !Array.isArray(o.projectIds) ? (o.projectIds as Record<string, unknown>) : {}
  const renamed = new Map<string, string>()
  for (const [id, old] of Object.entries(ids)) {
    const now = cur[id]
    if (typeof old === 'string' && now !== undefined && now !== old) renamed.set(old, now)
  }
  const next: Record<string, unknown> = { ...o }
  let changed = false
  for (const k of ['hiddenProjects', 'projectOrder']) {
    const v = o[k]
    if (Array.isArray(v)) {
      const nv = v.map(x => (typeof x === 'string' ? (renamed.get(x) ?? x) : x))
      if (JSON.stringify(nv) !== JSON.stringify(v)) {
        next[k] = nv
        changed = true
      }
    }
  }
  if (!Array.isArray(o.projectOrder)) {
    next.projectOrder = []
    changed = true
  }
  const newIds = { ...ids, ...cur }
  if (JSON.stringify(newIds) !== JSON.stringify(ids)) {
    next.projectIds = newIds
    changed = true
  }
  if (changed) await $.fs.write(await settingsPath($), JSON.stringify(next, null, 2))
  return next
}

// ---------- refresh ----------

// ---------- context of the chat on screen ----------
// The context bar follows the Code tab chat on screen. Free: local files only.
//  - Which chat is shown: the app's main.log writes "LocalSessions.setFocusedSession:
//    sessionId=local_<id>" on each switch ("=null" when no Code chat has focus: a Cowork chat, or
//    the app in the back). Only the new end of the log is read.
//  - Its tokens: its session file (claude-code-sessions/<account>/<org>/local_<id>.json) names
//    cliSessionId and cwd; the transcript ~/.claude/projects/<cwd, each non-letter-or-digit as
//    "-">/<cli>.jsonl ends with assistant lines whose usage input + cache read + cache creation
//    is the context fill, as of that chat's last answer. Only the file's tail is read (these
//    files can reach 50 MB).
//  - Cowork chats keep no token count on this Mac, so they never show here.
//  - The window size is not in those files: this chat's own window is used, else 1M.
let focus = { size: -1, id: '' }
let drawnFocus = ''

async function shownCodeChat($: EngineInterface): Promise<string> {
  const p = `${(await $.env.get('HOME')) ?? ''}/Library/Logs/Claude/main.log`
  if (!(await $.fs.exists(p))) return focus.id
  const size = (await $.fs.stat(p)).size
  if (size === focus.size) return focus.id
  // The new part since the last look; the last 1 MB on the first look or after the log was cut.
  const start = focus.size < 0 || size < focus.size ? Math.max(0, size - 1_048_576) : focus.size
  const text = await $.fs.read(p, { offset: start, length: Math.min(4_194_304, size - start) })
  let id = focus.id
  // "null": no Code tab chat has focus (a Cowork chat, or the app in the back). The context bar
  // is then hidden, so it does not stay on a Cowork chat.
  for (const m of text.matchAll(/setFocusedSession: sessionId=(local_[0-9a-f-]+|null)/g)) id = m[1] ?? id
  focus = { size, id }
  return id
}

async function codeChatTokens($: EngineInterface, appDir: string, id: string): Promise<number | undefined> {
  for (const dir of await orgDirs($, `${appDir}/claude-code-sessions`)) {
    const f = `${dir}/${id}.json`
    if (!(await $.fs.exists(f))) continue
    const m = await readMeta($, f, (await $.fs.stat(f)).mtimeMs)
    if (!m || typeof m.cwd !== 'string' || typeof m.cliSessionId !== 'string' || !/^[0-9a-f-]+$/i.test(m.cliSessionId)) return undefined
    const home = (await $.env.get('HOME')) ?? ''
    const path = `${home}/.claude/projects/${m.cwd.replace(/[^A-Za-z0-9]/g, '-')}/${m.cliSessionId}.jsonl`
    if (!(await $.fs.exists(path))) return undefined
    const size = (await $.fs.stat(path)).size
    for (const len of [262_144, 1_048_576, 4_194_304]) {
      const off = Math.max(0, size - len)
      const lines = (await $.fs.read(path, { offset: off, length: size - off })).split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i] ?? ''
        if (!line.includes('"assistant"') || !line.includes('"usage"')) continue
        try {
          const o = JSON.parse(line) as { type?: string; isSidechain?: boolean; message?: { usage?: Record<string, number> } }
          const u = o.message?.usage
          if (o.type !== 'assistant' || o.isSidechain === true || u === undefined) continue
          return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        } catch {
          // a line cut at the read's start
        }
      }
      if (off === 0) break
    }
    return undefined
  }
  return undefined
}

// The usage bars, from the usage card's windows (5-hour, weekly, weekly for one model).
function usageBars(windows: Window[], now: number): UsageBar[] {
  const week = windows.find(w => /weekly · all/i.test(w.label)) ?? windows.find(w => /week/i.test(w.label))
  const fable = windows.find(w => /fable/i.test(w.label))
  const five = windows.find(w => /5-hour/i.test(w.label))
  const isFiveOn = five !== undefined && five.resetsAt !== undefined && Date.parse(five.resetsAt) > now

  // A reading not from the usage card just now says how old it is.
  const age = (w: Window) =>
    w.savedAt === undefined ? '' : w.savedAt === 0 ? ' · old' : now - w.savedAt > 60_000 ? ` · ${ago(now - w.savedAt)} old` : ''

  const bars: UsageBar[] = []
  if (five) {
    bars.push({
      label: '5h',
      percent: isFiveOn ? five.percentUsed : 0,
      // No window running: show 0% as the app does, with no reset time.
      note: isFiveOn ? `↻${until(five.resetsAt, now)}${age(five)}` : age(five).replace(/^ · /, ''),
      isActive: true,
    })
  }
  if (week) bars.push({ label: 'Week', percent: week.percentUsed, note: `↻${until(week.resetsAt, now)}${age(week)}`, isActive: true })
  // Shown when the usage card has a Fable limit (now or in a saved reading).
  const isFableReset = fable?.resetsAt !== undefined && Date.parse(fable.resetsAt) <= now
  if (fable !== undefined) bars.push(
    isFableReset
      ? { label: 'Fable', percent: 0, note: 'reset', isActive: true }
      : {
          label: 'Fable',
          percent: fable.percentUsed,
          note: `↻${until(fable.resetsAt, now)}${age(fable)}`,
          isActive: true,
        },
  )
  return bars
}

// The context bar's parts as colored shares of the window.
const contextSegments = (parts: { name: string; tokens: number }[], max: number) =>
  parts.filter(p => p.tokens > 0).map(p => ({ color: (Object.prototype.hasOwnProperty.call(CONTEXT_COLORS, p.name) ? CONTEXT_COLORS[p.name] : undefined) ?? '#8a8a8a', percent: (p.tokens / Math.max(1, max)) * 100 }))

async function refresh($: EngineInterface) {
  if (!isOn || isBusy) return
  isBusy = true
  try {
    const now = await $.clock.now()
    const home = (await $.env.get('HOME')) ?? ''
    const appDir = `${home}/Library/Application Support/Claude`
    // Demo mode (checked each time): the view is built from demo.json and no Claude data is read.
    const isDemo = await isDemoOn($)
    const demoFile = isDemo ? await loadDemo($) : undefined
    if (isDemo && demoFile === undefined) $.ui.log('chats-panel: demo mode is on, but demo/demo.json could not be read', { to: 'debug' })
    const demo: Demo | undefined = isDemo ? (demoFile ?? emptyDemo) : undefined
    const demoView = demo !== undefined ? buildDemoView(demo, now) : undefined
    if (demoFile !== undefined) await seedDemoFiles($, demoFile)

    const [others, self, cache, windows, marked, grouped, settings] = await Promise.all([
      demo !== undefined ? ([] as Chat[]) : codeChats($).catch(() => [] as Chat[]),
      demo !== undefined ? undefined : selfChat($, appDir, now).catch(() => undefined),
      demoView !== undefined ? (demoView.cache as AppCache | undefined) : readAppCache($, appDir).catch(() => undefined),
      demoView !== undefined ? (demoView.windows as Window[]) : usageWindows($).catch(() => [] as Window[]),
      readMarks($),
      readGroups($),
      readSettings($),
    ])
    // A renamed project keeps its place and its show/hide (followRenames, by project id).
    const followed = cache !== undefined ? await followRenames($, cache.projectLinks, settings).catch(() => settings) : settings
    await update($, hiddenProjects, () => hiddenList(followed))
    const order = Array.isArray(followed.projectOrder) ? followed.projectOrder.filter((x): x is string => typeof x === 'string') : []
    await update($, projectOrder, v => (JSON.stringify(v) === JSON.stringify(order) ? v : order))
    await update($, marks, () => marked)
    await update($, groups, () => grouped)
    const code = self ? [self, ...others.filter(c => c.id !== self.id)] : others
    const cowork = cache ? cache.chats : await coworkFileChats($, appDir).catch(() => [] as Chat[])
    const all = [...code, ...cowork].sort((a, b) => b.lastActivityAt - a.lastActivityAt)

    const bars = usageBars(windows, now)
    // This chat's context window, under the usage bars: the percent and the tokens, as the top
    // line of the Claude app's Context card ("16% · 164.5K / 1M"), with its parts as colored
    // segments. From $.session.usage(), the status line's figures; no reading until the chat's
    // first answer after a start or a compaction. Same in a Code and a Cowork chat.
    if (demoView !== undefined) {
      // Demo mode: the figures come from demo.json, not from this session.
      const dc = demoView.context
      if (dc !== undefined) {
        bars.push({
          label: 'Context',
          percent: Math.round((dc.tokens / Math.max(1, dc.window)) * 100),
          note: `${tokenText(dc.tokens)} / ${tokenText(dc.window)}`,
          isActive: true,
          segments: contextSegments(dc.parts, dc.window),
        })
      }
      drawnFocus = ''
    } else {
      // The bar shows the parts, as the Claude app's Context card (Messages, MCP tools, System
      // tools, System prompt, then the rest in grays). "summary" counts them on this Mac, at no
      // cost; the figures beside the bar stay the status line's.
      const ctx = (await $.session.usage({ breakdown: 'summary' }).catch(() => $.session.usage()).catch(() => undefined))?.context
      const brk = ctx?.breakdown
      const segments =
        brk === undefined
          ? undefined
          : contextSegments(
              brk.categories.filter(c => c.kind === 'used'),
              brk.rawMaxTokens,
            )
      // The chat on screen, when it is another Code tab chat: its own figure, one color.
      const shown = await shownCodeChat($).catch(() => '')
      drawnFocus = shown
      const isNoCodeChat = shown === 'null'
      const other = shown !== '' && !isNoCodeChat && shown !== self?.id ? all.find(c => c.id === shown) : undefined
      const otherTokens = other !== undefined ? await codeChatTokens($, appDir, shown).catch(() => undefined) : undefined
      const short = (t: string) => (t.length > 28 ? `${t.slice(0, 27)}…` : t)
      if (isNoCodeChat) {
        // No bar: a Cowork chat (or no Code chat) is on screen.
      } else if (other !== undefined && otherTokens !== undefined) {
        const win = ctx?.window ?? 1_000_000
        bars.push({
          label: 'Context',
          name: `Context · ${short(other.title)}`,
          percent: Math.round((otherTokens / Math.max(1, win)) * 100),
          note: `${tokenText(otherTokens)} / ${tokenText(win)}`,
          isActive: true,
        })
      } else bars.push(
        ctx === undefined || ctx.tokens === undefined
          ? { label: 'Context', percent: 0, note: 'no reading yet', isActive: false }
          : {
              label: 'Context',
              percent: ctx.percent ?? Math.round((ctx.tokens / Math.max(1, ctx.window)) * 100),
              note: `${tokenText(ctx.tokens)} / ${tokenText(ctx.window)}`,
              isActive: true,
              ...(segments !== undefined && segments.length > 0 ? { segments } : {}),
            },
      )
    }

    await update($, view, () => ({
      chats: all.slice(0, 200),
      bars,
      projects: cache?.projects ?? [],
      projectLinks: cache?.projectLinks ?? {},
      usage: '',
      updatedAt: now,
      cacheAt: cache?.savedAt ?? 0,
    }))
  } catch (err) {
    $.ui.log(`chats-panel refresh failed: ${err instanceof Error ? err.name : 'error'}`, { to: 'debug' })
  } finally {
    isBusy = false
  }
}

// Opens the panel and starts its updates: by /chats, and again after a /reload-plugins.
async function startPanel($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'Chats' })
  await setEsc($, false)
  isOn = true
  // Opening the panel sends the signal, so ChatsBar and other open panels line up with it.
  await sendSignal($).catch(() => undefined)
  restartCycle($)
  if (!signalTimer) signalTimer = $.clock.every(SIGNAL_MS, () => void checkSignal($))
  void refresh($)
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    $.ui.status(undefined) // this mod sets no status line; clear any old text
    await $.command.register({ name: COMMAND, description: 'Show your chats by Cowork project; click one to open it' })
    // On demand only: nothing opens or runs until /chats. After a /reload-plugins in a chat
    // where /chats was opened, the panel goes on by itself.
    if (await read($, isOpen)) await startPanel($)
    return r
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      isSelfRunning = true
      void refresh($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isSelfRunning = false
      lastTurnAt = await $.clock.now()
      void refresh($)
    }
    return next(e)
  })

  on('session.measure', ($, e, next) => {
    void refresh($)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await update($, isOpen, () => true)
    await startPanel($)
    return { text: 'Chats list opened. Pick a project, then click a chat to open it.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Input } = table
    // Only the terminal and the desktop app have Client. Elsewhere 'a' cannot hear a click, so
    // the line falls back to the "↗" button.
    const Client = 'Client' in table ? table.Client : undefined
    const Svg = 'Svg' in table ? table.Svg : undefined
    const lineOpens = Client !== undefined
    const { chats, bars, projects: found, projectLinks, updatedAt, cacheAt } = await read($, view)
    const version = await modVersion($)
    // Stable sort: names in projectOrder first, in that order; the rest keep the app's order
    // (starred, then latest). With no projectOrder, the app's order is kept as it is.
    const rank = rankOf(await read($, projectOrder))
    const ranked = [...found].sort((a, b) => rank(a) - rank(b))
    const isHidden = isHiddenBy(await read($, hiddenProjects))
    const projects = ranked.filter(p => !isHidden(p))
    const current = await read($, tab)
    const marked = await read($, marks)
    const groupDefs = await read($, groups)
    const openKey = await read($, moving)
    const step = await read($, cardStep)
    // The name column of the "Edit groups" card: as wide as the longest name, at most 24 cells.
    const nameCol = Math.min(24, Math.max(8, ...(await read($, groups)).map(g => g.name.length + 1)))
    const undo = await read($, undoDelete)
    // A pop-up is open. The chat lines are then drawn as plain text, not as Clients: a Client
    // is drawn on its own layer, above a pop-up, so the lines would show through the card.
    // Plain text lies under the card. The lines open again once it closes.
    const isCardOpen = /^(menu\||gmenu\||projects\|menu\||mygroups\|menu\|)/.test(openKey)
    const now = await $.clock.now()
    if (updatedAt === 0) return <Text dimColor>Loading chats…</Text>

    // Groups, newest first: by the last activity of their newest chat in view. Groups with no
    // chat in view go last, in the file's order. Same rule as ChatsBar's chats.py.
    const keyOf = (c: Chat) => markKey(c.link)
    const ordered = groupDefs
      .map((g, i) => {
        const set = new Set(g.chats)
        const items = chats.filter(c => set.has(keyOf(c)))
        return { ...g, items, at: items[0]?.lastActivityAt ?? 0, i }
      })
      .sort((a, b) => b.at - a.at || a.i - b.i)
    const groupOf = (key: string) => ordered.find(g => g.chats.includes(key))

    const fixedTabs = ['Recent', 'No project', 'Code']
    const tabs = [...fixedTabs, ...projects, ...ordered.map(g => `group:${g.id}`)]
    const selected = tabs.includes(current) ? current : 'Recent'
    const selectedGroup = ordered.find(g => `group:${g.id}` === selected)
    const working = chats.filter(c => c.isWorking)
    const shown = selectedGroup
      ? selectedGroup.items
      : chats
      .filter(c =>
        selected === 'Recent'
          ? true
          : selected === 'Code'
            ? c.kind === 'code'
            : selected === 'No project'
              ? c.kind !== 'code' && !c.project
              : c.project === selected,
      )
      .slice(0, TAB_COUNT)

    // The gear after every chat opens a card (see `popup`): put the chat in a group, start a new
    // group, take it out, or turn Bold / Important on or off. The panel has no right-click on
    // its own lines, so the gear does that job.
    const closeOpen = async () => {
      await update($, cardStep, () => '')
      await update($, moving, () => '')
      await setEsc($, false)
    }
    // The gear that opens the pop-up `id` (a value of the `moving` atom); a click again closes it.
    // A drawn Svg sits on a layer above a card and shows through it. Chat-line gears stay drawn:
    // they sit in cells 0-1, and every card starts at POPUP_LEFT (cell 3), so no card covers them.
    // A title gear (after "My groups", "Cowork Projects" or a group's name) can lie under a card:
    // while another card is open it is left out, in an empty box of the same width, so nothing
    // moves. (A ⚙ letter in its place was drawn cut in half.)
    const gear = (id: string, key: string) =>
      isCardOpen && openKey !== id && !id.startsWith('menu|') ? (
        <Box key={key} flexShrink={0} width={2} />
      ) : Svg !== undefined ? (
        // A Button holds only strings and Text: an Svg inside one makes the whole panel fail.
        // So the gear is drawn, and a clear button of two spaces lies on top of it (absolute,
        // painted after the drawing), which takes the click and the hover.
        <Box key={key} flexShrink={0} width={2} alignItems="center" justifyContent="center">
          <Svg key={`${key}-svg`} source={gearSvg(openKey === id)} alt="Menu" width={GEAR_PX} height={GEAR_PX} />
          <Box key={`${key}-hit`} position="absolute" top={0} left={0} right={0} bottom={0}>
            <Button
              key={`${key}-btn`}
              plain
              label={'\u00a0\u00a0'}
              hover={{ backgroundColor: HOVER_GRAY }}
              onPress={async () => {
                await update($, cardStep, () => '')
                await update($, moving, v => (v === id ? '' : id))
                await setEsc($, (await read($, moving)) !== '')
              }}
            />
          </Box>
        </Box>
      ) : (
        <Button key={key} plain label={MENU_ICON} onPress={() => update($, moving, v => (v === id ? '' : id))} />
      )
    // The group whose name field is open under the "My groups" title (its "Rename …" was picked).
    const renaming = openKey.startsWith('rename|mygroups|') ? ordered.find(g => `rename|mygroups|${g.id}` === openKey) : undefined
    const act = async (c: Chat, slot: string, v: string) => {
      const key = keyOf(c)
      const inGroup = groupOf(key)
      if (v === 'bold' || v === 'important') await toggleMark($, c.link, v)
      else if (v === 'new') {
        await update($, moving, () => `new|${slot}|${key}`)
        await setEsc($, true)
      }
      // Rename or delete the chat's own group from its menu (also next to a picked group's
      // heading).
      else if (v === 'grename' && inGroup !== undefined) {
        await update($, moving, () => `grename|${slot}|${key}`)
        await setEsc($, true)
      }
      else if (v === 'gdelete' && inGroup !== undefined) {
        // Ask first ("are you sure"); Undo stays for UNDO_MS after the delete.
        await update($, cardStep, () => `confirm|${inGroup.id}`)
      }
      else if ((v === 'out' || v === 'nogroup') && inGroup !== undefined) {
        await changeGroups($, moveChat(key, undefined))
        await closeOpen()
        $.ui.toast(`Taken out of "${inGroup.name}"`)
      } else if (v.startsWith('g:')) {
        const g = ordered.find(x => `g:${x.id}` === v)
        if (g !== undefined && g.id !== inGroup?.id) {
          await changeGroups($, moveChat(key, g.id))
          $.ui.toast(`Put in "${g.name}"`)
        }
        await closeOpen()
      }
    }
    const menu = (c: Chat, slot: string) => gear(`menu|${slot}|${keyOf(c)}`, `more-${slot}-${c.id}`)
    // What opens under a chat line: the name field of a new group, or of a rename of its group.
    const nameField = (c: Chat, slot: string) => (
      <Input
        key={`new-group-name-${slot}-${c.id}`}
        placeholder="New group name, then Enter"
        submitLabel="make group"
        autoFocus
        onSubmit={async v => {
          if (v.trim() === '') return
          await newGroup($, v, keyOf(c))
          await closeOpen()
          $.ui.toast(`Group "${v.trim()}" made`)
        }}
      />
    )
    const under = (c: Chat, slot: string) => {
      const key = keyOf(c)
      const own = groupOf(key)
      if (openKey === `grename|${slot}|${key}` && own !== undefined) {
        return (
          <Box key={`grenamebox-${slot}-${c.id}`} flexDirection="column" marginLeft={4}>
            <Input
              key={`grename-${slot}-${c.id}`}
              label="Group name: "
              value={own.name}
              submitLabel="rename"
              autoFocus
              onSubmit={async v => {
                if (v.trim() === '') return
                await changeGroups($, gs => gs.map(g => (g.id === own.id ? { ...g, name: v.trim() } : g)))
                await closeOpen()
                $.ui.toast(`Renamed to "${v.trim()}"`)
              }}
            />
            <Button key={`grename-cancel-${slot}-${c.id}`} plain dimColor label="✕ Cancel" onPress={closeOpen} />
          </Box>
        )
      }
      if (openKey === `new|${slot}|${key}`) {
        return (
          <Box key={`newbox-${slot}-${c.id}`} flexDirection="column" marginLeft={4}>
            {nameField(c, slot)}
            <Button key={`new-cancel-${slot}-${c.id}`} plain dimColor label="✕ Cancel" onPress={closeOpen} />
          </Box>
        )
      }
      return null
    }
    // A pop-up: a box that floats over the lines next to its gear and pushes nothing.
    // It sits inside the gear's line, which spans the panel; with `left` and no width it takes
    // the width of its longest line, as the Claude app's own menus do. `up`: it opens
    // above the line, for lines near the panel's bottom edge. While one is open, the chat lines
    // are drawn as plain text (see `isCardOpen`), so the card covers them.
    // A click on the gear again, on "Close", or on a job closes it.
    const popup = (key: string, up: boolean, children: RenderChildren[]) => (
      <Box
        key={key}
        position="absolute"
        {...(up ? { bottom: 1 } : { top: 1 })}
        left={POPUP_LEFT}
        flexDirection="column"
        alignItems="stretch"
        borderStyle="round"
        borderColor={POPUP_BORDER}
        paddingX={1}
        backgroundColor={POPUP_BG}
      >
        {children}
      </Box>
    )
    // One line of a pop-up, as in the Claude app's menus: a tick column (so all labels line up),
    // then the label; the line turns gray under the pointer.
    const item = (key: string, isTicked: boolean, label: string, onPress: () => unknown, isDim = false) => (
      <Box key={key} flexDirection="row">
        <Box key={`${key}-tick`} width={2} flexShrink={0}>
          <Text>{isTicked ? '✓' : ' '}</Text>
        </Box>
        <Button key={`${key}-btn`} plain dimColor={isDim} label={label} hover={{ backgroundColor: HOVER_GRAY }} onPress={onPress} />
      </Box>
    )
    // A small gray heading inside a pop-up.
    const heading = (key: string, text: string) => (
      <Text key={key} dimColor>
        {text}
      </Text>
    )
    // "Are you sure?" inside a pop-up: the question, what stays, and two buttons. Delete keeps the group for Undo (UNDO_MS); Cancel goes back to the pop-up.
    const confirmDelete = async (id: string, close: boolean) => {
      await update($, cardStep, () => '')
      await deleteGroup($, id)
      if (selected === `group:${id}`) await update($, tab, () => 'Recent')
      if (close) await closeOpen()
    }
    const confirmBody = (g: (typeof ordered)[number], k: string, close: boolean) => [
      <Text key={`${k}-q`} bold>
        {`Delete group "${g.name}"?`}
      </Text>,
      <Text key={`${k}-n`} dimColor>
        {`Its ${g.items.length} chat${g.items.length === 1 ? '' : 's'} stay in their projects. Undo for 20 seconds.`}
      </Text>,
      <Box key={`${k}-b`} flexDirection="row" columnGap={1} marginTop={1}>
        <Button key={`${k}-cancel`} label="Cancel" variant="secondary" onPress={() => update($, cardStep, () => '')} />
        <Button key={`${k}-del`} label="Delete" variant="primary" onPress={() => confirmDelete(g.id, close)} />
      </Box>,
    ]
    // The chat's pop-up: its place ("No group" or a group, ticked), a new group, rename or delete
    // its group, Bold, Important. The same jobs as the drop-down had.
    // The rows of a chat's card: 2 headings, "No group", each group, "New group", Rename and
    // Delete (when in a group), Bold, Important, Close, and the 2 border rows.
    const cardRows = (c: Chat) => ordered.length + 9 + (groupOf(keyOf(c)) !== undefined ? 2 : 0)
    const chatPopup = (c: Chat, slot: string, up: boolean) => {
      const key = keyOf(c)
      if (openKey !== `menu|${slot}|${key}`) return null
      const inGroup = groupOf(key)
      const saved = marked[key] ?? {}
      // A job, then the pop-up closes. "New group" and "Rename" open their name field instead.
      const pick = async (v: string) => {
        await act(c, slot, v)
        if (v !== 'new' && v !== 'grename' && v !== 'gdelete') await closeOpen()
      }
      const id = `${slot}-${c.id}`
      const own = inGroup !== undefined ? ordered.find(g => g.id === inGroup.id) : undefined
      if (own !== undefined && step === `confirm|${own.id}`) return popup(`menubox-${id}`, up, confirmBody(own, `pmc-${id}`, true))
      return popup(`menubox-${id}`, up, [
        heading(`pm-h-${id}`, 'Group'),
        item(`pm-none-${id}`, inGroup === undefined, 'No group', () => pick('out')),
        ...ordered.map(g => item(`pm-g-${id}-${g.id}`, inGroup?.id === g.id, isRtl(g.name) ? rtl(g.name) : g.name, () => pick(`g:${g.id}`))),
        item(`pm-new-${id}`, false, '＋ New group…', () => pick('new')),
        ...(inGroup !== undefined
          ? [
              item(`pm-ren-${id}`, false, `✎ Rename "${inGroup.name}"…`, () => pick('grename')),
              item(`pm-del-${id}`, false, `🗑 Delete "${inGroup.name}" (chats stay)`, () => pick('gdelete')),
            ]
          : []),
        heading(`pm-h2-${id}`, 'Mark'),
        item(`pm-bold-${id}`, saved.bold === true, 'Bold', () => pick('bold')),
        item(`pm-imp-${id}`, saved.important === true, 'Important (orange)', () => pick('important')),
        item(`pm-close-${id}`, false, '✕ Close', closeOpen, true),
      ])
    }
    // The same "⋯" for the group whose chats are listed: rename it or delete it.
    const groupAct = async (g: (typeof ordered)[number], v: string) => {
      if (v === 'rename') {
        await update($, moving, () => `rename|group|${g.id}`)
        await setEsc($, true)
      }
      else if (v === 'delete') {
        await update($, cardStep, () => `confirm|${g.id}`)
      }
    }
    const row = (c: Chat, showWhere = selected === 'Recent', slot = 'list', up = false) => {
      // What follows the title: in Recent, Working now and a group, "| <project> | Cowork" or
      // "| Code"; under "No project", "| Cowork" (or "| Chat"); in a project's or the Code list
      // nothing, since the list's title says it. A scheduled-task run then adds "| Scheduled".
      // Same in chats.py.
      const where = [
        ...(showWhere ? [c.project ?? '', kindLabel(c)] : selected === 'No project' ? [kindLabel(c)] : c.kind === 'chat' ? ['Chat'] : []),
        c.isScheduled === true ? 'Scheduled' : '',
      ]
        .filter(x => x !== '')
        .join(' | ')
      // Same layout for every line, left to right: gear, dot, time | title | where. The text part
      // opens the chat (a Client; see chatline.tsx). A working chat shows a green dot and no time.
      // A right-to-left title is read right to left inside its own part only.
      // Marks: Important is orange, Bold is bold. Same look as ChatsBar.
      const saved = marked[markKey(c.link)] ?? {}
      const fromTitle = titleMarks(c.title)
      const m = { bold: saved.bold === true || fromTitle.bold, important: saved.important === true || fromTitle.important }
      const title = isRtl(c.title) ? rtl(c.title) : c.title
      // The parts of the line's text, drawn as plain Text while a card is open (a Client lies
      // above the card) and on a surface with no Client. chatline.tsx draws the same parts.
      const parts = [
        c.isWorking ? (
          <Text key="when" color="success">⦁ </Text>
        ) : (
          <Text key="when" dimColor>{`⦁ ${ago(now - c.lastActivityAt)} | `}</Text>
        ),
        // With the drawn dot (DOT_PX), the time alone; parts[0] is then left out.
        <Text key="when2" dimColor>{c.isWorking ? '' : `${ago(now - c.lastActivityAt)} | `}</Text>,
        <Text key="title" bold={m.bold} color={m.important ? 'warning' : undefined}>
          {title}
        </Text>,
        <Text key="where" dimColor>{where !== '' ? ` | ${where}` : ''}</Text>,
      ]
      const hasDot = DOT_PX > 0 && Svg !== undefined
      const line = (
        <Box key={`chatrow-${slot}-${c.id}`} flexDirection="row" columnGap={1} alignItems="center">
          {/* The ↗ button (no Client only) and the gear never shrink; a long title is cut instead. */}
          {/* No gear under "Working now": those chats are also in the lists below. */}
          {(slot !== 'working' || !lineOpens) && (
            <Box key={`chatctl-${slot}-${c.id}`} flexDirection="row" columnGap={1} alignItems="center" flexShrink={0}>
              {!lineOpens && <Button key={`chat-${slot}-${c.id}`} label="↗" onPress={() => openChat($, c)} />}
              {slot !== 'working' && menu(c, slot)}
            </Box>
          )}
          {/* The state dot, drawn: a Client cannot draw an Svg, so it sits here, before the line. */}
          {hasDot && (
            <Box key={`dot-${slot}-${c.id}`} flexShrink={0}>
              {/* While a card is open, the dot is the ⦁ letter: a drawn dot shows through the card. */}
              {isCardOpen ? (
                <Text color={c.isWorking ? 'success' : undefined} dimColor={!c.isWorking}>●</Text>
              ) : (
                <Svg source={dotSvg(c.isWorking)} alt={c.isWorking ? 'working' : 'idle'} width={DOT_PX} height={DOT_PX} />
              )}
            </Box>
          )}
          {/* Cut with "…" at the panel's edge. No sideways scroll: a Box with overflowX="scroll"
              draws its text in a wide fixed-width font. */}
          {!lineOpens || isCardOpen ? (
            <Text wrap="truncate-end">{hasDot ? parts.slice(1) : [parts[0], ...parts.slice(2)]}</Text>
          ) : (
            // The Client draws the same parts and posts a click (see chatline.tsx).
            <Client
              key={`line-${slot}-${c.id}`}
              module="./chatline.tsx"
              flexGrow={1}
              props={{
                link: c.link,
                when: `${ago(now - c.lastActivityAt)} | `,
                isWorking: c.isWorking,
                title,
                where: where !== '' ? ` | ${where}` : '',
                isBold: m.bold,
                isImportant: m.important,
                showDot: !hasDot,
              }}
            />
          )}
          {chatPopup(c, slot, up)}
        </Box>
      )
      const extra = under(c, slot)
      if (extra === null) return line
      return (
        <Box key={`rowcol-${slot}-${c.id}`} flexDirection="column">
          {line}
          {extra}
        </Box>
      )
    }
    const groupButton = (g: (typeof ordered)[number]) => (
      <Button
        key={`gtab-${g.id}`}
        label={`${isRtl(g.name) ? rtl(g.name) : g.name} (${g.items.length})`}
        variant={`group:${g.id}` === selected ? 'primary' : 'secondary'}
        onPress={() => update($, tab, () => `group:${g.id}`)}
      />
    )
    const tabButton = (t: string) => (
      <Button
        key={`tab-${t}`}
        label={isRtl(t) ? rtl(t) : t}
        variant={t === selected ? 'primary' : 'secondary'}
        onPress={() => update($, tab, () => t)}
      />
    )

    // Extra room under a section title (as under "Working now").
    const titleGap = (key: string) => <Box key={key} marginTop={TITLE_GAP} />

    return (
      <Box flexDirection="column" gap={1}>
        {bars.length > 0 && 'Svg' in table && (
          // As the Claude app's own usage menu: the name on the left, the
          // figure on the right, then a thin bar with a gray track. Blue, yellow from 70%, red
          // from 90%. An Svg draws the bar (a Box is a whole text row tall).
          <Box flexDirection="column" gap={1}>
            {bars.map(b => {
              const Svg = table.Svg
              const p = b.isActive ? Math.max(0, Math.min(100, b.percent)) : 0
              const fill = p >= 90 ? '#e5534b' : p >= 70 ? '#f2b33d' : '#4a8fe7'
              const name = b.name ?? BAR_NAMES[b.label] ?? b.label
              const figure = `${b.isActive ? `${Math.round(p)}%` : '—'}${b.note !== '' ? ` · ${b.note.replace(/^↻/, 'Resets ')}` : ''}`
              const svg =
                `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 6" width="300" height="6" preserveAspectRatio="none">` +
                `<rect x="0" y="0" width="300" height="6" rx="3" fill="#8a8a8a" fill-opacity="0.3"/>` +
                (b.segments !== undefined && b.segments.length > 0
                  ? // The context bar's parts, side by side with a thin gap, inside the rounded track.
                    `<clipPath id="c"><rect x="0" y="0" width="300" height="6" rx="3"/></clipPath><g clip-path="url(#c)">` +
                    (() => {
                      let x = 0
                      return b.segments
                        .map(sg => {
                          const w = Math.max(1.5, sg.percent * 3)
                          const r = `<rect x="${x.toFixed(1)}" y="0" width="${Math.max(0.5, w - 1).toFixed(1)}" height="6" fill="${sg.color}"/>`
                          x += w
                          return r
                        })
                        .join('')
                    })() +
                    `</g>`
                  : p > 0
                    ? `<rect x="0" y="0" width="${Math.max(6, p * 3).toFixed(1)}" height="6" rx="3" fill="${fill}"/>`
                    : '') +
                `</svg>`
              return (
                <Box key={`ubar-${b.label}`} flexDirection="column">
                  <Box key={`ubar-top-${b.label}`} flexDirection="row" justifyContent="space-between" columnGap={1}>
                    <Text wrap="truncate-end">{name}</Text>
                    <Text dimColor wrap="truncate-end">
                      {figure}
                    </Text>
                  </Box>
                  <Svg key={`ubar-svg-${b.label}`} source={svg} alt={`${name}: ${figure}`} height={6} />
                </Box>
              )
            })}
          </Box>
        )}
        {bars.length > 0 && !('Svg' in table) && (
          // Two columns, labels then bars, so the bars line up in any font.
          <Box flexDirection="row" columnGap={1}>
            <Box flexDirection="column">
              {bars.map(b => (
                <Text key={`bar-label-${b.label}`}>{b.label}</Text>
              ))}
            </Box>
            <Box flexDirection="column">
              {bars.map(b => {
                const p = Math.max(0, Math.min(100, b.percent))
                const full = Math.round((p / 100) * BAR_CELLS)
                const color = p >= 90 ? 'error' : p >= 70 ? 'warning' : 'success'
                return (
                  <Text key={`bar-${b.label}`} wrap="truncate-end">
                    <Text color={color}>{'■'.repeat(full)}</Text>
                    <Text dimColor>{'□'.repeat(BAR_CELLS - full)}</Text>
                    {` ${b.isActive ? `${Math.round(p)}%` : '—'}`}
                    <Text dimColor>{b.note !== '' ? ` ${b.note}` : ''}</Text>
                  </Text>
                )
              })}
            </Box>
          </Box>
        )}
        {/* The app saves its sidebar copy every few minutes while in use. An app update once made
            it stop saving until a restart. Same rule as ChatsBar's chats.py. */}
        {cacheAt > 0 && now - cacheAt > STALE_AFTER_MS && (
          <Text color="warning">
            {`⚠ The Claude app's saved chat list is ${ago(now - cacheAt)} old. The app may have stopped saving it. Quit (⌘Q) and reopen the Claude app.`}
          </Text>
        )}
        {/* Always shown: running chats from every place (Code, No project, all projects). */}
        <Box flexDirection="column">
          <Text bold>{`Working now (${working.length})`}</Text>
          {working.length === 0 ? <Text dimColor>  nothing running</Text> : working.map(c => row(c, true, 'working'))}
        </Box>
        <Box flexDirection="column">
          {/* Rename and delete for every group, right after the title. Rename opens the name
              field under this title. */}
          <Box flexDirection="row" columnGap={1} alignItems="center">
            <Text bold>My groups</Text>
            {ordered.length > 0 && (
              gear('mygroups|menu|all', 'mygroupsmenu-btn')
            )}
            {/* Undo of the last group delete, for 20 seconds, next to the title. */}
            {undo !== null && (
              <Box key="undo-band" flexDirection="row" columnGap={1} alignItems="center" marginLeft={1}>
                <Text dimColor>{`"${undo.group.name}" deleted`}</Text>
                <Button key="undo-btn" label="Undo" variant="primary" onPress={() => undoDeleteGroup($)} />
              </Box>
            )}
            {openKey === 'mygroups|menu|all' &&
              // "Edit groups", as the Claude app's "Edit environment" dialog: a
              // title and ✕, one aligned row per group (name, chats, Rename, Delete), Done. Rename
              // and the "are you sure" of Delete open in the group's own row.
              popup('mygroupsbox', false, [
                <Box key="mg-head" flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={4} marginBottom={1}>
                  <Text key="mg-title" bold>
                    Edit groups
                  </Text>
                  <Button key="mg-x" plain dimColor label="✕" hover={{ backgroundColor: HOVER_GRAY }} onPress={closeOpen} />
                </Box>,
                ...ordered.map(g => {
                  const name = isRtl(g.name) ? rtl(g.name) : g.name
                  if (step === `rename|${g.id}`) {
                    return (
                      <Box key={`mg-row-${g.id}`} flexDirection="column">
                        <Input
                          key={`mg-name-field-${g.id}`}
                          label="Name: "
                          value={g.name}
                          submitLabel="Save"
                          autoFocus
                          onSubmit={async v => {
                            if (v.trim() === '') return
                            await changeGroups($, gs => gs.map(x => (x.id === g.id ? { ...x, name: v.trim() } : x)))
                            await update($, cardStep, () => '')
                            $.ui.toast(`Renamed to "${v.trim()}"`)
                          }}
                        />
                        <Button key={`mg-ren-cancel-${g.id}`} plain dimColor label="Cancel" onPress={() => update($, cardStep, () => '')} />
                      </Box>
                    )
                  }
                  if (step === `confirm|${g.id}`) {
                    return (
                      <Box key={`mg-row-${g.id}`} flexDirection="column" marginY={1}>
                        {confirmBody(g, `mgc-${g.id}`, false)}
                      </Box>
                    )
                  }
                  return (
                    <Box key={`mg-row-${g.id}`} flexDirection="row" alignItems="center" columnGap={1}>
                      <Box key={`mg-namecol-${g.id}`} width={nameCol} flexShrink={0}>
                        <Text wrap="truncate-end">{name}</Text>
                      </Box>
                      <Box key={`mg-countcol-${g.id}`} width={9} flexShrink={0}>
                        <Text dimColor>{`${g.items.length} chat${g.items.length === 1 ? '' : 's'}`}</Text>
                      </Box>
                      <Button
                        key={`mg-ren-${g.id}`}
                        plain
                        label="Rename"
                        hover={{ backgroundColor: HOVER_GRAY }}
                        onPress={() => update($, cardStep, () => `rename|${g.id}`)}
                      />
                      <Button
                        key={`mg-del-${g.id}`}
                        plain
                        label="Delete"
                        hover={{ backgroundColor: HOVER_GRAY }}
                        onPress={() => update($, cardStep, () => `confirm|${g.id}`)}
                      />
                    </Box>
                  )
                }),
                <Box key="mg-foot" flexDirection="row" justifyContent="flex-end" marginTop={1}>
                  <Button key="mg-done" label="Done" variant="primary" onPress={closeOpen} />
                </Box>,
              ])}
          </Box>
          {renaming !== undefined && (
            <Box key={`mygroups-rename-${renaming.id}`} flexDirection="column" marginLeft={2}>
              <Input
                key={`mygroups-rename-field-${renaming.id}`}
                label="New name: "
                value={renaming.name}
                submitLabel="rename"
                autoFocus
                onSubmit={async v => {
                  if (v.trim() === '') return
                  await changeGroups($, gs => gs.map(g => (g.id === renaming.id ? { ...g, name: v.trim() } : g)))
                  await closeOpen()
                  $.ui.toast(`Renamed to "${v.trim()}"`)
                }}
              />
              <Button key={`mygroups-rename-cancel-${renaming.id}`} plain dimColor label="✕ Cancel" onPress={closeOpen} />
            </Box>
          )}
          {ordered.length > 0 && titleGap('gap-mygroups')}
          {ordered.length === 0 ? (
            <Text dimColor>{`  none yet: click ${MENU_ICON} before a chat and pick ＋ New group…`}</Text>
          ) : (
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
              {ordered.map(groupButton)}
            </Box>
          )}
        </Box>
        <Box flexDirection="column">
          <Text bold>Recent chats</Text>
          {titleGap('gap-recent')}
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {fixedTabs.map(tabButton)}
          </Box>
        </Box>
        {ranked.length > 0 && (
          <Box flexDirection="column" alignItems="flex-start">
            {/* The gear after the heading: tick the projects to show. One pick flips one project.
                Same choice as ChatsBar's "Projects…". */}
            <Box flexDirection="row" columnGap={1} alignItems="center" width="100%">
              <Text bold>Cowork Projects</Text>
              {gear('projects|menu|all', 'projmenu-btn')}
              {/* The Projects pop-up: one click flips one project; it stays open for the next one.
                  Same choice as ChatsBar's "Projects…". */}
              {openKey === 'projects|menu|all' &&
                popup('projbox', false, [
                  heading('pp-h', 'Projects to show (✓ = shown)'),
                  ...ranked.map(p => item(`pick-${p}`, !isHidden(p), isRtl(p) ? rtl(p) : p, () => setShown($, p, isHidden(p)))),
                  item('projbox-close', false, '✕ Close', closeOpen, true),
                ])}
            </Box>
            {titleGap('gap-projects')}
            {projects.map(p =>
              isRtl(p) ? (
                <Box key={`proj-${p}`} flexDirection="row" alignSelf="flex-end">
                  {tabButton(p)}
                </Box>
              ) : (
                tabButton(p)
              ),
            )}
          </Box>
        )}
        <Box flexDirection="column">
          {selectedGroup === undefined ? (
            // A project's list: "<name> | Cowork".
            <Text bold>{`${isRtl(selected) ? rtl(selected) : selected}${fixedTabs.includes(selected) ? '' : ' | Cowork'}`}</Text>
          ) : (
            // A picked group: its name, then its gear (rename, delete).
            <Box flexDirection="row" columnGap={1} alignItems="center">
              <Text bold>{`Group: ${isRtl(selectedGroup.name) ? rtl(selectedGroup.name) : selectedGroup.name}`}</Text>
              {gear(`gmenu|group|${selectedGroup.id}`, `gmenu-btn-${selectedGroup.id}`)}
              {/* The group's pop-up. Rename opens the name field below in its place. */}
              {openKey === `gmenu|group|${selectedGroup.id}` &&
                popup(`gmenubox-${selectedGroup.id}`, false, step === `confirm|${selectedGroup.id}` ? confirmBody(selectedGroup, `gmc-${selectedGroup.id}`, true) : [
                  item(`grename-${selectedGroup.id}`, false, '✎ Rename…', () => groupAct(selectedGroup, 'rename')),
                  item(`gdelete-${selectedGroup.id}`, false, '🗑 Delete group (its chats stay)', () => groupAct(selectedGroup, 'delete')),
                  item(`gmenu-close-${selectedGroup.id}`, false, '✕ Close', closeOpen, true),
                ])}
            </Box>
          )}
          {selectedGroup !== undefined && openKey === `rename|group|${selectedGroup.id}` && (
            <Box flexDirection="column" marginLeft={4}>
              <Input
                key={`rename-${selectedGroup.id}`}
                label="Name: "
                value={selectedGroup.name}
                submitLabel="rename"
                autoFocus
                onSubmit={async v => {
                  if (v.trim() === '') return
                  await changeGroups($, gs => gs.map(g => (g.id === selectedGroup.id ? { ...g, name: v.trim() } : g)))
                  await closeOpen()
                }}
              />
              <Button key={`rename-cancel-${selectedGroup.id}`} plain dimColor label="✕ Cancel" onPress={closeOpen} />
            </Box>
          )}
          {shown.length === 0 ? (
            <Text dimColor>
              {selectedGroup !== undefined
                ? `  no chats in this group yet: click ${MENU_ICON} before a chat and pick this group`
                : "  no recent chats in the app's saved copy"}
            </Text>
          ) : (
            shown.map((c, i) => row(c, selected === 'Recent' || selectedGroup !== undefined, 'list', cardRows(c) > shown.length - 1 - i + ROWS_UNDER_LIST))
          )}
          {projectLinks[selected] !== undefined && (
            <Button
              key={`open-project-${selected}`}
              plain
              onPress={() => openLink($, projectLinks[selected] ?? '', 'Could not open the project')}
            >
              <Text dimColor>{'  ↗ Open the project page for all its chats'}</Text>
            </Button>
          )}
        </Box>
        {/* Reads the files again now, and tells ChatsBar and other open panels to do the same.
            It cannot be newer than the app's saved copy: for a stale copy, restart the Claude app. */}
        <Button
          key="refresh"
          plain
          onPress={async () => {
            await sendSignal($).catch(() => undefined) // ChatsBar and other chats' panels follow
            restartCycle($)
            await refresh($)
            $.ui.toast('Chats refreshed')
          }}
        >
          <Text dimColor>↻ Refresh</Text>
        </Button>
        {/* Legend: what the dots, colors and gears mean. */}
        <Box flexDirection="column">
          <Text dimColor>
            <Text color="success">⦁</Text>
            {' working   ⦁ idle, time since last use'}
          </Text>
          <Text dimColor>
            <Text color="warning">orange</Text>
            {' = Important   '}
            <Text bold>bold</Text>
            {' = Bold   click a line to open it'}
          </Text>
          <Text dimColor>{`${MENU_ICON} next to a chat: move it to a group, or mark it Bold or Important`}</Text>
          <Text dimColor>{`${MENU_ICON} next to My groups: rename or delete a group`}</Text>
          <Text dimColor>{`${MENU_ICON} next to Cowork Projects: choose which projects show`}</Text>
        </Box>
        {/* How old the Cowork data is: last, under the legend. */}
        <Text dimColor>
          {cacheAt > 0
            ? `Cowork data: the app's saved copy, ${ago(now - cacheAt)} old.`
            : 'Cowork projects not readable now; showing Cowork chats on this Mac only.'}
        </Text>
        {/* The version of the code that draws this panel (see modVersion). */}
        {version !== '' && <Text dimColor>{`/${COMMAND} v${version}`}</Text>}
      </Box>
    )
  })

  // Esc while a card is open (setEsc): close the card, keep the panel. A close with no card open
  // (the ✕ of the panel) goes on as before. Esc reaches the panel only as a close of the whole
  // pane, so Esc closes a whole card, not one step inside it.
  on('ui.close', async ($, e, next) => {
    try {
      if (e.id === PANE && e.origin.kind === 'person' && ((await read($, moving)) !== '' || (await read($, cardStep)) !== '')) {
        await update($, cardStep, () => '')
        await update($, moving, () => '')
        await setEsc($, false)
        return { value: undefined } // answered without next: the panel stays open
      }
    } catch {
      // a failed read must never keep the panel from closing
    }
    return next(e)
  })

  on('ui.message', async ($, e, next) => {
    const d = (typeof e.data === 'object' && e.data !== null ? e.data : {}) as { open?: unknown; type?: unknown }
    if (typeof d.open === 'string') {
      const link = d.open
      const c = (await read($, view)).chats.find(x => x.link === link)
      const at = await $.clock.now()
      if (c !== undefined && !(lastOpen.link === link && at - lastOpen.at < 1500)) {
        lastOpen = { link, at }
        await openChat($, c)
      }
    }
    return next(e)
  })

  // A chat line's Client that the app could not load, draw or run. The app shows only the start
  // of the reason in the panel; only the phase goes to the debug log
  // (claude --debug), never the reason text. Nothing is written to a file.
  on('ui.fault', async ($, e, next) => {
    $.ui.log(`chats-panel fault: ${String(e.phase).slice(0, 40)}`, { to: 'debug' })
    return next(e)
  })

  on('session.end', ($, e, next) => {
    timer?.cancel()
    timer = undefined
    signalTimer?.cancel()
    signalTimer = undefined
    return next(e)
  })
}
