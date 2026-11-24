// ChatsBar: a menu bar icon that lists Claude desktop chats (Cowork projects, No project, Code).
// It runs chats.py (bundled in the app) every 20 seconds and when the window opens.
// A click on a chat opens it in the Claude app through its claude:// link. No network, no tokens.
//
// The window is a popover under the icon, where you can drag chats into groups.
// The /chats panel opens the same window with: open "chatsbar://organize"
//
// Demo mode (screenshots, or to try the app without data): when the file
// ~/Library/Application Support/ChatsBar/demo-mode exists, or CHATSBAR_DEMO=1 is set, chats.py
// shows made-up chats, this app keeps its files in the "demo" folder, and a click on a chat opens
// nothing. There is no switch in the window; the file is the switch.
import AppKit
import SwiftUI

struct Item: Decodable, Identifiable, Hashable {
  let title: String
  let link: String
  let working: Bool
  let bold: Bool?
  let important: Bool?
  let key: String?
  var id: String { link }
  var chatKey: String { key ?? Store.chatKey(link) }
}
struct TabList: Decodable { let name: String; let items: [Item] }
struct Project: Decodable { let name: String; let rtl: Bool; let link: String?; let items: [Item] }
struct ChatGroup: Decodable, Identifiable { let id: String; let name: String; let at: Double?; let items: [Item] }
/// Every Cowork project, shown or hidden, for the Projects setup screen.
struct ProjectPick: Decodable { let name: String; let rtl: Bool; let hidden: Bool }
struct Snapshot: Decodable {
  let working: [Item]
  let recent: [TabList]
  let projects: [Project]
  let groups: [ChatGroup]?
  let allProjects: [ProjectPick]?
  let cacheAge: String?
  let staleWarning: String?
  let error: String?
}

// ---------- shared files: marks and groups ----------
// Both files are shared with every /chats panel. Each write reads the file first (the other view
// may have changed it), then sends the refresh signal so all views redraw together.
enum Store {
  static let root = NSHomeDirectory() + "/Library/Application Support/ChatsBar"
  /// Same test as chats.py: the file demo-mode in the data folder, or CHATSBAR_DEMO=1.
  static let isDemo = FileManager.default.fileExists(atPath: root + "/demo-mode")
    || ProcessInfo.processInfo.environment["CHATSBAR_DEMO"] == "1"
  /// In demo mode every file lives in the "demo" folder, so real data is never touched.
  static let dir = isDemo ? root + "/demo" : root
  static let marksPath = dir + "/marks.json"
  static let groupsPath = dir + "/groups.json"
  static let settingsPath = dir + "/settings.json"

  /// Project setup: {"hiddenProjects": ["exact name", ...]}. With no key yet, the first pick
  /// starts from what is hidden now (nothing, unless settings.json says so), so nothing jumps.
  static func setShown(_ name: String, _ isShown: Bool, all: [ProjectPick]) {
    var o = readJSON(settingsPath)
    var hidden = (o["hiddenProjects"] as? [String]) ?? all.filter { $0.hidden }.map { $0.name }
    hidden.removeAll { $0 == name }
    if !isShown { hidden.append(name) }
    o["hiddenProjects"] = hidden
    writeJSON(settingsPath, o)
  }

  static func chatKey(_ link: String) -> String {
    (link.split(separator: "/").last.map(String.init) ?? link).lowercased()
  }

  static func readJSON(_ path: String) -> [String: Any] {
    guard let d = FileManager.default.contents(atPath: path),
          let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
    return o
  }

  static func writeJSON(_ path: String, _ o: [String: Any]) {
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    if let d = try? JSONSerialization.data(withJSONObject: o, options: [.prettyPrinted, .sortedKeys]) {
      try? d.write(to: URL(fileURLWithPath: path), options: .atomic)
    }
  }

  // Marks: {"<chat key>": {"bold": true, "important": true}}
  static func readMarks() -> [String: [String: Bool]] {
    var out: [String: [String: Bool]] = [:]
    for (k, v) in readJSON(marksPath) { if let m = v as? [String: Any] { out[k] = m.compactMapValues { $0 as? Bool } } }
    return out
  }

  static func toggleMark(_ key: String, _ which: String) {
    var all = readMarks()
    var m = all[key] ?? [:]
    m[which] = !(m[which] ?? false)
    m = m.filter { $0.value }
    if m.isEmpty { all.removeValue(forKey: key) } else { all[key] = m }
    writeJSON(marksPath, all)
  }

  // Groups: {"groups": [{"id": "g-<ms>", "name": "...", "chats": ["<chat key>", ...]}]}
  static func readGroups() -> (all: [String: Any], groups: [[String: Any]]) {
    let o = readJSON(groupsPath)
    return (o, (o["groups"] as? [[String: Any]]) ?? [])
  }

  static func saveGroups(_ o: [String: Any], _ g: [[String: Any]]) {
    var o = o
    o["groups"] = g
    writeJSON(groupsPath, o)
  }

  // A chat can be in more than one group. Each of these changes one group and keeps the chat
  // in its other groups. Same rules in /chats (chats-panel/hooks/groups.ts).
  private static func change(_ fn: (String?, [String]) -> [String]) {
    let (o, gs) = readGroups()
    saveGroups(o, gs.map { g in
      var g = g
      g["chats"] = fn(g["id"] as? String, (g["chats"] as? [String]) ?? [])
      return g
    })
  }

  /// Puts the chat at the top of the group. Its other groups stay.
  static func add(_ key: String, to gid: String) {
    change { id, ks in id == gid && !ks.contains(key) ? [key] + ks : ks }
  }

  /// Takes the chat out of this group only.
  static func remove(_ key: String, from gid: String) {
    change { id, ks in id == gid ? ks.filter { $0 != key } : ks }
  }

  /// Takes the chat out of every group.
  static func removeAll(_ key: String) {
    change { _, ks in ks.filter { $0 != key } }
  }

  /// A new group, with one chat in it when a chat was dropped on "New group". Returns its id.
  static func newGroup(with key: String?) -> String {
    let id = "g-\(Int(Date().timeIntervalSince1970 * 1000))"
    let (o, gs) = readGroups()
    saveGroups(o, gs + [["id": id, "name": "New group", "chats": [String]()]])
    if let key = key { add(key, to: id) }
    return id
  }

  static func rename(_ gid: String, _ name: String) {
    let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !n.isEmpty else { return }
    let (o, gs) = readGroups()
    saveGroups(o, gs.map { g in var g = g; if g["id"] as? String == gid { g["name"] = n }; return g })
  }

  /// Deletes the group only. Its chats stay where they are, in their projects.
  /// Returns the deleted group and its place, so Undo can put it back.
  @discardableResult
  static func delete(_ gid: String) -> (group: [String: Any], index: Int)? {
    let (o, gs) = readGroups()
    guard let i = gs.firstIndex(where: { $0["id"] as? String == gid }) else { return nil }
    saveGroups(o, gs.filter { $0["id"] as? String != gid })
    return (gs[i], i)
  }

  /// Undo of a delete: puts the group back in its old place, with its chats.
  static func restore(_ g: [String: Any], at i: Int) {
    let (o, gs) = readGroups()
    guard !gs.contains(where: { $0["id"] as? String == g["id"] as? String }) else { return }
    var out = gs
    out.insert(g, at: min(i, out.count))
    saveGroups(o, out)
  }
}

// ---------- the window's data ----------

struct UndoDelete {
  let id = UUID()
  let group: [String: Any]
  let index: Int
  let name: String
}

final class Model: ObservableObject {
  @Published var snap: Snapshot?
  @Published var lastError: String?
  @Published var marks: [String: [String: Bool]] = [:]
  /// Only the three fixed tabs are saved. A project name is private, so it is never written to disk.
  static let savedTabs = ["Recent", "No project", "Code"]
  @Published var tab: String = Model.savedTab() {
    didSet { if Model.savedTabs.contains(tab) { UserDefaults.standard.set(tab, forKey: "tab") } }
  }
  /// Which groups are open. All groups are closed each time the window opens; a click opens one.
  /// Kept in memory only: group ids are not written to disk.
  @Published var opened: Set<String> = []

  static func savedTab() -> String {
    let d = UserDefaults.standard
    d.removeObject(forKey: "collapsed")  // an older version saved group ids here
    if let t = d.string(forKey: "tab"), savedTabs.contains(t) { return t }
    d.removeObject(forKey: "tab")  // an older version could save a project name here
    return "Recent"
  }
  /// The group whose name is being typed, and the text typed so far.
  @Published var editing: String?
  @Published var draft = ""
  /// The Projects setup screen is open in place of the lists.
  @Published var isSetup = false
  /// What the pointer is over, and which group a drag is over. Kept here, not in @State: the
  /// Command Line Tools have no SwiftUI macros (they need Xcode), so @State cannot build.
  @Published var hover: String?
  @Published var target: String?
  /// The window's size. You set it with the corner handle; it is kept.
  /// The height is never more than the screen's free height less 40: a popover that does not fit
  /// below the icon opens above it, off the screen (seen on a small screen).
  @Published var width: CGFloat = CGFloat(UserDefaults.standard.object(forKey: "width") as? Double ?? 420)
  @Published var height: CGFloat = CGFloat(UserDefaults.standard.object(forKey: "height") as? Double ?? 640)
  /// A short note in the footer (demo mode: demo chats cannot be opened). Clears itself.
  @Published var note: String?
  weak var app: AppDelegate?

  func showNote(_ text: String) {
    note = text
    DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
      if self?.note == text { self?.note = nil }
    }
  }

  var groups: [ChatGroup] { snap?.groups ?? [] }

  /// Every group the chat is in. A chat can be in more than one group.
  func groupsOf(_ key: String) -> [ChatGroup] {
    groups.filter { g in g.items.contains { $0.chatKey == key } }
  }

  /// Every write: save, then read again at once and tell the /chats panels.
  func changed() { app?.refreshNow() }

  /// In the group: out. Not in it: in. Its other groups stay.
  func toggle(_ key: String, in gid: String) {
    if groupsOf(key).contains(where: { $0.id == gid }) { Store.remove(key, from: gid) } else { Store.add(key, to: gid) }
    changed()
  }

  func remove(_ key: String, from gid: String) { Store.remove(key, from: gid); changed() }

  func removeAll(_ key: String) { Store.removeAll(key); changed() }

  func newGroup(with key: String?) {
    let id = Store.newGroup(with: key)
    opened.insert(id)
    startRename(id, "New group")
    changed()
  }

  func startRename(_ gid: String, _ name: String) { draft = name; editing = gid }

  func finishRename() {
    if let gid = editing { Store.rename(gid, draft) }
    editing = nil
    changed()
  }

  /// Delete asks first (same as /chats). After a delete, "Undo" shows next to "My groups" for 20 s.
  @Published var confirming: String?
  @Published var undo: UndoDelete?
  static let undoSeconds: Double = 20

  /// A real macOS dialog, because a small row in the list is easy to miss.
  /// Esc or Cancel keeps the group. After it, the window opens again so Undo shows.
  func askDelete(_ gid: String) {
    editing = nil
    let name = groups.first { $0.id == gid }?.name ?? "this group"
    DispatchQueue.main.async { [weak self] in
      let a = NSAlert()
      a.messageText = "Delete group \"\(name)\"?"
      a.informativeText = "Its chats stay in their projects. You can undo for 20 seconds."
      a.alertStyle = .warning
      let del = a.addButton(withTitle: "Delete")
      del.hasDestructiveAction = true
      a.addButton(withTitle: "Cancel").keyEquivalent = "\u{1b}"
      NSApp.activate(ignoringOtherApps: true)
      let r = a.runModal()
      if r == .alertFirstButtonReturn { self?.delete(gid) }
      self?.app?.showPopover()
    }
  }

  func delete(_ gid: String) {
    confirming = nil
    guard let d = Store.delete(gid) else { changed(); return }
    let u = UndoDelete(group: d.group, index: d.index, name: d.group["name"] as? String ?? "group")
    undo = u
    DispatchQueue.main.asyncAfter(deadline: .now() + Model.undoSeconds) { [weak self] in
      if self?.undo?.id == u.id { self?.undo = nil }
    }
    changed()
  }

  func undoDelete() {
    guard let u = undo else { return }
    undo = nil
    Store.restore(u.group, at: u.index)
    opened.insert(u.group["id"] as? String ?? "")
    changed()
  }

  func toggleMark(_ key: String, _ which: String) { Store.toggleMark(key, which); changed() }

  func setShown(_ name: String, _ isShown: Bool) {
    Store.setShown(name, isShown, all: snap?.allProjects ?? [])
    changed()
  }
}

// ---------- the window ----------

struct ChatRow: View {
  let c: Item
  @ObservedObject var model: Model
  /// The group box this line is shown in (nil: a list, not a group).
  var group: ChatGroup? = nil

  var body: some View {
    // One chat can show in several groups: the hover key holds the group too.
    let hoverKey = (group?.id ?? "") + "|" + c.id
    let isHover = model.hover == hoverKey
    let saved = model.marks[c.chatKey] ?? [:]
    let inGroups = model.groupsOf(c.chatKey)
    Text(c.title)
      .fontWeight(c.bold == true ? .bold : .regular)
      .lineLimit(1)
      .truncationMode(.tail)
      // Marks: Important is orange (it wins over the green of a working chat; ▶ still
      // says it works). Bold is a bold font. Same look as the /chats panel.
      .foregroundColor(c.important == true ? .orange : c.working ? .green : .primary)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 3)
      .padding(.horizontal, 6)
      .background(RoundedRectangle(cornerRadius: 5).fill(isHover ? Color.accentColor.opacity(0.18) : Color.clear))
      .contentShape(Rectangle())
      .onHover { on in if on { model.hover = hoverKey } else if model.hover == hoverKey { model.hover = nil } }
      .onTapGesture { model.app?.openLink(c.link) }
      .help("Click to open. Drag onto a group. Right-click for more.")
      .draggable(c.chatKey) {
        Text(c.title).lineLimit(1).padding(6).background(.regularMaterial).cornerRadius(6)
      }
      .contextMenu {
        // A chat can be in more than one group: ✓ on each group it is in. A click puts it in
        // that group or takes it out. Its other groups stay. Same as the /chats chat card.
        Menu("Groups") {
          ForEach(model.groups) { g in
            let isIn = inGroups.contains { $0.id == g.id }
            Button(isIn ? "✓ \(g.name)" : g.name) { model.toggle(c.chatKey, in: g.id) }
          }
          if !model.groups.isEmpty { Divider() }
          Button("New group…") { model.newGroup(with: c.chatKey) }
        }
        if let g = group {
          Button("Take out of \"\(g.name)\"") { model.remove(c.chatKey, from: g.id) }
        }
        if inGroups.count > 1 || (group == nil && !inGroups.isEmpty) {
          Button("Take out of all groups") { model.removeAll(c.chatKey) }
        }
        Divider()
        Button(saved["bold"] == true ? "✓ Bold" : "Bold") { model.toggleMark(c.chatKey, "bold") }
        Button(saved["important"] == true ? "✓ Important (orange)" : "Important (orange)") {
          model.toggleMark(c.chatKey, "important")
        }
      }
  }
}

func agoText(_ ms: Double?) -> String {
  guard let ms = ms, ms > 0 else { return "" }
  let m = Int((Date().timeIntervalSince1970 * 1000 - ms) / 60000)
  if m < 1 { return "now" }
  if m < 60 { return "\(m)m" }
  let h = Int((Double(m) / 60).rounded())
  return h < 48 ? "\(h)h" : "\(Int((Double(h) / 24).rounded()))d"
}

struct GroupBox: View {
  let g: ChatGroup
  @ObservedObject var model: Model

  var body: some View {
    let isTarget = model.target == g.id
    let isOpen = model.opened.contains(g.id)
    VStack(alignment: .leading, spacing: 1) {
      HStack(spacing: 6) {
        Image(systemName: isOpen ? "chevron.down" : "chevron.right")
          .frame(width: 14)
          .foregroundColor(.secondary)
        if model.editing == g.id {
          NameField(text: $model.draft, onDone: { model.finishRename() }, onCancel: { model.editing = nil })
        } else {
          Text(g.name).fontWeight(.semibold).lineLimit(1)
        }
        Spacer(minLength: 4)
        Text("\(g.items.count)" + (g.items.isEmpty ? "" : " · \(agoText(g.at))"))
          .foregroundColor(.secondary)
          .font(.caption)
      }
      .padding(.vertical, 5)
      .padding(.horizontal, 6)
      .background(RoundedRectangle(cornerRadius: 6).fill(isTarget ? Color.accentColor.opacity(0.35) : Color.secondary.opacity(0.13)))
      .contentShape(Rectangle())
      // A click folds or unfolds the group. A double-click renames it.
      .gesture(TapGesture(count: 2).onEnded { model.startRename(g.id, g.name) }
        .exclusively(before: TapGesture().onEnded {
          if model.opened.contains(g.id) { model.opened.remove(g.id) } else { model.opened.insert(g.id) }
        }))
      .contextMenu {
        Button("Rename…") { model.startRename(g.id, g.name) }
        Button("Delete group…") { model.askDelete(g.id) }
      }
      if isOpen {
        if g.items.isEmpty {
          Text("Drag chats here").foregroundColor(.secondary).font(.caption).padding(.leading, 26).padding(.vertical, 3)
        }
        ForEach(g.items) { c in ChatRow(c: c, model: model, group: g).padding(.leading, 18) }
      }
    }
    // A drop puts the chat in this group too. It stays in its other groups.
    .dropDestination(for: String.self) { keys, _ in
      for k in keys { Store.add(k, to: g.id) }
      model.opened.insert(g.id)
      model.changed()
      return true
    } isTargeted: { on in if on { model.target = g.id } else if model.target == g.id { model.target = nil } }
  }
}

/// The group name box: a plain AppKit text field that takes the typing at once (SwiftUI's
/// focus tools are macros, which do not build here). Enter saves, Esc cancels.
struct NameField: NSViewRepresentable {
  @Binding var text: String
  let onDone: () -> Void
  let onCancel: () -> Void

  final class Field: NSTextField {
    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      DispatchQueue.main.async { [weak self] in
        guard let self = self, let w = self.window else { return }
        w.makeKey()
        w.makeFirstResponder(self)
        self.currentEditor()?.selectAll(nil)
      }
    }
  }

  final class Coordinator: NSObject, NSTextFieldDelegate {
    var parent: NameField
    var isDone = false
    init(_ p: NameField) { parent = p }
    func controlTextDidChange(_ n: Notification) {
      if let f = n.object as? NSTextField { parent.text = f.stringValue }
    }
    func control(_ c: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
      if sel == #selector(NSResponder.insertNewline(_:)) { isDone = true; parent.onDone(); return true }
      if sel == #selector(NSResponder.cancelOperation(_:)) { isDone = true; parent.onCancel(); return true }
      return false
    }
    // A click elsewhere also saves the name.
    func controlTextDidEndEditing(_ n: Notification) {
      if !isDone { isDone = true; parent.onDone() }
    }
  }

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeNSView(context: Context) -> NSTextField {
    let f = Field(string: text)
    f.delegate = context.coordinator
    f.bezelStyle = .roundedBezel
    f.placeholderString = "Group name"
    return f
  }

  func updateNSView(_ f: NSTextField, context: Context) {
    context.coordinator.parent = self
    if f.currentEditor() == nil && f.stringValue != text { f.stringValue = text }
  }
}

struct NewGroupTarget: View {
  @ObservedObject var model: Model

  var body: some View {
    let isTarget = model.target == "new"
    return Text(isTarget ? "Drop to make a new group" : "+ New group (click, or drop a chat here)")
      .foregroundColor(.secondary)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 5)
      .padding(.horizontal, 8)
      .background(RoundedRectangle(cornerRadius: 6)
        .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4]))
        .foregroundColor(isTarget ? .accentColor : .secondary.opacity(0.5)))
      .contentShape(Rectangle())
      .onTapGesture { model.newGroup(with: nil) }
      .dropDestination(for: String.self) { keys, _ in
        guard let first = keys.first else { return false }
        model.newGroup(with: first)
        return true
      } isTargeted: { on in if on { model.target = "new" } else if model.target == "new" { model.target = nil } }
  }
}

/// The corner handle: drag it to make the window wider, narrower, taller or shorter.
/// It follows the pointer on the screen, not inside the window, because the window moves as it
/// grows (a popover stays centered under its icon).
struct ResizeGrip: View {
  @ObservedObject var model: Model

  var body: some View {
    Image(systemName: "arrow.up.left.and.arrow.down.right")
      .font(.system(size: 12, weight: .semibold))
      .foregroundColor(.secondary)
      .frame(width: 22, height: 22)
      .contentShape(Rectangle())
      .help("Drag to resize the window")
      .gesture(DragGesture(minimumDistance: 1)
        .onChanged { _ in model.app?.resizeDrag() }
        .onEnded { _ in model.app?.resizeEnd() })
  }
}

struct Header: View {
  let text: String
  var body: some View {
    Text(text).font(.headline).padding(.top, 6)
  }
}

struct Root: View {
  @ObservedObject var model: Model

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ScrollView {
        VStack(alignment: .leading, spacing: 4) {
          content
        }
        .padding(12)
      }
      Divider()
      footer.padding(.horizontal, 12).padding(.vertical, 8)
    }
    .frame(width: model.width, height: model.height)
  }

  /// Projects setup: tick the Cowork projects to show in the lists.
  @ViewBuilder var setup: some View {
    Header(text: "Projects to show")
    Text("Tick the Cowork projects you want in the lists. A new project shows until you untick it. The /chats panel uses the same choice.")
      .font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
    ForEach(model.snap?.allProjects ?? [], id: \.name) { p in
      Toggle(isOn: Binding(get: { !p.hidden }, set: { model.setShown(p.name, $0) })) {
        Text(p.name).lineLimit(1)
      }
      .toggleStyle(.checkbox)
      .padding(.vertical, 2)
    }
    if (model.snap?.allProjects ?? []).isEmpty {
      Text("No projects found in the app's saved copy.").foregroundColor(.secondary)
    }
    Button("Done") { model.isSetup = false }.keyboardShortcut(.defaultAction).padding(.top, 8)
  }

  @ViewBuilder var content: some View {
    if model.isSetup {
      setup
    } else if let s = model.snap {
      if let w = s.staleWarning {
        // Orange: you must see it before trusting the lists below. A click refreshes.
        Text("⚠︎ " + w).foregroundColor(.orange).fixedSize(horizontal: false, vertical: true)
          .onTapGesture { model.app?.refreshNow() }
        Divider()
      }
      Header(text: "Working now (\(s.working.count))")
      if s.working.isEmpty { Text("nothing running").foregroundColor(.secondary) }
      ForEach(s.working) { c in ChatRow(c: c, model: model) }

      HStack {
        Header(text: "My groups")
        Spacer()
        if let u = model.undo {
          Button("Undo delete \"\(u.name)\"") { model.undoDelete() }
            .padding(.top, 6)
            .help("Puts the group back. Shows for 20 seconds.")
        }
      }
      Text("Drag a chat onto a group. Double-click a group name to rename it. Right-click for more.")
        .font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
      ForEach(model.groups) { g in GroupBox(g: g, model: model) }
      NewGroupTarget(model: model)

      let tabs: [(String, [Item])] = s.recent.map { ($0.name, $0.items) } + s.projects.map { ($0.name, $0.items) }
      let selected = tabs.contains { $0.0 == model.tab } ? model.tab : "Recent"
      HStack {
        Header(text: "Chats")
        Spacer()
        Picker("", selection: $model.tab) {
          ForEach(tabs.map { $0.0 }, id: \.self) { Text($0).tag($0) }
        }
        .pickerStyle(.menu)
        .frame(maxWidth: 220)
        .padding(.top, 6)
      }
      let items = tabs.first { $0.0 == selected }?.1 ?? []
      if items.isEmpty { Text("no recent chats in the app's saved copy").foregroundColor(.secondary) }
      ForEach(items) { c in ChatRow(c: c, model: model) }
      if let link = s.projects.first(where: { $0.name == selected })?.link {
        Text("↗ Open the project page for all its chats")
          .foregroundColor(.secondary).padding(.vertical, 3).padding(.horizontal, 6)
          .contentShape(Rectangle())
          .onTapGesture { model.app?.openLink(link) }
      }
    } else {
      Text(model.lastError.map { "Error: \($0)" } ?? "Loading…").foregroundColor(.secondary)
    }
  }

  var footer: some View {
    HStack {
      if Store.isDemo {
        Text("Demo").font(.caption).fontWeight(.semibold).foregroundColor(.secondary)
          .padding(.horizontal, 6).padding(.vertical, 1)
          .background(Capsule().strokeBorder(Color.secondary.opacity(0.6), lineWidth: 1))
          .help("Demo mode: made-up chats. Delete the file demo-mode in the ChatsBar folder to leave it.")
      }
      if let n = model.note {
        Text(n).foregroundColor(.secondary).font(.caption).lineLimit(1)
      } else if let e = model.lastError {
        Text("Error: \(e)").foregroundColor(.red).lineLimit(1)
      } else if let age = model.snap?.cacheAge {
        Text("App's saved copy: \(age) old").foregroundColor(.secondary).font(.caption)
      }
      Spacer()
      Button("Projects…") { model.isSetup.toggle() }
      Button("Refresh") { model.app?.refreshNow() }.keyboardShortcut("r")
      Button("Quit") { NSApp.terminate(nil) }.keyboardShortcut("q")
      ResizeGrip(model: model)
    }
  }
}

// ---------- the app ----------

final class AppDelegate: NSObject, NSApplicationDelegate {
  let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  let popover = NSPopover()
  let model = Model()
  var isLoading = false
  var isAgain = false

  // Shared refresh signal. A Refresh click or a launch, here or in any chat's
  // /chats panel, writes this file; every open view watches it, reads again and restarts its
  // 20-second cycle. So all open views refresh together.
  static let signalPath = NSHomeDirectory() + "/Library/Caches/ChatsBar/refresh-signal"
  var signalSeen: Date?

  func signalTime() -> Date? {
    (try? FileManager.default.attributesOfItem(atPath: Self.signalPath))?[.modificationDate] as? Date
  }

  func sendSignal() {
    let dir = (Self.signalPath as NSString).deletingLastPathComponent
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    try? "menu \(Date().timeIntervalSince1970)".write(toFile: Self.signalPath, atomically: true, encoding: .utf8)
    signalSeen = signalTime() // our own click: do not react to it again
  }

  // The 20-second read cycle. Every signal restarts it, so all open views read at the same moments.
  var cycle: Timer?

  func restartCycle() {
    cycle?.invalidate()
    cycle = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in self?.refresh() }
  }

  func applicationWillFinishLaunching(_ n: Notification) {
    // The /chats panel opens this window with: open "chatsbar://organize"
    NSAppleEventManager.shared().setEventHandler(
      self, andSelector: #selector(handleURL(_:reply:)),
      forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
  }

  func applicationDidFinishLaunching(_ n: Notification) {
    model.app = self
    popover.behavior = .transient
    popover.animates = false
    let host = NSHostingController(rootView: Root(model: model))
    // The popover keeps the size set in showPopover; SwiftUI must not grow it to the whole list.
    host.sizingOptions = []
    popover.contentViewController = host
    if let b = status.button {
      b.target = self
      b.action = #selector(togglePopover)
      b.sendAction(on: [.leftMouseUp, .rightMouseUp])
    }
    setIcon(working: 0)
    // A launch sends the signal too, so open /chats panels line up with this new cycle.
    sendSignal()
    restartCycle()
    refresh()
    // One file check per second: cheap, and a click elsewhere shows here within about a second.
    Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      guard let self = self, let t = self.signalTime(), t != self.signalSeen else { return }
      self.signalSeen = t
      self.restartCycle()
      self.refresh()
    }
  }

  @objc func handleURL(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
    // Only chatsbar://organize does anything; any other address is ignored.
    guard let s = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue,
          let url = URL(string: s), url.scheme == "chatsbar", url.host == "organize" else { return }
    DispatchQueue.main.async { self.showPopover() }
  }

  @objc func togglePopover() {
    if popover.isShown { popover.performClose(nil) } else { showPopover() }
  }

  func showPopover() {
    guard let b = status.button else { return }
    let saved = CGFloat(UserDefaults.standard.object(forKey: "height") as? Double ?? 640)
    model.height = min(saved, maxHeight())
    popover.contentSize = NSSize(width: model.width, height: model.height)
    refresh()
    NSApp.activate(ignoringOtherApps: true)
    if !popover.isShown {
      // Each open starts with all groups closed: less to read. A click opens a group.
      model.opened = []
      popover.show(relativeTo: b.bounds, of: b, preferredEdge: .minY)
    }
    popover.contentViewController?.view.window?.makeKey()
  }

  // ---------- resize ----------
  var dragStart: (mouse: NSPoint, size: NSSize)?

  func maxHeight() -> CGFloat {
    let room = (status.button?.window?.screen ?? NSScreen.main)?.visibleFrame.height ?? 700
    return max(300, room - 40)
  }

  func resizeDrag() {
    let m = NSEvent.mouseLocation
    if dragStart == nil { dragStart = (m, NSSize(width: model.width, height: model.height)) }
    guard let s = dragStart else { return }
    // Screen y grows upward: dragging down makes the window taller. The popover stays centered
    // under the icon, so it grows on both sides: twice the pointer's move keeps the corner under it.
    let w = min(1000, max(320, s.size.width + 2 * (m.x - s.mouse.x)))
    let h = min(maxHeight(), max(300, s.size.height + (s.mouse.y - m.y)))
    model.width = w
    model.height = h
    popover.contentSize = NSSize(width: w, height: h)
  }

  func resizeEnd() {
    dragStart = nil
    UserDefaults.standard.set(Double(model.width), forKey: "width")
    UserDefaults.standard.set(Double(model.height), forKey: "height")
  }

  func openLink(_ s: String) {
    if Store.isDemo { model.showNote("Demo chats are made up, so nothing opens."); return }
    guard s.hasPrefix("claude://claude.ai/"), let url = URL(string: s), url.scheme == "claude", url.host == "claude.ai" else { return }
    popover.performClose(nil)
    NSWorkspace.shared.open(url)
  }

  func setIcon(working: Int, stale: Bool = false) {
    guard let b = status.button else { return }
    let img = NSImage(systemSymbolName: "bubble.left.and.bubble.right", accessibilityDescription: "Chats")
    img?.isTemplate = true
    b.image = img
    b.imagePosition = .imageLeading
    b.title = (working > 0 ? " ▶\(working)" : "") + (stale ? " ⚠︎" : "")
  }

  func refresh() {
    // A change while a read runs reads once more after it, so a move shows at once.
    if isLoading { isAgain = true; return }
    isLoading = true
    DispatchQueue.global(qos: .userInitiated).async {
      let result = Self.runReader()
      let marks = Store.readMarks()
      DispatchQueue.main.async {
        self.isLoading = false
        switch result {
        case .success(let s): self.model.snap = s; self.model.lastError = s.error
        case .failure(let e): self.model.lastError = e.localizedDescription
        }
        self.model.marks = marks
        self.setIcon(working: self.model.snap?.working.count ?? 0, stale: self.model.snap?.staleWarning != nil)
        if self.isAgain { self.isAgain = false; self.refresh() }
      }
    }
  }

  static func runReader() -> Result<Snapshot, Error> {
    guard let script = Bundle.main.path(forResource: "chats", ofType: "py") else {
      return .failure(NSError(domain: "ChatsBar", code: 1, userInfo: [NSLocalizedDescriptionKey: "chats.py is missing from the app"]))
    }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
    p.arguments = ["-I", script]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    do {
      try p.run()
      // A reader that runs over 30 seconds is stopped, so isLoading is cleared and later
      // refreshes work.
      DispatchQueue.global().asyncAfter(deadline: .now() + 30) { if p.isRunning { p.terminate() } }
      let data = out.fileHandleForReading.readDataToEndOfFile()
      p.waitUntilExit()
      if p.terminationStatus != 0 {
        return .failure(NSError(domain: "ChatsBar", code: 2, userInfo: [NSLocalizedDescriptionKey: "the chat reader stopped with an error"]))
      }
      return .success(try JSONDecoder().decode(Snapshot.self, from: data))
    } catch {
      return .failure(error)
    }
  }

  func refreshNow() {
    sendSignal()
    restartCycle()
    refresh()
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
