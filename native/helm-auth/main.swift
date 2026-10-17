// helm-auth-watcher: notices macOS authentication prompts (Touch ID / password
// sheets from LocalAuthentication, 1Password unlocks) and fills them with a
// password sent from the phone.
//
// Protocol: JSON lines. Events go to stdout, commands come on stdin.
//   → {"event":"ready","trusted":true}
//   → {"event":"prompt","id":"…","app":"1Password","title":"…","detail":"…","kinds":["onepassword"],
//      "sealingKey":"<base64 X9.63 P-256>"}
//   → {"event":"gone","id":"…"}
//   → {"event":"result","id":"…","ok":true,"message":"…"}
//   ← {"command":"fill","id":"…","kind":"mac"|"onepassword","ephemeralKey":"…","box":"…"}
//   ← {"command":"cancel","id":"…"}
//
// The phone seals the password to the prompt's own key (ECDH with its one-off key,
// HKDF-SHA256 with the prompt id, AES-GCM), so the server in between never sees
// it. It only lives in memory for the length of a fill.

import AppKit
import ApplicationServices
import CryptoKit
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

// MARK: Typing

let keySource = CGEventSource(stateID: .hidSystemState)

/// Types text into whatever has keyboard focus. Unicode events, so the
/// current keyboard layout (ABC, Russian, …) doesn't matter.
func type(_ text: String) {
  for unit in text.utf16 {
    var u = unit
    for down in [true, false] {
      let event = CGEvent(keyboardEventSource: keySource, virtualKey: 0, keyDown: down)
      event?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &u)
      event?.post(tap: .cghidEventTap)
    }
    usleep(4000)
  }
}

func pressReturn() {
  for down in [true, false] {
    CGEvent(keyboardEventSource: keySource, virtualKey: 36, keyDown: down)?.post(tap: .cghidEventTap)
  }
}

func wait(_ seconds: Double, until condition: () -> Bool) -> Bool {
  let deadline = Date().addingTimeInterval(seconds)
  while Date() < deadline {
    if condition() { return true }
    usleep(100_000)
  }
  return condition()
}

// MARK: Prompts

let localAuthBundle = "com.apple.LocalAuthentication.UIAgent"
let onePasswordBundle = "com.1password.1password"

struct Prompt {
  let id: String
  let sealingKey = P256.KeyAgreement.PrivateKey()
  let windowNumber: Int
  let pid: pid_t
  let title: String
  let detail: String
  let app: String
  let hasPasswordOption: Bool

  var kinds: [String] {
    var kinds: [String] = []
    if app == "1Password" { kinds.append("onepassword") }
    if hasPasswordOption || textFieldPresent { kinds.append("mac") }
    return kinds
  }

  var textFieldPresent: Bool { textField(in: window ?? AXUIElementCreateApplication(pid)) != nil }

  var window: AXUIElement? {
    let windows = (attribute(AXUIElementCreateApplication(pid), kAXWindowsAttribute) as? [AXUIElement]) ?? []
    return windows.first
  }
}

/// "1Password is trying to unlock." → "1Password". The first line of every
/// LocalAuthentication sheet is "<App> is trying to <reason>."
func requestingApp(from title: String) -> String {
  for marker in [" is trying to ", " wants to "] {
    if let range = title.range(of: marker) { return String(title[..<range.lowerBound]) }
  }
  return ""
}

func readPrompt(windowNumber: Int, pid: pid_t) -> Prompt? {
  let app = AXUIElementCreateApplication(pid)
  let texts = descendants(app).filter { role($0) == kAXStaticTextRole }
    .compactMap { attribute($0, kAXValueAttribute) as? String }
    .filter { !$0.isEmpty }
  guard let title = texts.first else { return nil }
  let hasPassword = button(in: app, matching: ["Use Password…", "Use Password..."]) != nil
  return Prompt(
    id: "prompt-\(pid)-\(windowNumber)", windowNumber: windowNumber, pid: pid, title: title,
    detail: texts.dropFirst().joined(separator: "\n"), app: requestingApp(from: title),
    hasPasswordOption: hasPassword)
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

var known: [String: Prompt] = [:]
let queue = DispatchQueue(label: "watcher")

func scan() {
  let windows = authWindows()
  let ids = Set(windows.map { "prompt-\($0.pid)-\($0.number)" })
  for (id, _) in known where !ids.contains(id) {
    known[id] = nil
    emit(["event": "gone", "id": id])
  }
  for window in windows where known["prompt-\(window.pid)-\(window.number)"] == nil {
    guard let prompt = readPrompt(windowNumber: window.number, pid: window.pid) else { continue }
    known[prompt.id] = prompt
    emit([
      "event": "prompt", "id": prompt.id, "app": prompt.app, "title": prompt.title,
      "detail": prompt.detail, "kinds": prompt.kinds,
      "sealingKey": prompt.sealingKey.publicKey.x963Representation.base64EncodedString(),
    ])
  }
}

// MARK: Filling

func fillWithMacPassword(_ prompt: Prompt, secret: String) -> (Bool, String) {
  let app = AXUIElementCreateApplication(prompt.pid)
  if textField(in: app) == nil {
    guard let use = button(in: app, matching: ["Use Password…", "Use Password..."]), press(use) else {
      return (false, "This prompt has no password option.")
    }
    guard wait(3, until: { textField(in: app) != nil }) else { return (false, "The password field didn't appear.") }
  }
  guard let field = textField(in: app) else { return (false, "No password field.") }
  AXUIElementSetAttributeValue(field, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  usleep(150_000)
  type(secret)
  usleep(100_000)
  pressReturn()
  let closed = wait(4) { !authWindows().contains { $0.number == prompt.windowNumber } }
  return closed ? (true, "Unlocked.") : (false, "The prompt is still open. Wrong password?")
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

/// 1Password's Touch ID sheet has no password button: cancel it, and 1Password
/// falls back to its own lock screen, which takes the account password.
func fillOnePassword(_ prompt: Prompt, secret: String) -> (Bool, String) {
  let sheet = AXUIElementCreateApplication(prompt.pid)
  if authWindows().contains(where: { $0.number == prompt.windowNumber }) {
    guard let cancel = button(in: sheet, matching: ["Cancel"]), press(cancel) else {
      return (false, "Couldn't dismiss the Touch ID sheet.")
    }
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
  AXUIElementSetAttributeValue(field, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  usleep(200_000)
  type(secret)
  usleep(100_000)
  pressReturn()
  let unlocked = wait(5) { onePasswordField() == nil }
  return unlocked ? (true, "1Password unlocked.") : (false, "1Password is still locked. Wrong password?")
}

func unseal(_ command: [String: Any], for prompt: Prompt) -> String? {
  guard let keyData = (command["ephemeralKey"] as? String).flatMap({ Data(base64Encoded: $0) }),
        let boxData = (command["box"] as? String).flatMap({ Data(base64Encoded: $0) }),
        let phoneKey = try? P256.KeyAgreement.PublicKey(x963Representation: keyData),
        let shared = try? prompt.sealingKey.sharedSecretFromKeyAgreement(with: phoneKey),
        let box = try? AES.GCM.SealedBox(combined: boxData)
  else { return nil }
  let key = shared.hkdfDerivedSymmetricKey(
    using: SHA256.self, salt: Data("helm-auth-v1".utf8), sharedInfo: Data(prompt.id.utf8),
    outputByteCount: 32)
  return (try? AES.GCM.open(box, using: key)).flatMap { String(data: $0, encoding: .utf8) }
}

func handle(_ command: [String: Any]) {
  guard let name = command["command"] as? String, let id = command["id"] as? String else { return }
  guard let prompt = known[id] else {
    emit(["event": "result", "id": id, "ok": false, "message": "The prompt is gone."])
    return
  }
  switch name {
  case "fill":
    guard let secret = unseal(command, for: prompt) else {
      emit(["event": "result", "id": id, "ok": false, "message": "Couldn't read the password from the phone."])
      return
    }
    let kind = command["kind"] as? String ?? "mac"
    let (ok, message) = kind == "onepassword"
      ? fillOnePassword(prompt, secret: secret)
      : fillWithMacPassword(prompt, secret: secret)
    emit(["event": "result", "id": id, "ok": ok, "message": message])
  case "cancel":
    let ok = button(in: AXUIElementCreateApplication(prompt.pid), matching: ["Cancel"]).map(press) ?? false
    emit(["event": "result", "id": id, "ok": ok, "message": ok ? "Cancelled." : "Couldn't cancel."])
  default:
    break
  }
}

// MARK: Main

emit(["event": "ready", "trusted": AXIsProcessTrusted()])

let timer = DispatchSource.makeTimerSource(queue: queue)
timer.schedule(deadline: .now(), repeating: .milliseconds(400))
timer.setEventHandler(handler: scan)
timer.resume()

Thread.detachNewThread {
  while let line = readLine() {
    guard let data = line.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
    queue.async { handle(object) }
  }
  exit(0)  // the parent went away
}

dispatchMain()
