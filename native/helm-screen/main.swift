// helm-screen: the Mac half of Helm's screen remote (experimental).
//
// Captures the main display with ScreenCaptureKit, encodes it to H.264 with VideoToolbox and
// posts mouse and keyboard events the phone sends. The server spawns one per phone connection
// and relays between it and the phone's WebSocket.
//
// stdin:  one JSON command per line (see `handle(_:)`).
// stdout: frames of [u8 kind][u32 big-endian length][payload]:
//   1 video   [u8 flags (1 = keyframe)][u64 big-endian pts µs][AVCC sample: 4-byte NAL lengths]
//   2 format  [u8 count][u16 length + parameter set]…  (SPS then PPS; sent before every keyframe)
//   10 json   UTF-8 JSON: {"t":"info"|"cursor"|"error", …}
//
// The video leaves the cursor out (`showsCursor = false`): the phone draws its own from the
// "cursor" messages, so it moves with no video lag.

import AppKit
import CoreMedia
import Foundation
import ScreenCaptureKit
import VideoToolbox

// MARK: Output

let output = FileHandle.standardOutput
let outputLock = NSLock()

func emit(_ kind: UInt8, _ payload: Data) {
    var frame = Data(capacity: payload.count + 5)
    frame.append(kind)
    var length = UInt32(payload.count).bigEndian
    withUnsafeBytes(of: &length) { frame.append(contentsOf: $0) }
    frame.append(payload)
    outputLock.lock()
    defer { outputLock.unlock() }
    do { try output.write(contentsOf: frame) } catch { exit(0) }  // the server went away
}

func emitJSON(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    emit(10, data)
}

func log(_ message: String) {
    FileHandle.standardError.write(Data("helm-screen: \(message)\n".utf8))
}

// MARK: Encoder

final class Encoder: @unchecked Sendable {
    private var session: VTCompressionSession?
    private var forceKeyframe = true
    private let lock = NSLock()

    init(width: Int32, height: Int32, fps: Int, bitrate: Int) {
        var session: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: nil, width: width, height: height, codecType: kCMVideoCodecType_H264,
            encoderSpecification: [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true] as CFDictionary,
            imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: nil, refcon: nil,
            compressionSessionOut: &session)
        guard status == noErr, let session else {
            log("VTCompressionSessionCreate failed: \(status)")
            return
        }
        let properties: [CFString: Any] = [
            kVTCompressionPropertyKey_RealTime: true,
            kVTCompressionPropertyKey_AllowFrameReordering: false,
            kVTCompressionPropertyKey_ProfileLevel: kVTProfileLevel_H264_High_AutoLevel,
            kVTCompressionPropertyKey_AverageBitRate: bitrate,
            kVTCompressionPropertyKey_ExpectedFrameRate: fps,
            // A screen is mostly still: keyframes come on request (a new viewer, a lost frame).
            kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: 10,
        ]
        for (key, value) in properties { VTSessionSetProperty(session, key: key, value: value as CFTypeRef) }
        VTCompressionSessionPrepareToEncodeFrames(session)
        self.session = session
    }

    func requestKeyframe() {
        lock.lock(); forceKeyframe = true; lock.unlock()
    }

    func encode(_ buffer: CVPixelBuffer, pts: CMTime) {
        guard let session else { return }
        lock.lock()
        let key = forceKeyframe
        forceKeyframe = false
        lock.unlock()
        let options = key ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
        VTCompressionSessionEncodeFrame(
            session, imageBuffer: buffer, presentationTimeStamp: pts, duration: .invalid,
            frameProperties: options, infoFlagsOut: nil
        ) { status, _, sample in
            guard status == noErr, let sample else { return }
            Self.send(sample)
        }
    }

    private static func send(_ sample: CMSampleBuffer) {
        guard let block = CMSampleBufferGetDataBuffer(sample) else { return }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
        let keyframe = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
        if keyframe, let format = CMSampleBufferGetFormatDescription(sample) { sendFormat(format) }

        var length = 0
        var pointer: UnsafeMutablePointer<CChar>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length,
                                          dataPointerOut: &pointer) == noErr, let pointer else { return }
        var payload = Data(capacity: length + 9)
        payload.append(keyframe ? 1 : 0)
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        var micros = UInt64(max(0, CMTimeGetSeconds(pts) * 1_000_000)).bigEndian
        withUnsafeBytes(of: &micros) { payload.append(contentsOf: $0) }
        payload.append(Data(bytes: pointer, count: length))
        emit(1, payload)
    }

    private static func sendFormat(_ format: CMFormatDescription) {
        var count = 0
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil,
                                                           parameterSetSizeOut: nil, parameterSetCountOut: &count,
                                                           nalUnitHeaderLengthOut: nil)
        var payload = Data([UInt8(count)])
        for index in 0..<count {
            var pointer: UnsafePointer<UInt8>?
            var size = 0
            guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                format, parameterSetIndex: index, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size,
                parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let pointer else { return }
            var length = UInt16(size).bigEndian
            withUnsafeBytes(of: &length) { payload.append(contentsOf: $0) }
            payload.append(pointer, count: size)
        }
        emit(2, payload)
    }

    func stop() {
        guard let session else { return }
        VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
        VTCompressionSessionInvalidate(session)
        self.session = nil
    }
}

// MARK: Capture

final class Capture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private var stream: SCStream?
    private(set) var encoder: Encoder?
    /// The captured display in points, top-left origin, global coordinates.
    private(set) var displayFrame = CGRect.zero

    @discardableResult
    func start(maxWidth: Int, fps: Int, bitrate: Int) async -> Bool {
        guard CGPreflightScreenCaptureAccess() else {
            CGRequestScreenCaptureAccess()
            emitJSON(["t": "error", "code": "screenRecording",
                      "message": "Allow Helm to record the screen in System Settings → Privacy & Security."])
            return false
        }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            let mainID = CGMainDisplayID()
            guard let display = content.displays.first(where: { $0.displayID == mainID }) ?? content.displays.first else {
                emitJSON(["t": "error", "code": "noDisplay", "message": "No display to share."])
                return false
            }
            displayFrame = CGDisplayBounds(display.displayID)
            let pointsWidth = Int(displayFrame.width), pointsHeight = Int(displayFrame.height)
            let pixelScale = max(1, Int(CGDisplayPixelsWide(display.displayID)) / max(1, pointsWidth))
            // Full pixels up to `maxWidth`: zooming in on the phone should stay sharp.
            let width = min(maxWidth, pointsWidth * pixelScale) & ~1
            let height = (width * pointsHeight / pointsWidth) & ~1

            let config = SCStreamConfiguration()
            config.width = width
            config.height = height
            config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
            config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
            config.showsCursor = false
            config.queueDepth = 4
            config.colorSpaceName = CGColorSpace.sRGB

            let filter = SCContentFilter(display: display, excludingWindows: [])
            let stream = SCStream(filter: filter, configuration: config, delegate: self)
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "helm-screen.capture"))
            encoder = Encoder(width: Int32(width), height: Int32(height), fps: fps, bitrate: bitrate)
            try await stream.startCapture()
            self.stream = stream
            emitJSON(["t": "info", "width": pointsWidth, "height": pointsHeight,
                      "videoWidth": width, "videoHeight": height,
                      "accessibility": AXIsProcessTrusted()])
            return true
        } catch {
            emitJSON(["t": "error", "code": "capture", "message": error.localizedDescription])
            return false
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sample.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let rawStatus = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: rawStatus) == .complete,
              let buffer = CMSampleBufferGetImageBuffer(sample)
        else { return }
        encoder?.encode(buffer, pts: CMSampleBufferGetPresentationTimeStamp(sample))
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emitJSON(["t": "error", "code": "capture", "message": error.localizedDescription])
        exit(1)
    }

    func stop() async {
        try? await stream?.stopCapture()
        stream = nil
        encoder?.stop()
    }
}

// MARK: Cursor

/// Reports where the cursor is, in the display's points from its top-left, whenever it moves.
final class CursorWatch: @unchecked Sendable {
    private var timer: DispatchSourceTimer?
    private var last = CGPoint(x: -1, y: -1)

    func start(display: @escaping @Sendable () -> CGRect) {
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: .milliseconds(16))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            // CGEvent's location is in global points with a top-left origin, like CGDisplayBounds.
            guard let location = CGEvent(source: nil)?.location else { return }
            let frame = display()
            let point = CGPoint(x: location.x - frame.minX, y: location.y - frame.minY)
            guard point != self.last else { return }
            self.last = point
            emitJSON(["t": "cursor", "x": point.x, "y": point.y])
        }
        timer.resume()
        self.timer = timer
    }
}

// MARK: Input

/// Posts the phone's mouse and keyboard as if they were this Mac's own.
final class Input: @unchecked Sendable {
    private let source = CGEventSource(stateID: .hidSystemState)
    private var held: CGMouseButton?
    private var lastClick = (at: Date.distantPast, button: CGMouseButton.left, count: 0)
    private var flags: CGEventFlags = []
    var displayFrame = CGRect.zero
    private var warnedAccessibility = false

    private func global(_ x: Double, _ y: Double) -> CGPoint {
        CGPoint(x: displayFrame.minX + min(max(0, x), displayFrame.width - 1),
                y: displayFrame.minY + min(max(0, y), displayFrame.height - 1))
    }

    private func checkTrusted() -> Bool {
        if AXIsProcessTrusted() { return true }
        if !warnedAccessibility {
            warnedAccessibility = true
            let prompt = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            _ = AXIsProcessTrustedWithOptions([prompt: true] as CFDictionary)
            emitJSON(["t": "error", "code": "accessibility",
                      "message": "Allow Helm to control the computer in System Settings → Privacy & Security → Accessibility."])
        }
        return false
    }

    private static func types(_ button: CGMouseButton) -> (down: CGEventType, up: CGEventType, drag: CGEventType) {
        switch button {
        case .right: (.rightMouseDown, .rightMouseUp, .rightMouseDragged)
        case .center: (.otherMouseDown, .otherMouseUp, .otherMouseDragged)
        default: (.leftMouseDown, .leftMouseUp, .leftMouseDragged)
        }
    }

    private static func button(_ name: String?) -> CGMouseButton {
        switch name {
        case "right": .right
        case "middle": .center
        default: .left
        }
    }

    func move(x: Double, y: Double) {
        guard checkTrusted() else { return }
        let point = global(x, y)
        let type = held.map { Self.types($0).drag } ?? .mouseMoved
        let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point,
                            mouseButton: held ?? .left)
        event?.flags = flags
        event?.post(tap: .cghidEventTap)
    }

    func button(_ name: String?, down: Bool, x: Double, y: Double) {
        guard checkTrusted() else { return }
        let button = Self.button(name)
        let point = global(x, y)
        if down {
            // Consecutive clicks within the system's double-click time count up (double, triple click).
            let now = Date()
            let quick = now.timeIntervalSince(lastClick.at) < NSEvent.doubleClickInterval && lastClick.button == button
            lastClick = (now, button, quick ? lastClick.count + 1 : 1)
        }
        let types = Self.types(button)
        let event = CGEvent(mouseEventSource: source, mouseType: down ? types.down : types.up,
                            mouseCursorPosition: point, mouseButton: button)
        event?.setIntegerValueField(.mouseEventClickState, value: Int64(lastClick.count))
        event?.flags = flags
        event?.post(tap: .cghidEventTap)
        held = down ? button : nil
    }

    func scroll(dx: Double, dy: Double) {
        guard checkTrusted() else { return }
        let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                            wheel1: Int32(dy.rounded()), wheel2: Int32(dx.rounded()), wheel3: 0)
        event?.flags = flags
        event?.post(tap: .cghidEventTap)
    }

    private static func flags(_ names: [String]) -> CGEventFlags {
        var flags: CGEventFlags = []
        for name in names {
            switch name {
            case "cmd": flags.insert(.maskCommand)
            case "alt": flags.insert(.maskAlternate)
            case "ctrl": flags.insert(.maskControl)
            case "shift": flags.insert(.maskShift)
            default: break
            }
        }
        return flags
    }

    /// A virtual key press (with modifiers held for it), e.g. ⌘C as code 8 with ["cmd"].
    func key(code: Int, mods: [String]) {
        guard checkTrusted() else { return }
        let flags = Self.flags(mods)
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: down)
            event?.flags = flags
            event?.post(tap: .cghidEventTap)
        }
    }

    /// Typed text, as Unicode, whatever the Mac's keyboard layout.
    func text(_ string: String) {
        guard checkTrusted() else { return }
        for character in string {
            if character == "\n" { key(code: 36, mods: []); continue }  // Return
            let units = Array(String(character).utf16)
            for down in [true, false] {
                let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                event?.post(tap: .cghidEventTap)
            }
        }
    }
}

// MARK: Main

let capture = Capture()
let input = Input()
let cursor = CursorWatch()

func handle(_ line: String) {
    guard let data = line.data(using: .utf8),
          let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = command["t"] as? String else { return }
    let x = command["x"] as? Double ?? 0, y = command["y"] as? Double ?? 0
    switch type {
    case "start":
        let maxWidth = command["maxWidth"] as? Int ?? 3024
        let fps = command["fps"] as? Int ?? 30
        let bitrate = command["bitrate"] as? Int ?? 8_000_000
        Task {
            guard await capture.start(maxWidth: maxWidth, fps: fps, bitrate: bitrate) else { return }
            let frame = capture.displayFrame
            DispatchQueue.main.async {
                input.displayFrame = frame
                cursor.start { frame }
            }
        }
    case "keyframe": capture.encoder?.requestKeyframe()
    case "move": DispatchQueue.main.async { input.move(x: x, y: y) }
    case "button":
        let down = command["down"] as? Bool ?? false
        let button = command["b"] as? String
        DispatchQueue.main.async { input.button(button, down: down, x: x, y: y) }
    case "scroll":
        let dx = command["dx"] as? Double ?? 0, dy = command["dy"] as? Double ?? 0
        DispatchQueue.main.async { input.scroll(dx: dx, dy: dy) }
    case "key":
        let code = command["code"] as? Int ?? 0
        let mods = command["mods"] as? [String] ?? []
        DispatchQueue.main.async { input.key(code: code, mods: mods) }
    case "text":
        let text = command["s"] as? String ?? ""
        DispatchQueue.main.async { input.text(text) }
    case "stop":
        Task { await capture.stop(); exit(0) }
    default: break
    }
}

if CommandLine.arguments.contains("--check") {
    // `helm-screen --check`: what this Mac allows, for the server's capability probe.
    let result = ["screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()]
    print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
    exit(0)
}

signal(SIGPIPE, SIG_IGN)
Thread.detachNewThread {
    while let line = readLine() { handle(line) }
    // stdin closed: the server let go of us.
    exit(0)
}
NSApplication.shared.setActivationPolicy(.prohibited)
RunLoop.main.run()
