// helm-auth: with an external display connected, a Touch ID sheet goes straight to the
// password. The Mac's own keyboard (and its Touch ID key) is often out of reach then, so
// a system sheet gets its "Use Password…" pressed and 1Password's sheet, which has no such
// button, is cancelled, which puts 1Password's own password field up. Either way the
// password field gets the focus. Without an external display it does nothing.
//
// Output: JSON lines on stdout, for the server's log.
//   → {"event":"ready","trusted":true}
//   → {"event":"switched","app":"1Password","ok":true,"message":"…"}

import AppKit
import ApplicationServices
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object),
        let line = String(data: data, encoding: .utf8) else { return }
  print(line)
}

// MARK: Accessibility helpers

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
  var value: AnyObject?
  AXUIElementCopyAttributeValue(element, name as CFString, &value)
  return value
}

func descendants(_ element: AXUIElement, depth: Int = 0) -> [AXUIElement] {
  guard depth < 25 else { return [] }
  let children = (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
  return [element] + children.flatMap { descendants($0, depth: depth + 1) }
}

func role(_ element: AXUIElement) -> String { attribute(element, kAXRoleAttribute) as? String ?? "" }
func subrole(_ element: AXUIElement) -> String { attribute(element, kAXSubroleAttribute) as? String ?? "" }
func label(_ element: AXUIElement) -> String {
  (attribute(element, kAXDescriptionAttribute) as? String).flatMap { $0.isEmpty ? nil : $0 }
    ?? attribute(element, kAXTitleAttribute) as? String ?? ""
}

func button(in root: AXUIElement, matching names: [String]) -> AXUIElement? {
  descendants(root).first { role($0) == kAXButtonRole && names.contains(label($0)) }
}

func press(_ element: AXUIElement) -> Bool {
  AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
}

func textField(in root: AXUIElement) -> AXUIElement? {
  descendants(root).first { role($0) == kAXTextFieldRole || subrole($0) == "AXSecureTextField" }
}

func focus(_ element: AXUIElement) {
  AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
}

func wait(_ seconds: Double, until condition: () -> Bool) -> Bool {
  let deadline = Date().addingTimeInterval(seconds)
  while Date() < deadline {
    if condition() { return true }
    usleep(100_000)
  }
  return condition()
}

// MARK: Displays

/// Any active display that isn't the Mac's own screen: a monitor, AirPlay, Sidecar or
/// Helm's virtual display for the iPad.
func externalDisplayConnected() -> Bool {
  var count: UInt32 = 0
  guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return false }
  var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
  guard CGGetActiveDisplayList(count, &displays, &count) == .success else { return false }
  return displays.prefix(Int(count)).contains { CGDisplayIsBuiltin($0) == 0 }
}

// MARK: Sheets

let localAuthBundle = "com.apple.LocalAuthentication.UIAgent"
let onePasswordBundle = "com.1password.1password"
let usePasswordNames = ["Use Password…", "Use Password..."]

/// "1Password is trying to unlock." → "1Password". The first line of every
/// LocalAuthentication sheet is "<App> is trying to <reason>."
func requestingApp(from title: String) -> String {
  for marker in [" is trying to ", " wants to "] {
    if let range = title.range(of: marker) { return String(title[..<range.lowerBound]) }
  }
  return ""
}

func sheetTitle(pid: pid_t) -> String? {
  descendants(AXUIElementCreateApplication(pid))
    .filter { role($0) == kAXStaticTextRole }
    .compactMap { attribute($0, kAXValueAttribute) as? String }
    .first { !$0.isEmpty }
}

func authWindows() -> [(number: Int, pid: pid_t)] {
  guard let agent = NSRunningApplication.runningApplications(withBundleIdentifier: localAuthBundle).first,
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]
  else { return [] }
  return list.compactMap { info in
    guard (info[kCGWindowOwnerPID as String] as? pid_t) == agent.processIdentifier,
          let number = info[kCGWindowNumber as String] as? Int else { return nil }
    return (number, agent.processIdentifier)
  }
}

/// A system sheet with a password option: press it and put the cursor in the field.
func switchSystemSheet(pid: pid_t) -> (Bool, String) {
  let app = AXUIElementCreateApplication(pid)
  if textField(in: app) == nil {
    guard let use = button(in: app, matching: usePasswordNames), press(use) else {
      return (false, "No password option.")
    }
    guard wait(3, until: { textField(in: app) != nil }) else {
      return (false, "The password field didn't appear.")
    }
  }
  guard let field = textField(in: app) else { return (false, "No password field.") }
  focus(field)
  return (true, "Switched to the password.")
}

func onePasswordField() -> AXUIElement? {
  guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: onePasswordBundle).first
  else { return nil }
  let ax = AXUIElementCreateApplication(app.processIdentifier)
  // 1Password is Electron: its tree only fills in once asked for.
  AXUIElementSetAttributeValue(ax, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  let windows = (attribute(ax, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  for window in windows {
    if let field = descendants(window).first(where: { subrole($0) == "AXSecureTextField" }) { return field }
  }
  return nil
}

/// 1Password's sheet only takes Touch ID: cancel it, and 1Password falls back to its own
/// lock screen, which takes the account password.
func switchOnePassword(pid: pid_t) -> (Bool, String) {
  guard let cancel = button(in: AXUIElementCreateApplication(pid), matching: ["Cancel"]), press(cancel) else {
    return (false, "Couldn't dismiss the Touch ID sheet.")
  }
  guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: onePasswordBundle).first else {
    return (false, "1Password isn't running.")
  }
  var field: AXUIElement?
  _ = wait(6) {
    field = onePasswordField()
    return field != nil
  }
  guard let field else { return (false, "1Password's unlock field didn't appear.") }
  app.activate()
  usleep(300_000)
  focus(field)
  return (true, "Switched to 1Password's password.")
}

/// Sheets already seen, handled or not, so a sheet left on Touch ID isn't pressed again.
var seen = Set<String>()

func scan() {
  let windows = authWindows()
  let ids = Set(windows.map { "\($0.pid)-\($0.number)" })
  seen.formIntersection(ids)
  for window in windows where !seen.contains("\(window.pid)-\(window.number)") {
    seen.insert("\(window.pid)-\(window.number)")
    guard externalDisplayConnected() else { continue }
    // The sheet's text can lag its window by a moment.
    var title: String?
    _ = wait(1) {
      title = sheetTitle(pid: window.pid)
      return title != nil
    }
    let app = requestingApp(from: title ?? "")
    let sheet = AXUIElementCreateApplication(window.pid)
    let (ok, message): (Bool, String)
    if button(in: sheet, matching: usePasswordNames) != nil || textField(in: sheet) != nil {
      (ok, message) = switchSystemSheet(pid: window.pid)
    } else if app == "1Password", title?.contains(" unlock") == true {
      // Only the unlock: cancelling 1Password's other sheets (an SSH key) would turn them down.
      (ok, message) = switchOnePassword(pid: window.pid)
    } else {
      // Touch ID only and no fallback we know of: leave it to the Mac.
      continue
    }
    emit(["event": "switched", "app": app, "ok": ok, "message": message])
  }
}

// MARK: Main

emit(["event": "ready", "trusted": AXIsProcessTrusted()])

let queue = DispatchQueue(label: "watcher")
let timer = DispatchSource.makeTimerSource(queue: queue)
timer.schedule(deadline: .now(), repeating: .milliseconds(400))
timer.setEventHandler(handler: scan)
timer.resume()

Thread.detachNewThread {
  while readLine() != nil {}
  exit(0)  // the parent went away
}

dispatchMain()
