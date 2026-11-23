# chats-panel (for maintainers)

This is a Claude Code mod. It adds a "Chats" panel to the Claude desktop app.

The slash command is `/chats`. The `COMMAND` constant at the top of `hooks/register.tsx` sets the name.

Install:

```
/plugin install chats-panel --marketplace toolsmith-lab/chats
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
- **A legend** at the bottom, then the version of the code that draws the panel ("/chats v0.12.4"), read from `.claude-plugin/plugin.json`.

After `/reload-plugins`, the panel comes back by itself.

Each open Code chat runs its own copy of the mod, loaded when the chat starts. `/reload-plugins` loads the new code only in the chat where you type it. The panel can be drawn by another open chat that still has old code. Check the version on the panel's last line. If it is old, close the other chats, or quit and reopen the Claude app.

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

On 2026-11-23 this folder was missing, also after `/reload-plugins` from this Google Drive folder. A headless `claude -p --plugin-dir` load needs a valid login. Without the folder, tsc gives only "cannot find module 'claude-code'" errors and the errors that come from them. Then say that tsc did not run. Do not count it as a pass. Without the types file, tsc also has no `noEmit` setting, so it writes `.js` files next to the sources. Delete them after the run (see "Two traps" below), or run `tsc -p chats-panel --noEmit`.

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
- A drawn Svg also sits above an absolute Box. While a card is open, every dot is the "●" letter, and a title gear (after My groups, Cowork Projects or a group's name) is left out unless its card is the open one. Chat-line gears stay drawn: they sit in cells 0-1, and every card starts at cell 3 (`POPUP_LEFT`). Do not draw a ⚙ letter in a gear's 2-cell box: it is cut in half. `tests/cards.test.tsx` checks this for each card.
- A chat's card opens upward when it is taller than the rows under its line (`cardRows`, `ROWS_UNDER_LIST`). Else the end of the panel cuts it off.
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
- One Cowork task can come in two forms. The sidebar list can hold a short form with no `workspace_session_id`, so it looks like a plain chat. A project page holds the full form. The reader keeps the task id for the chat's uuid, and merges the two into one Cowork line. `tests/dedupe.test.tsx` checks this.

## Shared files

The panel and ChatsBar share `marks.json`, `groups.json` and `settings.json` in `~/Library/Application Support/ChatsBar/`. They also share `~/Library/Caches/ChatsBar/refresh-signal`. The [main README](../README.md) describes the formats.

## Release steps

1. Make the change in this repo, never in a private copy.
2. Bump `version` in `.claude-plugin/plugin.json`.
3. Run the checks: `claude plugin test chats-panel`, tsc, `claude plugin validate chats-panel --profile directory`, and `zsh scripts/privacy-check.sh`.
4. Test on your Mac: `/reload-plugins`, then `/chats`. For a ChatsBar change: `zsh build.sh` in `chatsbar/`, then quit and reopen ChatsBar.
5. Commit and `git push`. The pre-push hook runs the privacy check again and blocks the push on any hit.

Two traps:
- Never leave compiled `.js` files next to the `.ts` and `.tsx` sources. An import such as `./appcache` can then load an old `.js` copy, not the real code. `.gitignore` ignores them, but delete them too.
- Screenshots only from demo mode, cropped to the panel or the ChatsBar window, so no real chat shows. `scripts/make-demo-gif.swift` turns them into `docs/images/demo.gif`.
