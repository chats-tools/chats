// A Code chat's "time since last use" is the time of its last real message: the newest user or
// assistant line of its transcript. The app's lastActivityAt also moves when no work happens
// (a timer, a reconnect), so a chat that was quiet for hours could show "22m".
// Same rule in ChatsBar (chats.py, last_said_ms).

/** Time (ms) of the newest user or assistant line in a piece of a transcript, or 0. */
export function lastSaidIn(text: string): number {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue
    try {
      const o = JSON.parse(line) as { type?: unknown; timestamp?: unknown }
      if (o.type !== 'user' && o.type !== 'assistant') continue
      const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
      if (Number.isFinite(at) && at > 0) return at
    } catch {
      // a line cut at the read's start
    }
  }
  return 0
}

/** The time to show: the last message, else the app's time. A working chat keeps the later one. */
export function shownTime(said: number, app: number, isWorking: boolean): number {
  if (said <= 0) return app
  return isWorking ? Math.max(said, app) : said
}
