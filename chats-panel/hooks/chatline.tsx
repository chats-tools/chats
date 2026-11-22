import type { ClientModule } from 'claude-code'

// chats-panel: one chat line of the panel that opens its chat on a click.
// A surface module (drawn by <Client module="./chatline.tsx"> in register.tsx). It draws the same
// styled Text as the panel's plain lines (dim time, orange / bold title, dim project) and listens to the
// pointer itself: a click posts the chat's link to register.tsx, whose ui.message hook opens it.
// Why: a Button drops the text style on the desktop, and the desktop ignores a claude:// Link.
//
// A surface module draws only Box, Text, Button, Input and Select (ClientElements: the terminal's
// table, no Svg). So register.tsx draws the dot as an Svg before this Client (`showDot: false`).
export type ChatLineProps = {
  link: string
  /** "3m | " for a resting chat; not shown for a working one */
  when: string
  isWorking: boolean
  title: string
  /** " | Project" or "" */
  where: string
  isBold: boolean
  isImportant: boolean
  /** false: no "⦁" letter; register.tsx draws the dot. Absent: true. */
  showDot?: boolean
}

// The mouse cursor. The mod API has no cursor setting: the only "cursor" in its types is the text
// caret of the prompt box, and a Client gets pointer events but cannot style the pointer.
// A Link around the text (for the hand cursor) makes the desktop refuse every line. Its log
// (~/Library/Logs/Claude/claude.ai-web.log) says why: "returned a tree the page cannot draw
// (malformed, past its bounds, or with a tag it does not take: draw with Box, Text, Button,
// Input, Select and Svg)". So a Client on the desktop must never draw a Link (or Markdown, Code).
//
// Hover: the row's background turns a see-through gray while the pointer is over it, as the
// Claude app's own sidebar rows do (light and dark theme). The module keeps "is the pointer over
// me" itself (enter / move / leave events); a Text `hover` is refused outside a keyed Box.
const HOVER_GRAY = '#80808033'

type Over = { isOver: boolean }

const ChatLine: ClientModule<ChatLineProps, Over> = (p, s) => {
  const { Box, Text } = s.elements
  const isOver = s.state?.isOver === true
  const dot = p.showDot !== false
  const setOver = (v: boolean) => {
    if ((s.state?.isOver === true) !== v) s.setState({ isOver: v })
  }
  // Set again on every draw (a later call replaces the listener), so it holds this line's link.
  // Both "down" and "up" are posted: register.tsx opens on the first and skips the second.
  s.onPointer(e => {
    if ((e.type === 'down' || e.type === 'up') && (e.button === undefined || e.button === 'left')) {
      s.post({ open: p.link, type: e.type })
    }
    if (e.type === 'leave') setOver(false)
    else if (e.type === 'enter' || e.type === 'move') setOver(true)
  })
  const bg = isOver ? { backgroundColor: HOVER_GRAY } : {}
  return (
    <Box {...bg}>
    <Text wrap="truncate-end">
      {p.isWorking ? (
        dot ? (
          <Text color="success">
            ⦁{' '}
          </Text>
        ) : (
          ''
        )
      ) : (
        <Text dimColor>
          {dot ? `⦁ ${p.when}` : p.when}
        </Text>
      )}
      <Text bold={p.isBold} color={p.isImportant ? 'warning' : undefined}>
        {p.title}
      </Text>
      <Text dimColor>
        {p.where}
      </Text>
    </Text>
    </Box>
  )
}

export default ChatLine
