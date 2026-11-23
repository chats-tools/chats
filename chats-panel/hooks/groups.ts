import type { ChatGroupDef } from '../types'

// A chat can be in more than one group. These change one group and keep the chat in its other
// groups. groups.json keeps its shape: {"groups": [{"id", "name", "chats": [<chat key>, ...]}]}.
// Same rules in ChatsBar (ChatsBar.swift, Store.add / remove / removeAll).

/** Puts the chat at the top of group `gid`. Its other groups stay. */
export const addChat = (key: string, gid: string) => (gs: ChatGroupDef[]) =>
  gs.map(g => (g.id === gid && !g.chats.includes(key) ? { ...g, chats: [key, ...g.chats] } : g))

/** Takes the chat out of group `gid` only. */
export const removeChat = (key: string, gid: string) => (gs: ChatGroupDef[]) =>
  gs.map(g => (g.id === gid ? { ...g, chats: g.chats.filter(k => k !== key) } : g))

/** Takes the chat out of every group ("No group"). */
export const removeFromAll = (key: string) => (gs: ChatGroupDef[]) =>
  gs.map(g => (g.chats.includes(key) ? { ...g, chats: g.chats.filter(k => k !== key) } : g))

/** In group `gid`: out. Not in it: in. Its other groups stay. */
export const toggleChat = (key: string, gid: string) => (gs: ChatGroupDef[]) =>
  gs.some(g => g.id === gid && g.chats.includes(key)) ? removeChat(key, gid)(gs) : addChat(key, gid)(gs)
