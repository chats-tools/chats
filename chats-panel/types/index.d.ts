export type ChatRow = {
  id: string
  /** code: Code tab; cowork: a Cowork task; chat: a plain Claude chat */
  kind: 'code' | 'cowork' | 'chat'
  title: string
  lastActivityAt: number
  isWorking: boolean
  /** The Cowork project's name, when the chat is in one */
  project?: string
  /** claude:// link that opens the chat in the app */
  link: string
  /** Cowork: when its last turn ended (the app's last_settled_at), in ms */
  settledAt?: number
  /** Cowork: its turn ended but its agents still run, so settledAt does not end it */
  hasAgents?: boolean
  /** Cowork: a run of a scheduled task (the app's scheduledTaskId); its line says "| Scheduled" */
  isScheduled?: boolean
}

/** One usage bar: weekly limit, 5-hour limit, or this chat's context */
export type UsageBar = {
  label: string
  percent: number
  note: string
  isActive: boolean
  /** Drawn in place of the label's usual name (the context bar of another chat: its title) */
  name?: string
  /** The context bar's parts (Messages, MCP tools, ...), each a percent of the window */
  segments?: { color: string; percent: number }[]
}

export type ChatView = {
  chats: ChatRow[]
  bars: UsageBar[]
  /** Project names: starred first, then by latest chat */
  projects: string[]
  /** Project name to the claude:// link of its page in the app */
  projectLinks: Record<string, string>
  usage: string
  updatedAt: number
  /** When the app last saved the cache read for Cowork; 0 when none was read */
  cacheAt: number
}

/** Your marks per chat id (lower case), shared with ChatsBar through marks.json */
export type Mark = { bold?: boolean; important?: boolean }
export type Marks = Record<string, Mark>

/** Your group of chats (a subject), shared with ChatsBar through groups.json */
export type ChatGroupDef = { id: string; name: string; chats: string[] }

declare module 'claude-code' {
  interface PluginState {
    'chats-panel': {
      view: Shaped<ChatView>
      tab: string
      marks: Marks
      groups: ChatGroupDef[]
      /** What is open under a line, as "<what>|<slot>|<id>" (new, rename, menu); '' when nothing */
      moving: string
      /** Hidden project names from settings.json (exact); null when none were picked yet: nothing is hidden */
      hiddenProjects: string[] | null
      /** /chats was opened in this chat; kept across /reload-plugins so the panel goes on updating */
      isOpen: boolean
      /** The group deleted last, for Undo (20 seconds); null when there is none */
      undoDelete: { group: ChatGroupDef; index: number; at: number } | null
      /** Your project order as exact names (settings.json "projectOrder"); [] keeps the app's order */
      projectOrder: string[]
      /** A step inside an open pop-up: "confirm|<group id>" or "rename|<group id>"; '' when none */
      cardStep: string
    }
  }
}
