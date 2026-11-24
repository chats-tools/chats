#!/usr/bin/python3 -I
"""Reads the Claude desktop app's chats from files on this Mac and prints them as JSON.

Used by the ChatsBar menu bar app. Same rules as the chats-panel mod
(../chats-panel/hooks/appcache.ts and register.tsx).

Sources (all local, read only):
  - Cowork chats, projects, running state: the app's saved sidebar copy in IndexedDB
    (Snappy-compressed, V8-serialized; private format, an app update can break it).
    Newer app versions save that copy only when the window loads, and with fewer lists in it.
  - Cowork chats of each project page you opened, and the saved transcripts of chats
    opened recently: the app's per-chat store (IndexedDB "conversations_v2", records with
    conversationUuid / product / tree). Most of it sits inside the leveldb files, so this
    file also reads leveldb .log and .ldb files.
  - Code tab chats: ~/Library/Application Support/Claude/claude-code-sessions/*/*/local_*.json
  - Cowork task with agents still running: its saved transcript has an open Task/Agent step
    (in any assistant message less than 6 h old).
  - Code chat time: the newest user or assistant line of its transcript (not the app's
    lastActivityAt, which also moves with no work); lastActivityAt only with no transcript.
  - Code chat running sign: its transcript (~/.claude/projects/*/<cli id>.jsonl) has a
    timestamped line after the chat's last turn edge, and recently.
No network, no tokens.

Demo mode (for screenshots, or to try the app without data): when the file
~/Library/Application Support/ChatsBar/demo-mode exists, or the environment variable
CHATSBAR_DEMO=1 is set, no Claude file is read at all. The output is built from demo.json (next to
this file, or ../chats-panel/demo/demo.json in the repo) and the data folder is
~/Library/Application Support/ChatsBar/demo/.
"""
import datetime
import glob
import json
import math
import os
import re
import struct
import sys
import time

HOME = os.path.expanduser('~')
APP = os.path.join(HOME, 'Library/Application Support/Claude')
BLOB_ROOT = os.path.join(APP, 'IndexedDB/https_claude.ai_0.indexeddb.blob')
LEVELDB = os.path.join(APP, 'IndexedDB/https_claude.ai_0.indexeddb.leveldb')
CODE_ROOT = os.path.join(APP, 'claude-code-sessions')
CACHE = os.path.join(HOME, 'Library/Caches/ChatsBar/cowork.json')

# Demo mode: the file is the switch (there is no setting in the app). The data files (marks,
# groups, settings) then live in the "demo" folder, so real data is never touched.
DATA_ROOT = os.path.join(HOME, 'Library/Application Support/ChatsBar')
DEMO = os.path.exists(os.path.join(DATA_ROOT, 'demo-mode')) or os.environ.get('CHATSBAR_DEMO') == '1'
DATA_DIR = os.path.join(DATA_ROOT, 'demo') if DEMO else DATA_ROOT
TAB_COUNT = 12
# A Code chat whose transcript was last written longer ago than this is not running.
CODE_RUNNING_WINDOW_S = 600
# A Cowork running flag from a saved list older than this is not used.
LIST_FRESH_MS = 10 * 60 * 1000
# Cowork VM log: a task with a tool step newer than this counts as running.
VM_LOG = os.path.join(HOME, 'Library/Logs/Claude/cowork_vm_node.log')
VM_TAIL = 2 * 1024 * 1024      # read only the end of the log (it is about 8 MB)
VM_RUNNING_WINDOW_S = 300
VM_RECENT_S = 2 * 86400        # steps older than this are not used at all


def norm(s):
    return s.lower()


# Project setup: the projects to hide and their order, picked in a setup screen in ChatsBar
# ("Projects…") or in the /chats panel. One file for both views:
#   {"hiddenProjects": ["Old Experiments", ...],   (exact project names)
#    "projectOrder": ["Garden Planner", ...],      (exact names, shown first, in this order)
#    "projectIds": {"<project id>": "<last known name>"}}
# A new project shows until you hide it. With no file (or no key), nothing is hidden and the
# projects keep the app's own order. Same rule as the mod's register.tsx.
SETTINGS = os.path.join(DATA_DIR, 'settings.json')
_hidden = None


def hidden_setting():
    """The hidden project names from settings.json, or None when none were picked yet."""
    global _hidden
    if _hidden is None:
        try:
            with open(SETTINGS) as f:
                d = json.load(f)
            h = d.get('hiddenProjects') if isinstance(d, dict) else None
            _hidden = [x for x in h if isinstance(x, str)] if isinstance(h, list) else False
        except (OSError, ValueError):
            _hidden = False
    return _hidden if _hidden is not False else None


def is_hidden(name):
    """Exact names only. Nothing is hidden until settings.json says so."""
    h = hidden_setting()
    return h is not None and name in h


_order = []  # settings.json "projectOrder" once follow_renames() read it


def project_rank(name):
    """Names in projectOrder first, in that order; all others after, in the app's order
    (sorted() is stable, so equal ranks keep their order)."""
    return _order.index(name) if name in _order else len(_order)


def follow_renames(links):
    """Project renames are followed by the project's id, so a renamed project keeps its place
    and stays hidden or shown. settings.json keeps {"projectIds": {id: last name}} and your
    order as exact names, "projectOrder" (seeded as [] when missing). When a known id has a new
    name, the old name is replaced in "hiddenProjects" and "projectOrder". The id is the last part
    of the project's claude:// link. Same rule in /chats (register.tsx followRenames)."""
    global _order, _hidden
    if not links:
        return
    try:
        with open(SETTINGS) as f:
            o = json.load(f)
        o = o if isinstance(o, dict) else {}
    except (OSError, ValueError):
        o = {}
    cur = {l.rstrip('/').split('/')[-1]: n for n, l in links.items()}
    ids = o.get('projectIds') if isinstance(o.get('projectIds'), dict) else {}
    renamed = {old: cur[i] for i, old in ids.items() if i in cur and isinstance(old, str) and cur[i] != old}
    changed = False
    for k in ('hiddenProjects', 'projectOrder'):
        v = o.get(k)
        if isinstance(v, list):
            nv = [renamed.get(x, x) for x in v]
            if nv != v:
                o[k], changed = nv, True
    if not isinstance(o.get('projectOrder'), list):
        o['projectOrder'] = []
        changed = True
    new_ids = dict(ids, **cur)
    if new_ids != ids:
        o['projectIds'], changed = new_ids, True
    if changed:
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            tmp = SETTINGS + '.tmp'
            with open(tmp, 'w') as f:
                json.dump(o, f, ensure_ascii=False, indent=2)
            os.replace(tmp, SETTINGS)
        except OSError:
            pass
    _order = [x for x in o['projectOrder'] if isinstance(x, str)]
    _hidden = None  # read again, with the new names


# ---------- Snappy and V8 (the subset the cache uses) ----------

SNAPPY_MAX = 64 * 1024 * 1024  # a declared length above this is refused


def unsnappy(b, i, limit=None):
    """Snappy block from b[i:]. With limit, stops after about that many output bytes."""
    n = sh = 0
    while True:
        if sh > 63 or i >= len(b):
            raise ValueError('bad snappy length')
        c = b[i]; i += 1
        n |= (c & 0x7f) << sh; sh += 7
        if c < 0x80:
            break
    if n > SNAPPY_MAX:
        raise ValueError('snappy length too large')
    if limit is not None:
        n = min(n, limit)
    out = bytearray()
    while i < len(b) and len(out) < n:
        t = b[i]; i += 1
        kind = t & 3
        if kind == 0:
            l = t >> 2
            if l >= 60:
                nb = l - 59
                l = int.from_bytes(b[i:i + nb], 'little'); i += nb
            l += 1
            out += b[i:i + l]; i += l
            continue
        if kind == 1:
            l = ((t >> 2) & 7) + 4
            off = ((t >> 5) << 8) | b[i]; i += 1
        elif kind == 2:
            l = (t >> 2) + 1
            off = b[i] | (b[i + 1] << 8); i += 2
        else:
            l = (t >> 2) + 1
            off = int.from_bytes(b[i:i + 4], 'little'); i += 4
        if off <= 0 or off > len(out):
            raise ValueError('bad snappy offset')
        start = len(out) - off
        if off >= l:
            out += out[start:start + l]
        else:
            for k in range(l):
                out.append(out[start + k])
    return bytes(out)


class V8:
    def __init__(self, b):
        self.b = b; self.i = 0; self.refs = []

    def vi(self):
        r = sh = 0
        b = self.b
        while True:
            if sh > 63 or self.i >= len(b):
                raise ValueError('bad varint')
            c = b[self.i]; self.i += 1
            r |= (c & 0x7f) << sh; sh += 7
            if c < 0x80:
                return r

    def peek(self):
        if self.i >= len(self.b):
            raise ValueError('end of data')
        return self.b[self.i]

    def need(self, n):
        """The bytes of a length-prefixed value: raises when fewer are left."""
        if n > len(self.b) - self.i:
            raise ValueError('length past end of data')

    def val(self):
        b = self.b
        while True:
            if self.i >= len(b):
                raise ValueError('end of data')
            t = b[self.i]; self.i += 1
            if t == 0x00:
                continue
            if t == 0xff:
                self.vi(); continue
            if t == 0xfe:
                self.i += 12; continue
            break
        t = chr(t)
        if t == '"':
            n = self.vi(); self.need(n); v = b[self.i:self.i + n].decode('latin1'); self.i += n; return v
        if t == 'c':
            n = self.vi(); self.need(n); v = b[self.i:self.i + n].decode('utf-16-le', 'replace'); self.i += n; return v
        if t == 'S':
            n = self.vi(); self.need(n); v = b[self.i:self.i + n].decode('utf8', 'replace'); self.i += n; return v
        if t == 'T':
            return True
        if t == 'F':
            return False
        if t in '_0':
            return None
        if t == 'I':
            z = self.vi(); return (z >> 1) ^ -(z & 1)
        if t == 'U':
            return self.vi()
        if t in 'ND':
            self.need(8)
            v = struct.unpack_from('<d', b, self.i)[0]; self.i += 8; return v
        if t == '^':
            return self.refs[self.vi()]
        if t == 'o':
            o = {}; self.refs.append(o)
            while self.peek() != 0x7b:
                k = self.val(); o[str(k)] = self.val()
            self.i += 1; self.vi(); return o
        if t == 'A':
            n = self.vi(); self.need(n); a = []; self.refs.append(a)
            for _ in range(n):
                a.append(self.val())
            while self.peek() != 0x24:
                self.val(); self.val()
            self.i += 1; self.vi(); self.vi(); return a
        if t == 'a':
            n = self.vi(); self.need(n); a = [None] * n; self.refs.append(a)
            while self.peek() != 0x40:
                k = self.val(); v = self.val()
                if isinstance(k, int) and k < n:
                    a[k] = v
            self.i += 1; self.vi(); self.vi(); return a
        raise ValueError('unknown V8 tag %r at %d' % (t, self.i - 1))


# ---------- Cowork: the app's saved files ----------
#
# Two stores, both IndexedDB of the claude.ai page in the app:
#   1. The sidebar copy (react-query cache): one object {timestamp, buster, clientState: {queries}}.
#      Older app versions saved it about every 20 s. Newer ones save it only when the window
#      loads, and with fewer lists in it (no project list, no Cowork session lists, no
#      transcripts).
#   2. The per-chat store ("conversations_v2"): one record per chat or project page,
#      {conversationUuid, product, tree, writtenAt}. product "chat_project": the chat list of a
#      project page you opened. product "hub": a chat's transcript. Written each time.
# Small values sit inside the leveldb files (.log, .ldb), big ones in blob files.

SNAPPY = b'\xff\x11\x02'    # Chrome's mark: a Snappy-compressed value follows
BLOB_REF = b'\xff\x11\x01'  # Chrome's mark: the value is in a blob file
USED_QUERIES = ('["project_list"', '["chat_conversation_list"', '["cowork-remote-sessions"',
                '["cowork-local-sessions"', '["hub_transcript"')
RECORD_MAX_AGE_S = 2 * 86400  # blob files older than this are not read for per-chat records


MAX_READ = 4 * 1024 * 1024  # same limit as appcache.ts: a bigger file is not read
MAX_JSON = 8 * 1024 * 1024  # a bigger session file is skipped


def read_file(p, n=-1):
    """The file's bytes, or the first n. A file over MAX_READ is not read whole (b'')."""
    try:
        if n < 0 and os.path.getsize(p) > MAX_READ:
            return b''
        with open(p, 'rb') as f:
            return f.read(n)
    except OSError:
        return b''


def decode(b):
    return V8(unsnappy(b, 3) if b[:3] == SNAPPY else b).val()


def head(b, n=200):
    """The first bytes of a value, decompressed: enough to see its first keys."""
    try:
        return unsnappy(b, 3, n) if b[:3] == SNAPPY else b[:n]
    except (IndexError, ValueError):
        return b''


def blob_files():
    """Every blob file, newest first. Do not read only the top <2 hex> folder: a save can sit
    in any folder, and other databases (for example an MCP result cache) save newer files that
    are not the sidebar copy. Each file is checked by its content."""
    found = []
    for p in glob.glob(os.path.join(BLOB_ROOT, '*', '*', '*')):
        try:
            found.append((os.path.getmtime(p), p))
        except OSError:
            pass
    return [p for _, p in sorted(found, reverse=True)]


# ---------- leveldb (the files that hold the small IndexedDB values) ----------

def uvarint(b, i):
    r = sh = 0
    while True:
        if sh > 63:
            raise ValueError('bad varint')
        c = b[i]; i += 1
        r |= (c & 0x7f) << sh; sh += 7
        if c < 0x80:
            return r, i


def log_entries(d):
    """(key, seq, value or None for a delete) from a leveldb .log file."""
    recs, buf, i, block = [], b'', 0, 32768
    while i + 7 <= len(d):
        if block - i % block < 7:
            i += block - i % block
            continue
        ln, ty = struct.unpack_from('<HB', d, i + 4)
        i += 7
        frag = d[i:i + ln]; i += ln
        if ty == 1:
            recs.append(frag)
        elif ty == 2:
            buf = frag
        elif ty == 3:
            buf += frag
        elif ty == 4:
            recs.append(buf + frag); buf = b''
        else:  # zero fill: the rest of the block is empty
            i += (block - i % block) % block
    for r in recs:
        try:
            seq, count = struct.unpack_from('<QI', r, 0)
            j = 12
            for k in range(count):
                tag = r[j]; j += 1
                kl, j = uvarint(r, j)
                key = r[j:j + kl]; j += kl
                if tag == 1:
                    vl, j = uvarint(r, j)
                    yield key, seq + k, r[j:j + vl]
                    j += vl
                else:
                    yield key, seq + k, None
        except (IndexError, ValueError, struct.error):
            continue


def block_entries(blk):
    restarts = struct.unpack_from('<I', blk, len(blk) - 4)[0]
    end, i, key = len(blk) - 4 - 4 * restarts, 0, b''
    while i < end:
        shared, i = uvarint(blk, i)
        own, i = uvarint(blk, i)
        vl, i = uvarint(blk, i)
        if shared > len(key) or own > len(blk) - i:
            raise ValueError('bad leveldb block entry')
        key = key[:shared] + blk[i:i + own]; i += own
        if vl > len(blk) - i:
            raise ValueError('bad leveldb block entry')
        yield key, blk[i:i + vl]
        i += vl


def table_entries(d):
    """(key, seq, value or None for a delete) from a leveldb .ldb table file."""
    def block(off, size):
        raw = d[off:off + size]
        return unsnappy(raw, 0) if d[off + size] == 1 else raw
    footer = d[-48:]
    _, i = uvarint(footer, 0)
    _, i = uvarint(footer, i)  # the meta index: not needed
    io, i = uvarint(footer, i)
    isz, i = uvarint(footer, i)
    for _, handle in block_entries(block(io, isz)):
        bo, j = uvarint(handle, 0)
        bs, j = uvarint(handle, j)
        for k, v in block_entries(block(bo, bs)):
            tag = int.from_bytes(k[-8:], 'little')
            yield k[:-8], tag >> 8, (v if tag & 0xff == 1 else None)


def leveldb_values():
    """The live value of each key in the app's IndexedDB leveldb (the newest write wins)."""
    best = {}
    files = sorted(glob.glob(os.path.join(LEVELDB, '*.ldb'))) + sorted(glob.glob(os.path.join(LEVELDB, '*.log')))
    for p in files:
        d = read_file(p)
        try:
            for k, seq, v in (table_entries(d) if p.endswith('.ldb') else log_entries(d)):
                if k not in best or seq > best[k][0]:
                    best[k] = (seq, v)
        except (IndexError, ValueError, struct.error):
            continue  # a file the app is writing now; the next read gets it
    return [v for _, v in best.values() if v is not None]


def idb_value(v):
    """A value as Chrome's IndexedDB keeps it: a version number, then the V8 bytes."""
    try:
        _, j = uvarint(v, 0)
    except (IndexError, ValueError):
        return b''
    return v[j:]


def chat_records():
    """The per-chat store: {conversationUuid: record}; the newest writtenAt wins."""
    recs = {}

    def add(b):
        if b'conversationUuid' not in head(b, 64):
            return
        try:
            r = decode(b)
        except Exception:
            return
        u = r.get('conversationUuid') if isinstance(r, dict) else None
        if isinstance(u, str) and isinstance(r.get('tree'), dict) and \
                (r.get('writtenAt') or 0) >= (recs.get(u, {}).get('writtenAt') or 0):
            recs[u] = r

    for v in leveldb_values():
        b = idb_value(v)
        if len(b) > 200 and b[:1] == b'\xff' and b[:3] != BLOB_REF:
            add(b)
    now = time.time()
    for p in blob_files():
        try:
            if now - os.path.getmtime(p) > RECORD_MAX_AGE_S:
                break  # newest first, so the rest are older too
        except OSError:
            continue
        add(read_file(p))
    return recs


def iso_ms(s):
    if not isinstance(s, str):
        return 0
    try:
        from datetime import datetime
        return int(datetime.fromisoformat(s.replace('Z', '+00:00')[:32]).timestamp() * 1000)
    except ValueError:
        return 0


def page_rows(d):
    """The chat rows of a list query: plain list, {data: [...]}, or {pages: [...]}."""
    pages = d['pages'] if isinstance(d, dict) and isinstance(d.get('pages'), list) else [d]
    for page in pages:
        lst = page.get('data') if isinstance(page, dict) else page
        if isinstance(lst, list):
            for c in lst:
                if isinstance(c, dict):
                    yield c


def extract(queries, recs, mem):
    """Chats and projects from the sidebar copy's queries and the per-chat records.
    mem: project names and stars seen before ({'names': {uuid: name}, 'starred': [...]}).
    Newer copies of the app have no project list, so names seen once are kept."""
    qs = sorted((q for q in queries if isinstance(q, dict)),
                key=lambda q: (q.get('state') or {}).get('dataUpdatedAt') or 0)
    upd = lambda q: (q.get('state') or {}).get('dataUpdatedAt') or 0
    names, starred = {}, set()
    for q in qs:
        if not str(q.get('queryHash', '')).startswith('["project_list"'):
            continue
        for p in (q.get('state') or {}).get('data') or []:
            if isinstance(p, dict) and p.get('uuid') and p.get('name') and not p.get('archived_at'):
                names[p['uuid']] = p['name'].strip()
                if p.get('is_starred') is True:
                    starred.add(p['name'].strip())
    if not names:  # no project list in this copy: use the names seen before
        names = dict((mem or {}).get('names') or {})
        starred = set((mem or {}).get('starred') or [])
    by_id, fetched = {}, {}
    cur = [0]

    def put(row):
        # A running flag from a list fetched long ago is stale: the app's copy can be hours
        # old, and the flag stays until the next save.
        if row['working'] and time.time() * 1000 - cur[0] > LIST_FRESH_MS:
            row['working'] = False
        old = by_id.get(row['id'])
        newer = cur[0] >= fetched.get(row['id'], -1)
        if newer:
            fetched[row['id']] = cur[0]
        if old is None:
            by_id[row['id']] = row; return
        old['title'] = old['title'] or row['title']
        old['project'] = old['project'] or row['project']
        old['scheduled'] = old.get('scheduled') or row.get('scheduled', False)
        old['at'] = max(old['at'], row['at'])
        old['settled'] = max(old.get('settled', 0), row.get('settled', 0))
        if newer:
            old['working'] = row['working']

    def from_conv(c):
        if c.get('is_archived') is True or c.get('is_temporary') is True or not c.get('uuid'):
            return
        # One Cowork task can come in two forms. The sidebar list can hold a short form with
        # no workspace_session_id (it looks like a plain chat, keyed by its uuid). A project
        # page holds the full form (keyed by the task id). The task id, once seen, is kept for
        # the uuid, and a plain-chat row made before is merged into the task's row. So each
        # chat shows once. Same in /chats (appcache.ts).
        ws = c.get('workspace_session_id') or task_of.get(c['uuid'])
        if ws and ws != c['uuid']:
            task_of[c['uuid']] = ws
            early = by_id.pop(c['uuid'], None)
            if early is not None:
                at = fetched.pop(c['uuid'], -1)
                keep = cur[0]
                cur[0] = at
                early.update({'id': ws, 'kind': 'cowork', 'link': 'claude://claude.ai/cowork/%s' % ws})
                put(early)
                cur[0] = keep
        p = c.get('project')
        if isinstance(p, dict) and p.get('uuid') and p.get('name'):
            names[p['uuid']] = p['name'].strip()  # learn it for later copies
        proj = p['name'].strip() if isinstance(p, dict) and p.get('name') else names.get(c.get('project_uuid'))
        live = c.get('live_status')
        chat_ids[c['uuid']] = ws or c['uuid']
        put({'id': ws or c['uuid'], 'kind': 'cowork' if ws else 'chat', 'title': c.get('name') or 'Untitled',
             'at': iso_ms(c.get('updated_at')),
             'working': isinstance(live, str) and live not in ('idle', 'completed'),
             'settled': iso_ms(c.get('last_settled_at')),  # when its last turn ended
             'project': proj,
             'link': 'claude://claude.ai/cowork/%s' % ws if ws else 'claude://claude.ai/chat/%s' % c['uuid']})

    def from_sess(s):
        sid = s.get('sessionId')
        if not sid or s.get('isArchived') is True:
            return
        ups = s.get('userSelectedProjectUuids')
        pu = ups[0] if isinstance(ups, list) and ups else None
        live = s.get('liveStatus')
        put({'id': sid, 'kind': 'cowork', 'title': s.get('title') or 'Untitled',
             'at': s.get('lastActivityAt') or 0,
             'working': s.get('isRunning') is True or (isinstance(live, str) and live != 'idle'),
             'project': names.get(pu), 'link': 'claude://claude.ai/cowork/%s' % sid,
             # A scheduled-task run has no project in the app itself, so its line says
             # "| Scheduled". Same in /chats (appcache.ts, register.tsx).
             'scheduled': bool(s.get('scheduledTaskId'))})

    chat_ids = {}  # chat uuid -> row id, for agents_running below
    task_of = {}  # chat uuid -> Cowork task id (see from_conv)
    for q in qs:
        h = str(q.get('queryHash', ''))
        d = (q.get('state') or {}).get('data')
        cur[0] = upd(q)
        if h.startswith('["chat_conversation_list"'):
            for c in page_rows(d):
                from_conv(c)
        elif h.startswith('["cowork-remote-sessions"') and isinstance(d, list):
            for s in d:
                if isinstance(s, dict):
                    from_sess(s)
        elif h.startswith('["cowork-local-sessions"') and isinstance(d, dict) and isinstance(d.get('rows'), list):
            for s in d['rows']:
                if isinstance(s, dict):
                    from_sess(s)
    # Project pages you opened: newer chat lists, one per project. A project whose
    # name is not known is skipped, so its chats do not show as "No project".
    for r in sorted(recs.values(), key=lambda r: r.get('writtenAt') or 0):
        if r.get('product') != 'chat_project':
            continue
        for read in r['tree'].get('reads') or []:
            key = read.get('queryKey') if isinstance(read, dict) else None
            if not (isinstance(key, list) and len(key) > 1 and key[0] == 'project_list_conversations'
                    and isinstance(key[1], dict) and key[1].get('projectUuid') in names):
                continue
            cur[0] = read.get('readAt') or r.get('writtenAt') or 0
            for c in page_rows(read.get('data')):
                from_conv(c)
    # A task whose turn ended while its agents still run in the background has no
    # live_status. Its saved transcript (kept only for chats opened recently) still
    # shows the agent steps with no result yet. Older app versions kept the transcript as a
    # hub_transcript query in the sidebar copy; newer ones as a "hub" record.
    transcripts = []
    for q in qs:
        h = str(q.get('queryHash', ''))
        if h.startswith('["hub_transcript"'):
            try:
                transcripts.append((json.loads(h)[2].get('uuid'), (q.get('state') or {}).get('data')))
            except (ValueError, IndexError, AttributeError):
                continue
    for r in recs.values():
        if r.get('product') == 'hub':
            transcripts.append((r.get('conversationUuid'), r['tree']))
    for uuid, d in transcripts:
        row = by_id.get(chat_ids.get(uuid))
        if row and agents_running(d):
            row['working'] = True
            row['agents'] = True  # its turn ended but agents run: last_settled_at does not end it
    if not by_id:
        return None
    chats = sorted(by_id.values(), key=lambda c: -c['at'])
    order = []
    for c in chats:
        if c['project'] and c['project'] not in order:
            order.append(c['project'])
    for n in names.values():
        if n not in order:
            order.append(n)
    projects = [p for p in order if p in starred] + [p for p in order if p not in starred]
    links = {n: 'claude://claude.ai/project/%s' % i for i, n in names.items()}
    return {'chats': chats, 'projects': projects, 'projectLinks': links,
            'mem': {'names': names, 'starred': sorted(starred)}}


AGENT_TOOLS = ('Task', 'Agent')
AGENT_MAX_AGE_MS = 6 * 3600 * 1000  # an agent step older than this counts as stopped


def agents_running(d, now_ms=None):
    """True if a saved transcript has an agent step with no result, less than 6 h old.
    Any assistant message counts, not only the newest: you can send messages while an
    agent runs, and the open step then sits in an older message."""
    msgs = d.get('messages') if isinstance(d, dict) else None
    if not isinstance(msgs, list) or not msgs:
        return False
    now_ms = now_ms or time.time() * 1000
    done = set()
    for m in msgs:
        for c in (m.get('content') or []) if isinstance(m, dict) else []:
            if isinstance(c, dict) and c.get('type') == 'tool_result':
                done.add(c.get('tool_use_id'))
    for m in msgs:
        if not isinstance(m, dict) or m.get('sender') != 'assistant':
            continue
        if now_ms - iso_ms(m.get('created_at')) > AGENT_MAX_AGE_MS:
            continue
        for c in m.get('content') or []:
            if (isinstance(c, dict) and c.get('type') == 'tool_use' and c.get('name') in AGENT_TOOLS
                    and not c.get('_isSubagentBlock') and c.get('id') not in done):
                return True
    return False


def has_chats(queries):
    return any(str(q.get('queryHash', '')).startswith(USED_QUERIES[1:4]) for q in queries)


def read_cowork():
    """Returns (result, saved_at). Decoding the sidebar copy takes a moment, so its useful
    lists are kept in CACHE until the app saves a new copy. CACHE also keeps the project
    names seen before (mem)."""
    try:
        with open(CACHE) as f:
            cache = json.load(f)
        if not isinstance(cache, dict):
            cache = {}
    except (OSError, ValueError):
        cache = {}
    path, mtime, queries = None, 0, []
    for p in blob_files():
        try:
            m = os.path.getmtime(p)
        except OSError:
            continue
        if p == cache.get('path') and m == cache.get('mtime') and isinstance(cache.get('queries'), list):
            path, mtime, queries = p, m, cache['queries']
            break
        if b'clientState' not in head(read_file(p, 2048)):
            continue  # not a sidebar copy
        try:
            qs = decode(read_file(p))['clientState']['queries']
        except Exception:
            continue
        qs = [q for q in qs if isinstance(q, dict) and str(q.get('queryHash', '')).startswith(USED_QUERIES)]
        if has_chats(qs):  # a copy saved while the window loads can hold no chat list yet
            path, mtime, queries = p, m, qs
            break
    try:
        recs = chat_records()
    except Exception:
        recs = {}
    result = extract(queries, recs, cache.get('mem'))
    if result is None:
        return None, 0
    mem = result.pop('mem')
    if path != cache.get('path') or mtime != cache.get('mtime') or mem != cache.get('mem'):
        try:
            os.makedirs(os.path.dirname(CACHE), exist_ok=True)
            tmp = CACHE + '.tmp'
            with open(tmp, 'w') as f:
                json.dump({'path': path, 'mtime': mtime, 'queries': queries, 'mem': mem}, f, ensure_ascii=False)
            os.replace(tmp, CACHE)
        except OSError:
            pass
    if not mtime:  # no sidebar copy: date the result by the newest per-chat record
        mtime = max([(r.get('writtenAt') or 0) for r in recs.values()] or [0]) / 1000
    return result, mtime


# ---------- Cowork: tool steps in the app's VM log ----------
#
# Newer app versions save a copy with no running state and no task started after the window
# loaded. The VM log is written live: one line per tool step a Cowork task runs on this Mac,
# for example
#   2024-01-01 09:12:35 [info] [vmOneShot] Running: bash [2 arg(s)] as rcw-<task id>
# rcw-<task id> is the Cowork task's id in lower case. Limits: thinking and connector steps write no
# line, so a task that only thinks for over 5 minutes shows as idle. A finished task drops as
# soon as the app saves a list whose last_settled_at is at or after its last step (a few
# minutes at most); without that, it shows as running for up to 5 minutes after its last step.

def vm_steps():
    """The last VM tool step of each Cowork task: {lowercase id: time in ms}."""
    out = {}
    try:
        with open(VM_LOG, 'rb') as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - VM_TAIL))
            data = f.read()
    except OSError:
        return out
    for raw in data.split(b'\n'):
        if b'[vmOneShot] Running:' not in raw or b' as rcw-' not in raw:
            continue
        try:
            sid = raw.rsplit(b' as rcw-', 1)[1].strip().decode('ascii').lower()
            ms = time.mktime(time.strptime(raw[:19].decode('ascii'), '%Y-%m-%d %H:%M:%S')) * 1000
        except (ValueError, UnicodeDecodeError, OverflowError):
            continue
        out[sid] = max(out.get(sid, 0), ms)
    return out


def session_folders():
    """remote-session-spaces.json: {lowercase id: (id in its own case, [folder names])}."""
    out = {}
    for p in glob.glob(os.path.join(APP, 'local-agent-mode-sessions/*/*/remote-session-spaces.json')):
        try:
            with open(p) as f:
                entries = json.load(f).get('entries') or []
        except (OSError, ValueError, AttributeError):
            continue
        for e in entries:
            sid = str(e.get('sessionId', '')) if isinstance(e, dict) else ''
            if '_' in sid:
                real = sid.split('_', 1)[1]
                names = [os.path.basename(str(x).rstrip('/')) for x in e.get('folders') or []]
                out[real.lower()] = (real, names)
    return out


# Deleted tasks. After a task is deleted its old VM steps stay in the log, so without this rule
# the reader would make a row for it, and its link would open nothing. When the app deletes a
# task it writes to its main log:
#   2024-01-01 15:00:16 [info] LocalAgentModeSessions.clearRemoteSessionFolderGrants: session_<task id>
# The same line also comes in other cases (for example next to "Remote control enabled"), so a
# task counts as deleted only when the line is at or after its last VM step and its last
# activity. Such a task gets no row and no running state.
MAIN_LOG = os.path.join(HOME, 'Library/Logs/Claude/main.log')
MAIN_TAIL = 4 * 1024 * 1024  # read only the end of the log


def deleted_tasks():
    """{lowercase id: time in ms of the app's last folder-grant clear}, from its main log."""
    try:
        with open(MAIN_LOG, 'rb') as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - MAIN_TAIL))
            data = f.read()
    except OSError:
        return {}
    out = {}
    for m in re.finditer(rb'^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) .*clearRemoteSessionFolderGrants: session_([0-9A-Za-z]+)',
                         data, re.M):
        try:
            ms = time.mktime(time.strptime(m.group(1).decode('ascii'), '%Y-%m-%d %H:%M:%S')) * 1000
        except (ValueError, OverflowError):
            continue
        sid = m.group(2).decode('ascii').lower()
        out[sid] = max(out.get(sid, 0), ms)
    return out


def apply_vm_steps(rows, now_ms):
    """Marks Cowork tasks with a recent VM step as running. A task missing from the app's
    saved copy gets its own row, titled with its folders (the title is not on this Mac).
    Tasks the app deleted are dropped."""
    steps = vm_steps()
    if not steps:
        return rows
    cleared = deleted_tasks()
    deleted = {sid for sid, ms in cleared.items() if ms >= steps.get(sid, 0)}
    if deleted:
        rows = [r for r in rows if not (r['kind'] == 'cowork' and '_' in r['id']
                                        and r['id'].split('_', 1)[1].lower() in deleted
                                        and cleared[r['id'].split('_', 1)[1].lower()] >= r['at'])]
    by_key = {r['id'].split('_', 1)[1].lower(): r for r in rows if r['kind'] == 'cowork' and '_' in r['id']}
    folders = None
    for sid, ms in steps.items():
        if now_ms - ms > VM_RECENT_S * 1000 or sid in deleted:
            continue
        r = by_key.get(sid)
        if r is None:
            if folders is None:
                folders = session_folders()
            if sid not in folders:
                continue  # its id in the right case is not known, so no link can open it
            real, names = folders[sid]
            r = {'id': 'cse_' + real, 'kind': 'cowork',
                 'title': 'Cowork task' + (' · ' + ' + '.join(names) if names else ''),
                 'at': ms, 'working': False, 'project': None,
                 'link': 'claude://claude.ai/cowork/cse_' + real}
            rows.append(r)
            by_key[sid] = r
        r['at'] = max(r['at'], ms)
        # Finished early: the app's list says its last turn ended at or after this step, so the
        # task is done; no need to wait 5 minutes. Not for a task whose
        # agents still run, and a later step (a new turn) makes it running again.
        if r.get('settled', 0) >= ms and not r.get('agents'):
            continue
        if now_ms - ms < VM_RUNNING_WINDOW_S * 1000:
            r['working'] = True
    return rows


# ---------- Code tab chats ----------

def stamp_ms(stamp):
    """A transcript 'timestamp' ("2026-11-24T11:39:04.421Z") as ms, or 0."""
    try:
        dt = datetime.datetime.strptime(stamp[:19], '%Y-%m-%dT%H:%M:%S')
        ms = int(stamp[20:23]) if stamp[19:20] == '.' else 0
        return dt.replace(tzinfo=datetime.timezone.utc).timestamp() * 1000 + ms
    except (ValueError, TypeError, AttributeError):
        return 0


def tail_lines(path, tail):
    """The lines of the last `tail` bytes of a file, and the file size; ([], 0) on an error."""
    try:
        with open(path, 'rb') as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - tail))
            return fh.read().split(b'\n'), size
    except OSError:
        return [], 0


def last_stamp_ms(path, tail=262144):
    """Time (ms) of the newest transcript line that has a 'timestamp', or 0."""
    for raw in reversed(tail_lines(path, tail)[0]):
        if b'"timestamp"' not in raw:
            continue
        try:
            ms = stamp_ms(json.loads(raw).get('timestamp'))
        except (ValueError, AttributeError):
            continue
        if ms:
            return ms
    return 0


def last_said_ms(path):
    """Time (ms) of the newest user or assistant line of a transcript, or 0.

    This is the chat's "time since last use". The app's lastActivityAt also moves when no work
    happens (a timer, a reconnect), so a chat that was quiet for hours could show "22m".
    Only the tail is read (these files can reach 50 MB); a longer tail if it has no message."""
    for tail in (262144, 1048576, 4194304):
        lines, size = tail_lines(path, tail)
        for raw in reversed(lines):
            if b'"type":"user"' not in raw and b'"type":"assistant"' not in raw:
                continue
            try:
                d = json.loads(raw)
            except ValueError:
                continue  # a line cut at the read's start
            if isinstance(d, dict) and d.get('type') in ('user', 'assistant'):
                ms = stamp_ms(d.get('timestamp'))
                if ms:
                    return ms
        if size <= tail:
            break
    return 0


def read_code(now_ms):
    transcripts = {}
    for p in glob.glob(os.path.join(HOME, '.claude/projects/*/*.jsonl')):
        transcripts[os.path.basename(p)[:-6]] = p
    out = []
    for f in glob.glob(os.path.join(CODE_ROOT, '*/*/local_*.json')):
        try:
            if os.path.getsize(f) > MAX_JSON:
                continue
            with open(f) as fh:
                d = json.load(fh)
        except (OSError, ValueError):
            continue
        try:
            row = code_row(f, d, transcripts, now_ms)
        except (ValueError, TypeError, AttributeError, OverflowError):
            continue  # a session file of an unexpected shape
        if row:
            out.append(row)
    return out


def code_row(f, d, transcripts, now_ms):
    """The row of one Code session file, or None to skip it."""
    if not isinstance(d, dict):
        raise TypeError('not an object')
    if d.get('isArchived') is True or not d.get('sessionId'):
        return None
    if not isinstance(d['sessionId'], str):
        raise TypeError('bad session id')
    # The first of the two ids that has a transcript (same order as the panel's lastSaid).
    t = transcripts.get(d.get('lastAssistantCliSessionId') or '') or transcripts.get(d.get('cliSessionId') or '')
    try:
        # The last real message; the app's lastActivityAt only when there is no transcript.
        at = (last_said_ms(t) if t else 0) or float(d.get('lastActivityAt') or 0) or os.path.getmtime(f) * 1000
    except OSError:
        return None
    edge = float(d.get('lastTurnEdgeAt') or 0)
    if not (math.isfinite(at) and math.isfinite(edge)):
        raise ValueError('bad time')
    working = False
    try:
        tm = os.path.getmtime(t) * 1000 if t else 0
    except OSError:
        t = None
    if t and edge:
        # Written after the last turn edge, and not long ago: maybe running. Opening or
        # resuming a chat also writes lines (bridge-session, cost-state), but those have no
        # timestamp, so the newest timestamped line decides.
        if tm - edge > 3000 and now_ms - tm < CODE_RUNNING_WINDOW_S * 1000:
            ts = last_stamp_ms(t)
            working = ts - edge > 3000 and now_ms - ts < CODE_RUNNING_WINDOW_S * 1000
            tm = ts
        if working:
            at = max(at, tm)
    return {'id': d['sessionId'], 'kind': 'code', 'title': d['title'] if isinstance(d.get('title'), str) and d['title'] else 'Untitled',
            'at': at, 'working': working, 'project': None,
            'link': 'claude://claude.ai/epitaxy/%s' % d['sessionId']}


# ---------- the menu ----------

def ago(ms):
    m = round(ms / 60000)
    if m < 1:
        return 'now'
    if m < 60:
        return '%dm' % m
    h = round(m / 60)
    return '%dh' % h if h < 48 else '%dd' % round(h / 24)


def is_rtl(s):
    for ch in s:
        if ch.isalpha():
            return '\u0590' <= ch <= '\u05ff'
    return False


def rtl(s):
    return '\u2067' + s + '\u2069' if is_rtl(s) else s


def kind_label(c):
    return {'code': 'Code', 'cowork': 'Cowork', 'chat': 'Chat'}[c['kind']]


def line(c, now_ms, show_where):
    # What follows the title (same as /chats): show_where True (Recent,
    # Working now, a group): "| <project> | Cowork" or "| Code"; 'kind' ("No project"): "| Cowork";
    # False (a project's list, Code): nothing but "| Chat". Then "| Scheduled".
    if show_where is True:
        parts = [c['project'] or '', kind_label(c)]
    elif show_where == 'kind':
        parts = [kind_label(c)]
    else:
        parts = ['Chat'] if c['kind'] == 'chat' else []
    tail = ''.join(' | %s' % x for x in parts + ['Scheduled' if c.get('scheduled') else ''] if x)
    if c['working']:
        return '▶ %s%s' % (rtl(c['title']), tail)
    return '%s | %s%s' % (ago(now_ms - c['at']), rtl(c['title']), tail)


# Your marks: Bold and Important, set by a right-click in ChatsBar or the Mark switch in the
# /chats panel. One file for both views, keyed by the chat's id in lower case (the last part of
# its claude:// link):  {"demo-cowork-01": {"bold": true, "important": true}}
MARKS = os.path.join(DATA_DIR, 'marks.json')
_marks = None


def read_marks():
    global _marks
    if _marks is None:
        try:
            with open(MARKS) as f:
                d = json.load(f)
            _marks = d if isinstance(d, dict) else {}
        except (OSError, ValueError):
            _marks = {}
    return _marks


def mark_key(link):
    return str(link).rstrip('/').rsplit('/', 1)[-1].lower()


def title_marks(title):
    """Marks from the title: "***" before the first letter or digit makes the
    chat bold, "!" there makes it Important (orange). Same rule as titleMarks in the mod."""
    head = ''
    for ch in str(title):
        if ch.isalnum():
            break
        head += ch
    return '***' in head, '!' in head


def item(c, now_ms, show_where):
    m = read_marks().get(mark_key(c['link'])) or {}
    m = m if isinstance(m, dict) else {}
    tb, ti = title_marks(c['title'])
    return {'title': line(c, now_ms, show_where), 'link': c['link'], 'working': c['working'],
            'bold': m.get('bold') is True or tb, 'important': m.get('important') is True or ti,
            'key': mark_key(c['link'])}


# Your groups: subjects you name, like Chrome tab groups, for Code and Cowork chats together.
# One file for ChatsBar (drag window) and every /chats panel:
#   {"groups": [{"id": "g-1763820000000", "name": "This week", "chats": ["<chat key>", ...]}]}
# A chat key is the same as for marks. A chat can be in more than one group; it shows in each
# of them. Groups are shown newest first: by the last activity of their newest chat; groups with no chat in view go last.
GROUPS = os.path.join(DATA_DIR, 'groups.json')


def read_groups():
    try:
        with open(GROUPS) as f:
            d = json.load(f)
    except (OSError, ValueError):
        return []
    gs = d.get('groups') if isinstance(d, dict) else None
    out = []
    for g in gs if isinstance(gs, list) else []:
        if isinstance(g, dict) and isinstance(g.get('id'), str):
            ks = g.get('chats')
            out.append({'id': g['id'], 'name': str(g.get('name') or 'Group'),
                        'chats': [k for k in ks if isinstance(k, str)] if isinstance(ks, list) else []})
    return out


def build_groups(chats, now_ms):
    by_key = {}
    for c in chats:
        by_key.setdefault(mark_key(c['link']), c)
    out = []
    for g in read_groups():
        members = sorted({k: by_key[k] for k in g['chats'] if k in by_key}.values(), key=lambda c: -c['at'])
        out.append({'id': g['id'], 'name': g['name'], 'at': members[0]['at'] if members else 0,
                    'items': [item(c, now_ms, True) for c in members]})
    out.sort(key=lambda g: -g['at'])  # stable: empty groups keep the file's order, at the end
    return out


# The app saves its sidebar copy every few minutes while it is in use. Some app versions stop
# saving until the app is restarted. A copy older than this while the app runs gets a warning
# that says to restart the app.
STALE_AFTER_S = 15 * 60
CLAUDE_BIN = '/Applications/Claude.app/Contents/MacOS/Claude'


def claude_running():
    import subprocess
    try:
        out = subprocess.run(['/bin/ps', '-axo', 'comm='], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return any(line.strip() == CLAUDE_BIN for line in out.splitlines())


def stale_warning(now_ms, saved_at):
    if not saved_at or now_ms / 1000 - saved_at < STALE_AFTER_S or not claude_running():
        return None
    return ("The Claude app's saved chat list is %s old. The app may have stopped saving it. "
            "Quit (⌘Q) and reopen the Claude app." % ago(now_ms - saved_at * 1000))


# ---------- demo mode ----------
#
# Made-up data for screenshots and for trying the app without any Claude data. demo.json sits next
# to this file (the app bundles it in Contents/Resources), or in ../chats-panel/demo/ in the repo.
# The /chats mod reads the same file with the same rules.

DEMO_KINDS = {'cowork': 'cowork', 'code': 'epitaxy', 'chat': 'chat'}  # kind -> claude:// link part


def demo_file():
    here = os.path.dirname(os.path.abspath(__file__))
    for p in (os.path.join(here, 'demo.json'), os.path.join(here, '..', 'chats-panel', 'demo', 'demo.json')):
        if os.path.isfile(p):
            return p
    return None


def load_demo():
    p = demo_file()
    if not p:
        return None
    try:
        with open(p, encoding='utf-8') as f:
            d = json.load(f)
        return d if isinstance(d, dict) else None
    except (OSError, ValueError):
        return None


def write_if_missing(path, obj):
    if os.path.exists(path):
        return
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except OSError:
        pass


def seed_demo_files(d):
    """A missing demo data file is filled from demo.json; an existing one is left alone."""
    projects = [p for p in d.get('projects') or [] if isinstance(p, dict) and p.get('id') and p.get('name')]
    write_if_missing(MARKS, d.get('marks') if isinstance(d.get('marks'), dict) else {})
    write_if_missing(GROUPS, {'groups': d.get('groups') if isinstance(d.get('groups'), list) else []})
    write_if_missing(SETTINGS, {'hiddenProjects': d.get('hiddenProjects') or [], 'projectOrder': [],
                                'projectIds': {p['id']: p['name'] for p in projects}})


def demo_cowork(d, now_ms):
    """(chats, links, project names, saved_at) in the same shape the real readers give.
    chats holds every kind, Code and chat too."""
    projects = [p for p in d.get('projects') or [] if isinstance(p, dict) and p.get('id') and p.get('name')]
    chats = []
    for c in d.get('chats') or []:
        if not isinstance(c, dict) or not c.get('id') or c.get('kind') not in DEMO_KINDS:
            continue
        chats.append({'id': c['id'], 'kind': c['kind'], 'title': str(c.get('title') or 'Untitled'),
                      'at': now_ms - float(c.get('minutesAgo') or 0) * 60000,
                      'working': c.get('isWorking') is True, 'scheduled': c.get('isScheduled') is True,
                      'project': c.get('project') or None,
                      'link': 'claude://claude.ai/%s/%s' % (DEMO_KINDS[c['kind']], c['id'])})
    links = {p['name']: 'claude://claude.ai/project/%s' % p['id'] for p in projects}
    saved_at = now_ms / 1000 - float(d.get('savedCopyMinutesAgo') or 0) * 60
    return chats, links, [p['name'] for p in projects], saved_at


READ_ERROR = 'some data could not be read'  # fixed text: never file content or titles


def guarded(failed, fn, empty, *args):
    """fn(*args), or the empty result when it fails, so one bad file cannot blank every list."""
    try:
        return fn(*args)
    except Exception:
        failed.append(fn.__name__)
        return empty


def main():
    now_ms = time.time() * 1000
    error = None
    failed = []
    if DEMO:
        d = load_demo()
        if d is None:
            d, error = {}, 'demo mode is on, but demo.json was not found'
        seed_demo_files(d)
        chats, links, found, saved_at = demo_cowork(d, now_ms)
        chats.sort(key=lambda c: -c['at'])  # stable: equal times keep demo.json's order
        cowork = cowork_rows = chats
    else:
        cowork, saved_at = guarded(failed, read_cowork, (None, 0))
        code = guarded(failed, read_code, [], now_ms)
        base = cowork['chats'] if cowork else []
        cowork_rows = guarded(failed, apply_vm_steps, base, base, now_ms)
        chats = sorted(code + cowork_rows, key=lambda c: -c['at'])
        found = cowork['projects'] if cowork else []
        links = cowork['projectLinks'] if cowork else {}
    guarded(failed, follow_renames, None, links)
    ranked = sorted(found, key=project_rank)  # stable: the app's order inside each rank
    projects = [p for p in ranked if not is_hidden(p)]
    working = [c for c in chats if c['working']]
    groups = [
        {'name': 'Recent', 'items': [item(c, now_ms, True) for c in chats[:TAB_COUNT]]},
        {'name': 'No project', 'items': [item(c, now_ms, 'kind') for c in chats
                                         if c['kind'] != 'code' and not c['project']][:TAB_COUNT]},
        {'name': 'Code', 'items': [item(c, now_ms, False) for c in chats if c['kind'] == 'code'][:TAB_COUNT]},
    ]
    proj = [{'name': p, 'rtl': is_rtl(p), 'link': links.get(p),
             'items': [item(c, now_ms, False) for c in chats if c['project'] == p][:TAB_COUNT]}
            for p in projects]
    json.dump({
        'working': [item(c, now_ms, True) for c in working],
        'recent': groups,
        'projects': proj,
        'groups': guarded(failed, build_groups, [], chats, now_ms),
        'allProjects': [{'name': p, 'rtl': is_rtl(p), 'hidden': is_hidden(p)} for p in ranked],
        'cacheAge': ago(now_ms - saved_at * 1000) if saved_at else None,
        'staleWarning': None if DEMO else stale_warning(now_ms, saved_at),
        'error': error or (READ_ERROR if failed else None if cowork or cowork_rows else "could not read the app's saved copy"),
    }, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
