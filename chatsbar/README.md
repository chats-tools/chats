# ChatsBar (for maintainers)

ChatsBar is a macOS menu bar app. It shows your Claude chats in a small window.

For install and use, read the [main README](../README.md). This file is for people who change the code.

## What it is

- The icon is drawn with AppKit. It shows ▶N when N chats work.
- The window is a SwiftUI view in an NSPopover.
- `chats.py` reads the data. It is a Python 3.9 script that uses only the standard library. The app runs it with `/usr/bin/python3`.
- The labels and rules are the same as in the panel. Both come from the same reader rules.

## Files

| File | What it does |
| --- | --- |
| `ChatsBar.swift` | The app: icon, window, groups, drag and drop. |
| `chats.py` | The reader. It prints JSON. |
| `build.sh` | Builds `~/Applications/ChatsBar.app`. |

The build also copies `../chats-panel/demo/demo.json` into the app. Build from the full repo folder.

## Groups

A chat can be in more than one group.

- Right-click a chat, then Groups. A ✓ shows on each group the chat is in. A click puts it in that group or takes it out. Its other groups stay.
- A drop on a group adds the chat to it. It stays in its other groups.
- Each time the window opens, all groups are closed (`Model.opened`, reset in `showPopover`). A click opens or closes a group. A drop on a group opens it.
- In a group box, right-click a chat, then "Take out of" takes it out of that group only. "Take out of all groups" takes it out of all of them.
- `groups.json` keeps its shape. `/chats` uses the same rules (`../chats-panel/hooks/groups.ts`).

## Build

You need the Command Line Tools only. You do not need Xcode.

```
zsh build.sh
```

The script:

1. Builds the app with `swiftc`.
2. Copies `chats.py` and the demo data into the app.
3. Writes `Info.plist`, with the `chatsbar://` link.
4. Signs the app with an ad-hoc signature.
5. Puts the app in `~/Applications/ChatsBar.app`.

## After you change chats.py

1. Run `zsh build.sh`.
2. Quit the app and open it again.
3. Check that the app has your copy:

   ```
   cmp chats.py ~/Applications/ChatsBar.app/Contents/Resources/chats.py
   ```

   No output means the files are equal.

## Run the reader alone

```
/usr/bin/python3 -I chats.py
```

It prints JSON. Set `CHATSBAR_DEMO=1` to read the demo data.

## Lessons

- There is no Xcode. SwiftUI macros (`@State`, `@FocusState`) do not build. Keep state in an `ObservableObject`.
- Give the popover a fixed size. If you do not, it opens above the screen.
- The window size is kept in the defaults of the app (`defaults read io.github.chatsbar`).
- The reader rules are the same as in the panel. They are in [`../chats-panel/README.md`](../chats-panel/README.md), under "Reader rules". If you change a rule in `chats.py`, change it in `hooks/appcache.ts` too.
