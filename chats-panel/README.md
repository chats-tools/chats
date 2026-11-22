# chats-panel (for maintainers)

This is a Claude Code mod. It adds a "Chats" panel to the Claude desktop app.

The slash command is `/chats`. The `COMMAND` constant at the top of `hooks/register.tsx` sets the name.

Install:

```
/plugin install chats-panel --marketplace chats-tools/chats
```

For use, read the [main README](../README.md). This file is for people who change the code.

**The /chats panel works only in Claude Code (not in Cowork). You can float it in its own window with "Open in / New window".**

## What the panel shows

- **Usage bars** in the style of the Claude app. The name is on the left. Text like "23% · Resets 3h" is on the right. A thin bar is below. The bar is blue. It turns yellow from 70% and red from 90%. The bars are: 5-hour limit, Weekly · all models, and Weekly · Fable (only when your plan has that limit).
- **A context bar** for the Code chat on screen ("Context · <title>"). It has colored parts for the chat that opened the panel. It is hidden when a Cowork chat is on screen.
- **Working now, My groups, Recent chats** (Recent, No project, Code) and **Cowork Projects**.
- **One line for each chat.** A state dot (green is working, gray is idle with its time). The title. Then "| project | Cowork", or "| Code". Runs of scheduled tasks end with "| Scheduled". A click on the line opens the chat. The row under the pointer turns gray.
- **A gear (⚙)** after each chat, after "My groups", after "Cowork Projects" and after a picked group. It opens a floating card of plain buttons: move to a group, new group, Bold, Important, Edit groups (Rename and Delete), and show or hide projects.
- **Delete** asks "are you sure". It has a 20-second Undo next to "My groups". Esc closes a card.
- **Bold and Important** (orange) marks. A chat title can also start with `***` or `!` to set them.
- **A legend** at the bottom.

After `/reload-plugins`, the panel comes back by itself.

## Files

| File | What it does |
| --- | --- |
| `hooks/register.tsx` | The panel. |
| `hooks/appcache.ts` | The reader of the saved copy of the Claude app. |
| `hooks/chatline.tsx` | A Client. It draws one clickable, styled chat line. |
| `hooks/demo.ts` | Demo mode. |
| `hooks/hooks.json` | The list of modules. |
| `types/index.d.ts` | The state contract. |
| `tests/pane.test.tsx` | Draws the pane in several states. |
| `demo/demo.json` | Made-up chats for demo mode. ChatsBar uses the same file. |

## Checks

Run these before every reload. Run them from the repo root.

```
claude plugin test chats-panel
tsc -p chats-panel
claude plugin validate chats-panel --profile directory
```

`tsc -p chats-panel` uses the engine types. The engine writes them to `chats-panel/.claude-plugin/types` once the mod has loaded. Git ignores this folder.

## Develop

Load the mod from the folder:

```
claude --plugin-dir ./chats-panel
```

You can also use a local marketplace:

```
claude plugin marketplace add <repo folder>
```

## Lessons

Keep these in mind. Each one cost time.

- No drag and drop. No right-click on pane elements. No pop-up menu element. No dialog. No setting for the mouse cursor. No reading of light or dark mode. The colors of the cards are fixed dark (`POPUP_BG`).
- A Button holds only text. An Svg in a Button makes the whole pane fail ("can't display"). Draw the Svg in a Box, and put a clear Button over it. `claude plugin test` shows this error. The app logs do not.
- Text inside a Button loses its style.
- A `claude://` Link in a pane does nothing. A whole chat line opens through a Client (`chatline.tsx`). The Client posts the link to the mod. The mod opens it only if that chat is in its current list.
- A desktop Client draws only Box, Text, Button, Input and Select. Never put a Link or an Svg in a Client. Refusals show in `~/Library/Logs/Claude/claude.ai-web.log` ("Client instance unmounted"). The `ui.fault` hook writes them to the debug log.
- A Client sits on its own layer above an absolute Box. While a floating card is open, the lines are drawn as plain text.
- A drawn Svg also sits above an absolute Box. While a card is open, every other gear is the ⚙ letter and every dot is the "⦁" letter. Only the open card's own gear stays drawn. `tests/cards.test.tsx` checks this for each card.
- A Select always shows and ticks one of its lines as its face. This is confusing. For this reason the panel uses the floating ⚙ cards.
- A Box with `overflowX="scroll"` forces a wide monospace font. Never use it.
- Esc reaches the panel only as a close of the whole pane. Esc closes a whole card, not one step.
- Never read a local time with no zone with the Date of the mod. The times in the VM log are Mac local time. The mod takes the zone offset from the log itself.
- Some fallbacks are there on purpose:
  - A surface with no Client gets an "↗" button.
  - With no Svg, the gear is the ⚙ letter, the dot is "⦁", and the bars are ■□ squares.
  - With no readable saved copy, Cowork chats come from the session files (with no projects).

## Reader rules

`hooks/appcache.ts` and `../chatsbar/chats.py` must keep the same rules. If you change one, change the other.

- The saved copy can stop updating. After 15 minutes, an orange warning shows.
- Running state comes from VM tool steps in `cowork_vm_node.log`. A step under 5 minutes old means working. The last_settled_at value of the list ends it early.
- An agent that still runs counts as working. This means an open Task or Agent step that is under 6 hours old.
- A deleted Cowork task has a `clearRemoteSessionFolderGrants` line in `main.log`. The line is at or after the last step of the task.
- A renamed project is followed by its id (`projectIds`).
- Runs of scheduled tasks have no project. They end with "| Scheduled".
- The Code chat on screen comes from `LocalSessions.setFocusedSession` in `main.log`.
- Each list shows at most 12 chats. The constant is `TAB_COUNT` in both readers.

## Shared files

The panel and ChatsBar share `marks.json`, `groups.json` and `settings.json` in `~/Library/Application Support/ChatsBar/`. They also share `~/Library/Caches/ChatsBar/refresh-signal`. The [main README](../README.md) describes the formats.
