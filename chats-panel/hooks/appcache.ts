import type { EngineInterface } from 'claude-code'

import type { ChatRow } from '../types'

// Reads the Claude app's own saved copy of its sidebar data (the "recents"
// cache it keeps in IndexedDB on this Mac). That copy holds Cowork chats with
// their titles, projects, times and running state, which no API gives a mod.
//
// The format is the app's private one: a Snappy-compressed V8-serialized
// object. It is not documented and an app update can change it. Every step
// here fails soft: on any surprise the caller falls back to other sources.

export type AppCache = {
  chats: ChatRow[]
  projects: string[]
  /** Project name to the claude:// link of its page in the app */
  projectLinks: Record<string, string>
  savedAt: number
}

// ---------- bytes ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]))

function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      ((B64_INDEX.get(clean[i] ?? 'A') ?? 0) << 18) |
      ((B64_INDEX.get(clean[i + 1] ?? 'A') ?? 0) << 12) |
      ((B64_INDEX.get(clean[i + 2] ?? 'A') ?? 0) << 6) |
      (B64_INDEX.get(clean[i + 3] ?? 'A') ?? 0)
    if (o < out.length) out[o++] = (n >> 16) & 255
    if (o < out.length) out[o++] = (n >> 8) & 255
    if (o < out.length) out[o++] = n & 255
  }
  return out
}

const SNAPPY_MAX = 64 * 1024 * 1024 // a declared length above this is refused

// With limit, stops after that many output bytes (to look at the first keys only).
function unsnappy(b: Uint8Array, start: number, limit = Infinity): Uint8Array {
  let i = start
  let len = 0
  for (let shift = 0; ; shift += 7) {
    if (shift > 63 || i >= b.length) throw new Error('bad snappy length')
    const c = b[i++] as number
    len += (c & 0x7f) * 2 ** shift
    if (c < 0x80) break
  }
  if (len > SNAPPY_MAX) throw new Error('snappy length too large')
  len = Math.min(len, limit)
  const out = new Uint8Array(len)
  let o = 0
  while (i < b.length && o < len) {
    const t = b[i++] ?? 0
    const kind = t & 3
    if (kind === 0) {
      let l = t >> 2
      if (l >= 60) {
        const nb = l - 59
        l = 0
        for (let k = 0; k < nb; k++) l += (b[i + k] ?? 0) * 256 ** k
        i += nb
      }
      l += 1
      out.set(b.subarray(i, i + Math.min(l, len - o)), o)
      o += l
      i += l
      continue
    }
    let l: number
    let off: number
    if (kind === 1) {
      l = ((t >> 2) & 7) + 4
      off = ((t >> 5) << 8) | (b[i++] ?? 0)
    } else if (kind === 2) {
      l = (t >> 2) + 1
      off = (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8)
      i += 2
    } else {
      l = (t >> 2) + 1
      off = ((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16)) + (b[i + 3] ?? 0) * 2 ** 24
      i += 4
    }
    if (off <= 0 || off > o) throw new Error('bad snappy offset')
    for (let k = 0; k < l && o < len; k++, o++) out[o] = out[o - off] ?? 0
  }
  return out
}

function utf8(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; ) {
    const c = b[i++] ?? 0
    let cp = c
    if (c >= 0xf0) cp = ((c & 7) << 18) | (((b[i++] ?? 0) & 63) << 12) | (((b[i++] ?? 0) & 63) << 6) | ((b[i++] ?? 0) & 63)
    else if (c >= 0xe0) cp = ((c & 15) << 12) | (((b[i++] ?? 0) & 63) << 6) | ((b[i++] ?? 0) & 63)
    else if (c >= 0xc0) cp = ((c & 31) << 6) | ((b[i++] ?? 0) & 63)
    s += String.fromCodePoint(cp)
  }
  return s
}

// ---------- V8 serialized values (the subset the cache uses) ----------

class V8Reader {
  private i = 0
  private readonly refs: unknown[] = []
  private readonly view: DataView
  constructor(private readonly b: Uint8Array) {
    this.view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  }
  private varint(): number {
    let r = 0
    for (let shift = 0; ; shift += 7) {
      if (shift > 63 || this.i >= this.b.length) throw new Error('bad varint')
      const c = this.b[this.i++] as number
      r += (c & 0x7f) * 2 ** shift
      if (c < 0x80) return r
    }
  }
  private peek() {
    return this.b[this.i] ?? 0
  }
  /** The bytes of a length-prefixed value: throws when fewer are left. */
  private need(n: number): void {
    if (n > this.b.length - this.i) throw new Error('length past end of data')
  }
  value(): unknown {
    let t: number
    for (;;) {
      if (this.i >= this.b.length) throw new Error('end of data')
      t = this.b[this.i++] as number
      if (t === 0x00) continue // padding
      if (t === 0xff) { this.varint(); continue } // version
      if (t === 0xfe) { this.i += 12; continue } // trailer offset + size
      break
    }
    switch (String.fromCharCode(t)) {
      case '"': {
        const n = this.varint()
        this.need(n)
        let s = ''
        for (let k = 0; k < n; k += 8192) s += String.fromCharCode(...this.b.subarray(this.i + k, this.i + Math.min(n, k + 8192)))
        this.i += n
        return s
      }
      case 'c': {
        const n = this.varint()
        this.need(n)
        let s = ''
        for (let k = 0; k + 1 < n; k += 2) s += String.fromCharCode(this.view.getUint16(this.i + k, true))
        this.i += n
        return s
      }
      case 'S': {
        const n = this.varint()
        this.need(n)
        const s = utf8(this.b.subarray(this.i, this.i + n))
        this.i += n
        return s
      }
      case 'T': return true
      case 'F': return false
      case '_': return undefined
      case '0': return null
      case 'I': { const z = this.varint(); return z % 2 ? -(z + 1) / 2 : z / 2 }
      case 'U': return this.varint()
      case 'N':
      case 'D': { this.need(8); const v = this.view.getFloat64(this.i, true); this.i += 8; return v }
      case '^': return this.refs[this.varint()]
      case 'o': {
        const o: Record<string, unknown> = {}
        this.refs.push(o)
        while (this.peek() !== 0x7b /* { */) {
          const k = this.value()
          o[String(k)] = this.value()
        }
        this.i++
        this.varint()
        return o
      }
      case 'A': {
        const n = this.varint()
        this.need(n) // every element takes at least one byte
        const a: unknown[] = []
        this.refs.push(a)
        for (let k = 0; k < n; k++) a.push(this.value())
        while (this.peek() !== 0x24 /* $ */) { this.value(); this.value() }
        this.i++
        this.varint()
        this.varint()
        return a
      }
      case 'a': {
        const n = this.varint()
        this.need(n)
        const a: unknown[] = new Array(n)
        this.refs.push(a)
        while (this.peek() !== 0x40 /* @ */) {
          const k = this.value()
          const v = this.value()
          if (typeof k === 'number' && k < n) a[k] = v
        }
        this.i++
        this.varint()
        this.varint()
        return a
      }
      default:
        throw new Error(`unknown V8 tag ${t} at ${this.i - 1}`)
    }
  }
}

// ---------- finding and reading the app's files ----------
//
// Two stores, both IndexedDB of the claude.ai page in the app:
//   1. The sidebar copy (react-query cache): one object {timestamp, buster, clientState: {queries}}.
//      Older app versions saved it about every 20 s. Newer ones save it only when the window
//      loads, and with fewer lists in it (no project list, no Cowork session lists, no
//      transcripts). That is why store 2 and the VM log below are read too.
//   2. The per-chat store ("conversations_v2"): one record per chat or project page,
//      {conversationUuid, product, tree, writtenAt}. product "chat_project": the chat list of a
//      project page you opened. product "hub": a chat's transcript. Written each time.
// Small values sit inside the leveldb files (.log, .ldb), big ones in blob files.
// Same logic as ../chatsbar/chats.py: keep the two in step.

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const str = (x: unknown) => (typeof x === 'string' ? x : undefined)
const num = (x: unknown) => (typeof x === 'number' ? x : undefined)
const iso = (x: unknown) => (typeof x === 'string' ? Date.parse(x) || 0 : 0)

const isSnappy = (b: Uint8Array) => b[0] === 0xff && b[1] === 0x11 && b[2] === 0x02 // compressed value
const isBlobRef = (b: Uint8Array) => b[0] === 0xff && b[1] === 0x11 && b[2] === 0x01 // value in a blob file
const USED_QUERIES = [
  '["project_list"',
  '["chat_conversation_list"',
  '["cowork-remote-sessions"',
  '["cowork-local-sessions"',
  '["hub_transcript"',
]
const CHAT_QUERIES = USED_QUERIES.slice(1, 4)
const RECORD_MAX_AGE_MS = 2 * 86400 * 1000 // blob files older than this are not read for per-chat records
const MAX_READ = 4 * 1024 * 1024 // $.fs.read's limit
const MEM_KEY = 'coworkProjectMemory'
const LIST_FRESH_MS = 10 * 60 * 1000 // a Cowork running flag from a saved list older than this is not used
const VM_TAIL = 2 * 1024 * 1024 // read only the end of the VM log (it is about 8 MB)
const VM_RUNNING_WINDOW_MS = 5 * 60 * 1000 // a task with a VM tool step newer than this is running
const VM_RECENT_MS = 2 * 86400 * 1000 // steps older than this are not used at all

type FileInfo = { path: string; mtimeMs: number; size: number }
type Memory = { names: Record<string, string>; starred: string[] }

function latin1(b: Uint8Array): string {
  let s = ''
  for (let k = 0; k < b.length; k += 8192) s += String.fromCharCode(...b.subarray(k, k + 8192))
  return s
}

function decode(bytes: Uint8Array): unknown {
  return new V8Reader(isSnappy(bytes) ? unsnappy(bytes, 3) : bytes).value()
}

/** The first bytes of a value, decompressed: enough to see its first keys. */
function head(b: Uint8Array, n = 200): string {
  try {
    return latin1(isSnappy(b) ? unsnappy(b, 3, n) : b.subarray(0, n))
  } catch {
    return ''
  }
}

async function readBytes($: EngineInterface, path: string): Promise<Uint8Array | undefined> {
  try {
    const { base64 } = await $.fs.read(path, { as: 'bytes' })
    return fromBase64(base64)
  } catch {
    return undefined
  }
}

// Every blob file, newest first. Do not read only the top <2 hex> folder: a save can sit in
// any folder, and other databases (for example an MCP result cache) save newer files that
// are not the sidebar copy. Each file is checked by its content.
async function blobFiles($: EngineInterface, root: string): Promise<FileInfo[]> {
  const found: FileInfo[] = []
  if (!(await $.fs.exists(root))) return found
  for (const db of await $.fs.list(root)) {
    if (db.kind !== 'dir') continue
    for (const sub of await $.fs.list(`${root}/${db.name}`)) {
      if (sub.kind !== 'dir') continue
      for (const f of await $.fs.list(`${root}/${db.name}/${sub.name}`)) {
        if (f.kind === 'file') found.push({ path: `${root}/${db.name}/${sub.name}/${f.name}`, mtimeMs: f.mtimeMs, size: f.size })
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

// ---------- leveldb (the files that hold the small IndexedDB values) ----------

type Put = (key: string, seq: number, value: Uint8Array | undefined) => void

function uvarint(b: Uint8Array, i: number): [number, number] {
  let r = 0
  for (let shift = 0; ; shift += 7) {
    const c = b[i++]
    if (c === undefined || shift > 63) throw new Error('short varint')
    r += (c & 0x7f) * 2 ** shift
    if (c < 0x80) return [r, i]
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Entries of a leveldb .log file; a delete has no value. */
function logEntries(d: Uint8Array, put: Put) {
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength)
  const BLOCK = 32768
  const recs: Uint8Array[] = []
  let parts: Uint8Array[] = []
  let i = 0
  while (i + 7 <= d.length) {
    const left = BLOCK - (i % BLOCK)
    if (left < 7) {
      i += left
      continue
    }
    const len = view.getUint16(i + 4, true)
    const type = d[i + 6]
    i += 7
    const frag = d.subarray(i, i + len)
    i += len
    if (type === 1) recs.push(frag)
    else if (type === 2) parts = [frag]
    else if (type === 3) parts.push(frag)
    else if (type === 4) {
      parts.push(frag)
      recs.push(concat(parts))
      parts = []
    } else i += (BLOCK - (i % BLOCK)) % BLOCK // zero fill: the rest of the block is empty
  }
  for (const r of recs) {
    try {
      const rv = new DataView(r.buffer, r.byteOffset, r.byteLength)
      const seq = rv.getUint32(0, true) + rv.getUint32(4, true) * 2 ** 32
      const count = rv.getUint32(8, true)
      let j = 12
      for (let k = 0; k < count; k++) {
        const tag = r[j++]
        let kl: number
        ;[kl, j] = uvarint(r, j)
        const key = latin1(r.subarray(j, j + kl))
        j += kl
        if (tag === 1) {
          let vl: number
          ;[vl, j] = uvarint(r, j)
          put(key, seq + k, r.subarray(j, j + vl))
          j += vl
        } else put(key, seq + k, undefined)
      }
    } catch {
      // a record the app is writing now
    }
  }
}

function blockEntries(blk: Uint8Array, out: (key: Uint8Array, value: Uint8Array) => void) {
  const view = new DataView(blk.buffer, blk.byteOffset, blk.byteLength)
  const end = blk.length - 4 - 4 * view.getUint32(blk.length - 4, true)
  let key = new Uint8Array(0)
  let i = 0
  while (i < end) {
    let shared: number, own: number, vl: number
    ;[shared, i] = uvarint(blk, i)
    ;[own, i] = uvarint(blk, i)
    ;[vl, i] = uvarint(blk, i)
    if (shared > key.length || own > blk.length - i) throw new Error('bad leveldb block entry')
    const k = new Uint8Array(shared + own)
    k.set(key.subarray(0, shared))
    k.set(blk.subarray(i, i + own), shared)
    key = k
    i += own
    if (vl > blk.length - i) throw new Error('bad leveldb block entry')
    out(key, blk.subarray(i, i + vl))
    i += vl
  }
}

/** Entries of a leveldb .ldb table file; a delete has no value. */
function tableEntries(d: Uint8Array, put: Put) {
  const block = (off: number, size: number) => {
    const raw = d.subarray(off, off + size)
    return d[off + size] === 1 ? unsnappy(raw, 0) : raw
  }
  const footer = d.subarray(d.length - 48)
  let i = uvarint(footer, 0)[1]
  i = uvarint(footer, i)[1] // the meta index: not needed
  const [io, j] = uvarint(footer, i)
  const [isz] = uvarint(footer, j)
  blockEntries(block(io, isz), (_, handle) => {
    const [bo, k] = uvarint(handle, 0)
    const [bs] = uvarint(handle, k)
    blockEntries(block(bo, bs), (key, value) => {
      const kv = new DataView(key.buffer, key.byteOffset, key.byteLength)
      const low = kv.getUint32(key.length - 8, true)
      const high = kv.getUint32(key.length - 4, true)
      put(latin1(key.subarray(0, key.length - 8)), (low >>> 8) + high * 2 ** 24, (low & 0xff) === 1 ? value : undefined)
    })
  })
}

/** The live value of each key in the app's IndexedDB leveldb (the newest write wins). */
async function leveldbValues($: EngineInterface, dir: string): Promise<Uint8Array[]> {
  const best = new Map<string, { seq: number; value: Uint8Array | undefined }>()
  if (!(await $.fs.exists(dir))) return []
  const put: Put = (key, seq, value) => {
    const old = best.get(key)
    if (!old || seq > old.seq) best.set(key, { seq, value })
  }
  for (const f of await $.fs.list(dir)) {
    if (f.kind !== 'file' || !/\.(ldb|log)$/.test(f.name) || f.size > MAX_READ) continue
    const d = await readBytes($, `${dir}/${f.name}`)
    if (!d) continue
    try {
      if (f.name.endsWith('.ldb')) tableEntries(d, put)
      else logEntries(d, put)
    } catch {
      // a file the app is writing now; the next read gets it
    }
  }
  return [...best.values()].flatMap(e => (e.value ? [e.value] : []))
}

/** A value as Chrome's IndexedDB keeps it: a version number, then the V8 bytes. */
function idbValue(v: Uint8Array): Uint8Array | undefined {
  try {
    return v.subarray(uvarint(v, 0)[1])
  } catch {
    return undefined
  }
}

// Blob files already read: the per-chat record in each, or none.
const recordMemo = new Map<string, { mtimeMs: number; rec: Obj | undefined }>()

function asRecord(b: Uint8Array): Obj | undefined {
  if (!head(b, 64).includes('conversationUuid')) return undefined
  try {
    const r = decode(b)
    return isObj(r) && isObj(r.tree) && str(r.conversationUuid) ? r : undefined
  } catch {
    return undefined
  }
}

/** The per-chat store: conversationUuid to record; the newest writtenAt wins. */
async function chatRecords($: EngineInterface, appDir: string, blobs: FileInfo[]): Promise<Map<string, Obj>> {
  const recs = new Map<string, Obj>()
  const add = (r: Obj | undefined) => {
    const u = r ? str(r.conversationUuid) : undefined
    if (r && u && (num(r.writtenAt) ?? 0) >= (num(recs.get(u)?.writtenAt) ?? 0)) recs.set(u, r)
  }
  for (const v of await leveldbValues($, `${appDir}/IndexedDB/https_claude.ai_0.indexeddb.leveldb`)) {
    const b = idbValue(v)
    if (b && b.length > 200 && b[0] === 0xff && !isBlobRef(b)) add(asRecord(b))
  }
  const now = nowMs()
  for (const f of blobs) {
    if (now - f.mtimeMs > RECORD_MAX_AGE_MS) break // newest first, so the rest are older too
    const memo = recordMemo.get(f.path)
    if (memo && memo.mtimeMs === f.mtimeMs) {
      add(memo.rec)
      continue
    }
    const b = f.size <= MAX_READ ? await readBytes($, f.path) : undefined
    const rec = b ? asRecord(b) : undefined
    recordMemo.set(f.path, { mtimeMs: f.mtimeMs, rec })
    add(rec)
  }
  return recs
}

// ---------- turning the saved lists into chat rows ----------

const AGENT_TOOLS = new Set(['Task', 'Agent'])
const AGENT_MAX_AGE_MS = 6 * 3600 * 1000 // an agent step older than this counts as stopped

/** True if the newest assistant message of a saved transcript has an agent step with no result. */
function agentsRunning(d: unknown): boolean {
  // Any assistant message counts, not only the newest: messages can be sent while an agent
  // runs, and the open step then sits in an older message.
  const msgs = isObj(d) && Array.isArray(d.messages) ? d.messages : undefined
  if (!msgs || !msgs.length) return false
  const done = new Set<string>()
  for (const m of msgs) {
    if (!isObj(m) || !Array.isArray(m.content)) continue
    for (const c of m.content) if (isObj(c) && c.type === 'tool_result') done.add(str(c.tool_use_id) ?? '')
  }
  const now = nowMs()
  return msgs.some(
    m =>
      isObj(m) &&
      m.sender === 'assistant' &&
      now - iso(m.created_at) <= AGENT_MAX_AGE_MS &&
      Array.isArray(m.content) &&
      m.content.some(
        c =>
          isObj(c) &&
          c.type === 'tool_use' &&
          AGENT_TOOLS.has(str(c.name) ?? '') &&
          !c._isSubagentBlock &&
          !done.has(str(c.id) ?? ''),
      ),
  )
}

/** The chat rows of a list query: plain list, {data: [...]}, or {pages: [...]}. */
function pageRows(d: unknown): Obj[] {
  const pages = isObj(d) && Array.isArray(d.pages) ? d.pages : [d]
  const rows: Obj[] = []
  for (const page of pages) {
    const list = isObj(page) ? page.data : page
    if (Array.isArray(list)) rows.push(...list.filter(isObj))
  }
  return rows
}

type Extracted = Omit<AppCache, 'savedAt'> & { mem: Memory }

// mem: project names and stars seen before. The app's newer copy has no project list, so names
// seen once are kept.
export function extract(queries: Obj[], recs: Map<string, Obj>, mem: Memory | undefined): Extracted | undefined {
  const hashOf = (q: Obj) => str(q.queryHash) ?? ''
  const dataOf = (q: Obj) => (isObj(q.state) ? q.state.data : undefined)
  const updatedOf = (q: Obj) => (isObj(q.state) ? (num(q.state.dataUpdatedAt) ?? 0) : 0)
  // Oldest fetch first, so newer lists are applied last.
  const qs = [...queries].sort((a, b) => updatedOf(a) - updatedOf(b))

  let projectNames = new Map<string, string>()
  let projectStarred = new Set<string>()
  for (const q of qs) {
    if (!hashOf(q).startsWith('["project_list"')) continue
    const list = dataOf(q)
    if (!Array.isArray(list)) continue
    for (const p of list.filter(isObj)) {
      const id = str(p.uuid)
      const name = str(p.name)
      if (!id || !name || p.archived_at) continue
      projectNames.set(id, name.trim())
      if (p.is_starred === true) projectStarred.add(name.trim())
    }
  }
  if (projectNames.size === 0 && mem) {
    // No project list in this copy: use the names seen before.
    projectNames = new Map(Object.entries(isObj(mem.names) ? mem.names : {}).filter(([, n]) => typeof n === 'string'))
    projectStarred = new Set(Array.isArray(mem.starred) ? mem.starred.filter(s => typeof s === 'string') : [])
  }

  const byId = new Map<string, ChatRow>()
  // When the app fetched the list a row came from. One chat can sit in several
  // lists, some minutes older; the newest list decides whether it is working.
  const fetchedAt = new Map<string, number>()
  let currentFetchedAt = 0
  const put = (input: ChatRow) => {
    // A running flag from a list fetched long ago is stale: the app's copy can be hours old,
    // and the flag stays until the next save.
    const row = input.isWorking && nowMs() - currentFetchedAt > LIST_FRESH_MS ? { ...input, isWorking: false } : input
    const old = byId.get(row.id)
    const oldAt = fetchedAt.get(row.id) ?? -1
    const isNewer = currentFetchedAt >= oldAt
    if (isNewer) fetchedAt.set(row.id, currentFetchedAt)
    if (!old) return void byId.set(row.id, row)
    byId.set(row.id, {
      ...old,
      title: old.title || row.title,
      project: old.project ?? row.project,
      lastActivityAt: Math.max(old.lastActivityAt, row.lastActivityAt),
      isWorking: isNewer ? row.isWorking : old.isWorking,
      settledAt: Math.max(old.settledAt ?? 0, row.settledAt ?? 0),
      ...(old.isScheduled === true || row.isScheduled === true ? { isScheduled: true } : {}),
    })
  }

  // A Cowork chat is running while the app sets its `live_status` (seen as
  // "running"); the app clears it when the task ends. `last_settled_at` is NOT used to say a
  // task is working: it stays stale after a task ends, which gives a false "working". It is
  // used the other way, to end a task early (see applyVmSteps).
  const isRunningConversation = (c: Obj) => {
    const live = str(c.live_status)
    return live !== undefined && live !== 'idle' && live !== 'completed'
  }

  const chatIds = new Map<string, string>() // chat uuid -> row id, for agentsRunning below
  // One Cowork task can come in two forms. The sidebar list can hold a short form with no
  // workspace_session_id (it looks like a plain chat, keyed by its uuid). A project page holds
  // the full form (keyed by the task id). The task id, once seen, is kept for the uuid, and a
  // plain-chat row made before is merged into the task's row. So each chat shows once.
  // Same in chats.py.
  const taskOf = new Map<string, string>() // chat uuid -> Cowork task id
  const fromConversation = (c: Obj) => {
    if (c.is_archived === true || c.is_temporary === true) return
    const uuid = str(c.uuid)
    if (!uuid) return
    const ws = str(c.workspace_session_id) ?? taskOf.get(uuid)
    const pu = str(c.project_uuid)
    if (ws !== undefined && ws !== uuid) {
      taskOf.set(uuid, ws)
      const early = byId.get(uuid)
      if (early !== undefined) {
        byId.delete(uuid)
        const at = fetchedAt.get(uuid) ?? -1
        fetchedAt.delete(uuid)
        const keep = currentFetchedAt
        currentFetchedAt = at
        put({ ...early, id: ws, kind: 'cowork', link: `claude://claude.ai/cowork/${ws}` })
        currentFetchedAt = keep
      }
    }
    chatIds.set(uuid, ws ?? uuid)
    const pid = isObj(c.project) ? str(c.project.uuid) : undefined
    const pname = isObj(c.project) ? str(c.project.name)?.trim() : undefined
    if (pid && pname) projectNames.set(pid, pname) // learn it for later copies
    const proj = pname ?? (pu ? projectNames.get(pu) : undefined)
    put({
      id: ws ?? uuid,
      kind: ws ? 'cowork' : 'chat',
      title: str(c.name) || 'Untitled',
      lastActivityAt: iso(c.updated_at),
      isWorking: isRunningConversation(c),
      settledAt: iso(c.last_settled_at), // when its last turn ended
      project: proj,
      link: ws ? `claude://claude.ai/cowork/${ws}` : `claude://claude.ai/chat/${uuid}`,
    })
  }

  const fromSession = (s: Obj) => {
    const id = str(s.sessionId)
    if (!id || s.isArchived === true) return
    const pu = Array.isArray(s.userSelectedProjectUuids) ? str(s.userSelectedProjectUuids[0]) : undefined
    const live = str(s.liveStatus)
    put({
      id,
      kind: 'cowork',
      title: str(s.title) || 'Untitled',
      lastActivityAt: num(s.lastActivityAt) ?? 0,
      isWorking: s.isRunning === true || (live !== undefined && live !== 'idle'),
      project: pu ? projectNames.get(pu) : undefined,
      link: `claude://claude.ai/cowork/${id}`,
      // A scheduled-task run: no project in the app itself; its line says "| Scheduled".
      ...(str(s.scheduledTaskId) ? { isScheduled: true } : {}),
    })
  }

  for (const q of qs) {
    const h = hashOf(q)
    const d = dataOf(q)
    currentFetchedAt = updatedOf(q)
    if (h.startsWith('["chat_conversation_list"')) {
      pageRows(d).forEach(fromConversation)
    } else if (h.startsWith('["cowork-remote-sessions"') && Array.isArray(d)) {
      d.filter(isObj).forEach(fromSession)
    } else if (h.startsWith('["cowork-local-sessions"') && isObj(d) && Array.isArray(d.rows)) {
      d.rows.filter(isObj).forEach(fromSession)
    }
  }

  // Project pages you opened: newer chat lists, one per project. A project whose
  // name is not known is skipped, so its chats do not show as "No project".
  const records = [...recs.values()].sort((a, b) => (num(a.writtenAt) ?? 0) - (num(b.writtenAt) ?? 0))
  for (const r of records) {
    if (r.product !== 'chat_project' || !isObj(r.tree) || !Array.isArray(r.tree.reads)) continue
    for (const read of r.tree.reads.filter(isObj)) {
      const key = read.queryKey
      const arg = Array.isArray(key) ? key[1] : undefined
      const pu = isObj(arg) ? str(arg.projectUuid) : undefined
      if (!Array.isArray(key) || key[0] !== 'project_list_conversations' || !pu || !projectNames.has(pu)) continue
      currentFetchedAt = num(read.readAt) ?? num(r.writtenAt) ?? 0
      pageRows(read.data).forEach(fromConversation)
    }
  }

  // A task whose turn ended while its agents still run in the background has no
  // live_status. Its saved transcript (kept only for chats opened recently) still
  // shows the agent steps with no result yet. Older app versions kept the transcript as a
  // hub_transcript query in the sidebar copy; newer ones as a "hub" record.
  const transcripts: Array<[string | undefined, unknown]> = []
  for (const q of qs) {
    const h = hashOf(q)
    if (!h.startsWith('["hub_transcript"')) continue
    try {
      const key = JSON.parse(h)
      transcripts.push([Array.isArray(key) && isObj(key[2]) ? str(key[2].uuid) : undefined, dataOf(q)])
    } catch {
      continue
    }
  }
  for (const r of records) if (r.product === 'hub') transcripts.push([str(r.conversationUuid), r.tree])
  for (const [uuid, d] of transcripts) {
    const id = uuid ? chatIds.get(uuid) : undefined
    const row = id ? byId.get(id) : undefined
    // Its turn ended but agents run: settledAt must not end it (hasAgents).
    if (id && row && agentsRunning(d)) byId.set(id, { ...row, isWorking: true, hasAgents: true })
  }

  if (byId.size === 0) return undefined
  const chats = [...byId.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  // Projects: every project known, with or without chats here.
  // Starred first, then by latest chat, then projects with no chats in the saved copy.
  const order: string[] = []
  for (const c of chats) if (c.project && !order.includes(c.project)) order.push(c.project)
  for (const name of projectNames.values()) if (!order.includes(name)) order.push(name)
  const projects = [...order.filter(p => projectStarred.has(p)), ...order.filter(p => !projectStarred.has(p))]
  const projectLinks: Record<string, string> = {}
  for (const [id, name] of projectNames) projectLinks[name] = `claude://claude.ai/project/${id}`
  return {
    chats,
    projects,
    projectLinks,
    mem: { names: Object.fromEntries(projectNames), starred: [...projectStarred].sort() },
  }
}

// ---------- the entry point ----------

// The sidebar copy last decoded (only the lists used), and blob files known not to be one.
let rootMemo: { path: string; mtimeMs: number; queries: Obj[] } | undefined
const notRoot = new Map<string, number>()

const hasChats = (qs: Obj[]) => qs.some(q => CHAT_QUERIES.some(p => (str(q.queryHash) ?? '').startsWith(p)))

// The time from the engine's clock, set at the start of each read. Inside the mod's own
// environment Date.now() can lag (a task kept showing as running for minutes after a plugin
// reload), so every age in this file is measured against this. Date.now() is the fallback only.
let clockNow = 0
const nowMs = () => clockNow || Date.now()

export async function readAppCache($: EngineInterface, appDir: string): Promise<AppCache | undefined> {
  clockNow = await $.clock.now().catch(() => Date.now())
  const blobs = await blobFiles($, `${appDir}/IndexedDB/https_claude.ai_0.indexeddb.blob`).catch(() => [] as FileInfo[])
  let queries: Obj[] = []
  let savedAt = 0
  for (const f of blobs) {
    if (rootMemo && rootMemo.path === f.path && rootMemo.mtimeMs === f.mtimeMs) {
      queries = rootMemo.queries
      savedAt = f.mtimeMs
      break
    }
    if (notRoot.get(f.path) === f.mtimeMs || f.size > MAX_READ) continue
    const b = await readBytes($, f.path)
    let qs: Obj[] | undefined
    if (b && head(b).includes('clientState')) {
      try {
        const r = decode(b)
        const all = isObj(r) && isObj(r.clientState) ? r.clientState.queries : undefined
        if (Array.isArray(all)) qs = all.filter(isObj).filter(q => USED_QUERIES.some(p => (str(q.queryHash) ?? '').startsWith(p)))
      } catch {
        // not a sidebar copy
      }
    }
    // A copy saved while the window loads can hold no chat list yet.
    if (!qs || !hasChats(qs)) {
      notRoot.set(f.path, f.mtimeMs)
      continue
    }
    rootMemo = { path: f.path, mtimeMs: f.mtimeMs, queries: qs }
    queries = qs
    savedAt = f.mtimeMs
    break
  }
  const recs = await chatRecords($, appDir, blobs).catch(() => new Map<string, Obj>())
  const mem = (await $.store.get(MEM_KEY).catch(() => undefined)) as Memory | undefined
  const result = extract(queries, recs, isObj(mem) ? mem : undefined)
  if (result && JSON.stringify(result.mem) !== JSON.stringify(mem)) await $.store.set(MEM_KEY, result.mem).catch(() => undefined)
  const chats = await applyVmSteps($, appDir, result ? result.chats : []).catch(() => result?.chats ?? [])
  if (chats.length === 0) return undefined
  // No sidebar copy: date the result by the newest per-chat record.
  if (!savedAt) for (const r of recs.values()) savedAt = Math.max(savedAt, num(r.writtenAt) ?? 0)
  return {
    chats: chats.sort((a, b) => b.lastActivityAt - a.lastActivityAt),
    projects: result?.projects ?? [],
    projectLinks: result?.projectLinks ?? {},
    savedAt,
  }
}

// ---------- Cowork: tool steps in the app's VM log ----------
//
// The app's newer saved copy has no running state and no task started after the window loaded.
// The VM log is written live: one line per tool step a Cowork task runs on this Mac, for example
//   <date> <time> [info] [vmOneShot] Running: bash [2 arg(s)] as rcw-<id>
// rcw-<id> is the task id (cse_<ID>) in lower case. Limits: thinking and connector steps write no
// line, so a task that only thinks for over 5 minutes shows as idle; a finished task shows as
// running for up to 5 minutes after its last step. Same rule as chats.py.

/** The last VM tool step of each Cowork task: lowercase id to time in ms. */
async function vmSteps($: EngineInterface, logDir: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const f = (await $.fs.list(logDir)).find(e => e.kind === 'file' && e.name === 'cowork_vm_node.log')
  if (!f) return out
  const offset = Math.max(0, f.size - VM_TAIL)
  const text = await $.fs.read(`${logDir}/${f.name}`, { as: 'text', offset, length: VM_TAIL })
  // The log's times are the Mac's local time, with no zone. The mod's environment may not
  // have the Mac's time zone (tasks showed as running hours too long), so the offset comes
  // from the file itself: its last line was written at its modified time.
  const stamp = (line: string) => {
    const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) /.exec(line)
    if (!m) return undefined
    const [, y, mo, d, h, mi, s] = m
    return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  }
  const lines = text.split('\n')
  let lastStamp: number | undefined
  for (let i = lines.length - 1; i >= 0 && lastStamp === undefined; i--) lastStamp = stamp(lines[i] ?? '')
  if (lastStamp === undefined) return out
  const QUARTER_HOUR = 15 * 60 * 1000 // time zones are whole quarter hours
  const zoneOffset = Math.round((lastStamp - f.mtimeMs) / QUARTER_HOUR) * QUARTER_HOUR
  for (const line of lines) {
    if (!line.includes('[vmOneShot] Running:')) continue
    const m = / as rcw-([0-9a-z]+)\s*$/.exec(line)
    const at = stamp(line)
    if (!m || at === undefined) continue
    const id = m[1]
    const ms = at - zoneOffset
    if (id && ms > (out.get(id) ?? 0)) out.set(id, ms)
  }
  return out
}

/** remote-session-spaces.json: lowercase id to the id in its own case and the folder names. */
async function sessionFolders($: EngineInterface, appDir: string): Promise<Map<string, { id: string; names: string[] }>> {
  const out = new Map<string, { id: string; names: string[] }>()
  const base = `${appDir}/local-agent-mode-sessions`
  if (!(await $.fs.exists(base))) return out
  for (const acct of await $.fs.list(base)) {
    if (acct.kind !== 'dir') continue
    for (const org of await $.fs.list(`${base}/${acct.name}`)) {
      if (org.kind !== 'dir') continue
      const path = `${base}/${acct.name}/${org.name}/remote-session-spaces.json`
      if (!(await $.fs.exists(path))) continue
      let entries: unknown
      try {
        const d: unknown = JSON.parse(await $.fs.read(path))
        entries = isObj(d) ? d.entries : undefined
      } catch {
        continue
      }
      if (!Array.isArray(entries)) continue
      for (const e of entries.filter(isObj)) {
        const sid = str(e.sessionId) ?? ''
        const cut = sid.indexOf('_')
        if (cut < 0) continue
        const id = sid.slice(cut + 1)
        const names = (Array.isArray(e.folders) ? e.folders : []).map(x => String(x).replace(/\/+$/, '').split('/').pop() ?? '')
        out.set(id.toLowerCase(), { id, names })
      }
    }
  }
  return out
}

// Deleted tasks. A deleted Cowork task keeps its VM steps in the log, so without this the reader
// made a row for it, and its link opened nothing. When the app deletes a task it writes to its
// main log:
//   <date> <time> [info] LocalAgentModeSessions.clearRemoteSessionFolderGrants: session_<id>
// The same line also comes in other cases, so a task counts as deleted only when the line is at
// or after its last VM step and its last activity.
// Such a task gets no row and no running state. Same rule as deleted_tasks in chats.py.
const MAIN_TAIL = 4 * 1024 * 1024 // the log was 2.5 MB for 2 days when checked

/** Lowercase id to the time in ms of the app's last folder-grant clear, from its main log. */
async function deletedTasks($: EngineInterface, logDir: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const f = (await $.fs.list(logDir)).find(e => e.kind === 'file' && e.name === 'main.log')
  if (!f) return out
  const offset = Math.max(0, f.size - MAIN_TAIL)
  const text = await $.fs.read(`${logDir}/${f.name}`, { as: 'text', offset, length: MAIN_TAIL })
  // Local times with no zone, as in the VM log: the zone comes from the file's modified time.
  const stamp = (line: string) => {
    const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) /.exec(line)
    if (!m) return undefined
    const [, y, mo, d, h, mi, s] = m
    return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  }
  const lines = text.split('\n')
  let lastStamp: number | undefined
  for (let i = lines.length - 1; i >= 0 && lastStamp === undefined; i--) lastStamp = stamp(lines[i] ?? '')
  if (lastStamp === undefined) return out
  const QUARTER_HOUR = 15 * 60 * 1000
  const zoneOffset = Math.round((lastStamp - f.mtimeMs) / QUARTER_HOUR) * QUARTER_HOUR
  for (const line of lines) {
    const m = /clearRemoteSessionFolderGrants: session_([0-9A-Za-z]+)/.exec(line)
    const at = stamp(line)
    if (!m?.[1] || at === undefined) continue
    const id = m[1].toLowerCase()
    out.set(id, Math.max(out.get(id) ?? 0, at - zoneOffset))
  }
  return out
}

// Marks Cowork tasks with a recent VM step as running. A task missing from the app's saved
// copy gets its own row, titled with its folders (the title is not on this Mac).
// Tasks the app deleted are dropped.
async function applyVmSteps($: EngineInterface, appDir: string, rows: ChatRow[]): Promise<ChatRow[]> {
  const logDir = appDir.replace(/Application Support\/Claude\/?$/, 'Logs/Claude')
  const steps = await vmSteps($, logDir)
  if (steps.size === 0) return rows
  const cleared = await deletedTasks($, logDir).catch(() => new Map<string, number>())
  const deleted = new Set([...cleared].filter(([sid, ms]) => ms >= (steps.get(sid) ?? 0)).map(([sid]) => sid))
  const now = nowMs()
  const out = rows.filter(r => {
    const cut = r.id.indexOf('_')
    if (r.kind !== 'cowork' || cut < 0) return true
    const sid = r.id.slice(cut + 1).toLowerCase()
    return !(deleted.has(sid) && (cleared.get(sid) ?? 0) >= r.lastActivityAt)
  })
  const index = new Map<string, number>()
  out.forEach((r, i) => {
    const cut = r.id.indexOf('_')
    if (r.kind === 'cowork' && cut >= 0) index.set(r.id.slice(cut + 1).toLowerCase(), i)
  })
  let folders: Map<string, { id: string; names: string[] }> | undefined
  for (const [sid, ms] of steps) {
    if (now - ms > VM_RECENT_MS || deleted.has(sid)) continue
    let i = index.get(sid)
    if (i === undefined) {
      folders ??= await sessionFolders($, appDir).catch(() => new Map<string, { id: string; names: string[] }>())
      const f = folders.get(sid)
      if (!f) continue // its id in the right case is not known, so no link can open it
      out.push({
        id: `cse_${f.id}`,
        kind: 'cowork',
        title: 'Cowork task' + (f.names.length ? ` · ${f.names.join(' + ')}` : ''),
        lastActivityAt: ms,
        isWorking: false,
        link: `claude://claude.ai/cowork/cse_${f.id}`,
      })
      i = out.length - 1
      index.set(sid, i)
    }
    const r = out[i]
    if (!r) continue
    // Finished early: the app's list says its last turn ended at or after
    // this step, so the task is done; no need to wait 5 minutes. Not for a task whose agents
    // still run, and a later step (a new turn) makes it running again. Same rule as chats.py.
    const isFinished = (r.settledAt ?? 0) >= ms && !r.hasAgents
    out[i] = {
      ...r,
      lastActivityAt: Math.max(r.lastActivityAt, ms),
      isWorking: r.isWorking || (!isFinished && now - ms < VM_RUNNING_WINDOW_MS),
    }
  }
  return out
}
