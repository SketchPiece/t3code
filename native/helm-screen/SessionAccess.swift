import Foundation
import CoreFoundation

/// Desktop-owned consent is reread for every attempt and input event, so revocation is immediate.
struct SessionAccess {
    let settingsPath: String?

    var unlockEnabled: Bool {
        guard let settingsPath, let data = try? Data(contentsOf: URL(fileURLWithPath: settingsPath)),
              let settings = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let enabled = settings["screenUnlockEnabled"] as? NSNumber,
              CFGetTypeID(enabled) == CFBooleanGetTypeID() else { return false }
        return enabled.boolValue
    }

    func permitsInput(locked: Bool?) -> Bool {
        switch locked {
        case false: true
        case true: unlockEnabled
        case nil: false
        }
    }

    func unlockError(locked: Bool?, password: String) -> String? {
        guard unlockEnabled else { return "disabled" }
        guard let locked else { return "unavailable" }
        guard locked else { return "notLocked" }
        guard !password.isEmpty, password.utf16.count <= 1024,
              !password.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            return "invalidPassword"
        }
        return nil
    }
}
