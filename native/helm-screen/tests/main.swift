import Foundation

let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: folder) }
let file = folder.appendingPathComponent("desktop-settings.json")
let access = SessionAccess(settingsPath: file.path)
func write(_ text: String) throws { try Data(text.utf8).write(to: file, options: .atomic) }
func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else { fatalError(message) }
}
check(!access.unlockEnabled, "Missing consent must deny unlocking")
check(access.permitsInput(locked: false), "Normal desktop input must still work")
check(!access.permitsInput(locked: true), "Locked desktop input must be denied by default")
check(!access.permitsInput(locked: nil), "Unknown session state must deny input")
check(access.unlockError(locked: true, password: "example") == "disabled", "Must reject disabled attempts")
try write("{\"screenUnlockEnabled\":true}")
check(access.unlockEnabled, "Local consent should enable unlocking")
check(access.permitsInput(locked: true), "Consent should allow locked-screen input")
check(access.unlockError(locked: true, password: "correct horse 🐎") == nil, "Unicode password accepted")
check(access.unlockError(locked: false, password: "example") == "notLocked", "Do not type into an unlocked desktop")
check(access.unlockError(locked: nil, password: "example") == "unavailable", "Unknown state must deny attempts")
for password in ["", "a\nb", "a\rb", "a\u{0}b", String(repeating: "a", count: 1025)] {
    check(access.unlockError(locked: true, password: password) == "invalidPassword", "Reject empty, control or oversized password")
}
try write("{\"screenUnlockEnabled\":false}")
check(!access.permitsInput(locked: true), "Revocation must affect an existing helper immediately")
check(access.unlockError(locked: true, password: "example") == "disabled", "Revocation must reject an existing helper's attempts")
for document in ["{}", "invalid JSON", "{\"screenUnlockEnabled\":\"true\"}", "{\"screenUnlockEnabled\":1}"] {
    try write(document)
    check(!access.unlockEnabled, "Malformed consent must not enable unlocking")
}
check(!SessionAccess(settingsPath: nil).unlockEnabled, "Standalone server cannot enable consent")
print("Session access tests passed")
