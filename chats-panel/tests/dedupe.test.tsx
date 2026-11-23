import { expect, test } from 'claude-code/testing'

import { extract } from '../hooks/appcache'

// One Cowork task can come in two forms: a short form in the sidebar list (no
// workspace_session_id, so it looks like a plain chat) and the full form on a project page.
// The reader must show it once, as a Cowork line. Made-up ids and names.
const PROJECT = { uuid: 'p-1', name: '🌱 Garden Planner' }
const SHORT = { uuid: 'conv-1', name: 'Order seeds before the sale ends', project_uuid: 'p-1', updated_at: '2026-01-01T10:00:00.000Z' }
const FULL = { ...SHORT, workspace_session_id: 'cse_demo1', project: PROJECT, updated_at: '2026-01-01T10:05:00.000Z' }
const PLAIN = { uuid: 'conv-2', name: 'A plain chat', updated_at: '2026-01-01T09:00:00.000Z' }

const q = (hash: string, data: unknown, at: number) => ({ queryHash: hash, state: { data, dataUpdatedAt: at } })
const page = (rows: unknown[], at: number) =>
  new Map<string, Record<string, unknown>>([
    ['conv-1', { conversationUuid: 'conv-1', product: 'chat_project', writtenAt: at, tree: { reads: [{ queryKey: ['project_list_conversations', { projectUuid: 'p-1' }], readAt: at, data: rows }] } }],
  ])

const CASES: [string, Record<string, unknown>[], Map<string, Record<string, unknown>>][] = [
  ['short form in the list, full form on the project page', [q('["project_list"]', [PROJECT], 1), q('["chat_conversation_list"]', [SHORT, PLAIN], 2)], page([FULL], 3)],
  ['full form in the list, short form on the project page', [q('["project_list"]', [PROJECT], 1), q('["chat_conversation_list"]', [FULL, PLAIN], 2)], page([SHORT], 3)],
  ['both forms in two lists', [q('["project_list"]', [PROJECT], 1), q('["chat_conversation_list",1]', [SHORT], 2), q('["chat_conversation_list",2]', [FULL, PLAIN], 3)], new Map()],
]

for (const [name, queries, recs] of CASES)
  test(`a chat shows once (${name})`, () => {
    const r = extract(queries, recs, undefined)
    const rows = (r?.chats ?? []).filter(c => c.title === SHORT.name)
    expect(rows.length).toBe(1)
    expect(rows[0]?.kind).toBe('cowork')
    expect(rows[0]?.id).toBe('cse_demo1')
    expect(rows[0]?.link).toBe('claude://claude.ai/cowork/cse_demo1')
    expect(rows[0]?.project).toBe('🌱 Garden Planner')
    expect(rows[0]?.lastActivityAt).toBe(Date.parse(FULL.updated_at))
    // A plain chat stays a plain chat.
    expect((r?.chats ?? []).filter(c => c.title === PLAIN.name).map(c => c.kind)).toEqual(['chat'])
  })
