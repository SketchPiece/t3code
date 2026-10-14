// helm-screen: the Mac half of Helm's screen remote (experimental).
//
// Captures a display (or all of them, side by side as they're arranged) with ScreenCaptureKit,
// encodes it to H.264 with VideoToolbox and posts mouse and keyboard events the phone sends. It can
// also add a virtual display the size of the phone's screen (kept by `--keep-display`, see
// Keeper), send the Mac's sound and share its clipboard. The server spawns one per phone
// connection and relays between it and the phone's WebSocket.
//
// stdin:  one JSON command per line (see `handle(_:)`).
// stdout: frames of [u8 kind][u32 big-endian length][payload]:
//   1 video   [u8 flags (1 = keyframe)][u64 big-endian pts µs][AVCC sample: 4-byte NAL lengths]
//   2 format  [u8 count][u16 length + parameter set]…  (SPS then PPS; sent before every keyframe)
//   3 audio   [u8 channels][u32 big-endian sample rate][Int16 little-endian samples, interleaved]
//   10 json   UTF-8 JSON: {"t":"info"|"displays"|"cursor"|"clipboard"|"error", …}
//
// The video leaves the cursor out (`showsCursor = false`): the phone draws its own from the
// "cursor" messages, so it moves with no video lag.

import AppKit
import AVFAudio
import CoreImage
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

struct StreamSettings {
    var maxWidth = 3024, fps = 30, bitrate = 8_000_000
    /// The Mac's sound goes along.
    var audio = false
}

/// What the video shows, in global points with a top-left origin: the input and the cursor
/// reports are relative to it.
final class ShownFrame: @unchecked Sendable {
    private let lock = NSLock()
    private var frame = CGRect.zero
    var value: CGRect {
        get { lock.lock(); defer { lock.unlock() }; return frame }
        set { lock.lock(); frame = newValue; lock.unlock() }
    }
}

let shownFrame = ShownFrame()

/// One capture going to the phone: a display straight to the encoder, or several drawn into one
/// picture as they're arranged, so a window can be dragged from one to another.
final class Session: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    /// What the video covers, in global points.
    let frame: CGRect
    let videoSize: CGSize
    let encoder: Encoder
    let displayIDs: [CGDirectDisplayID]
    var stopped: ((Session, Error) -> Void)?
    private let fps: Int
    private let audio: Bool
    private let queue = DispatchQueue(label: "helm-screen.capture")
    private let audioQueue = DispatchQueue(label: "helm-screen.audio")
    private var running: [SCStream] = []
    private var isStopping = false
    // Several displays: each one's latest picture, drawn together at the frame rate (on `queue`).
    private let composite: Bool
    private var sources: [ObjectIdentifier: CGDirectDisplayID] = [:]
    private var offsets: [CGDirectDisplayID: CGPoint] = [:]
    private var latest: [CGDirectDisplayID: CVPixelBuffer] = [:]
    private var dirty = false
    private var timer: DispatchSourceTimer?
    private var pool: CVPixelBufferPool?
    private lazy var context = CIContext(options: [.cacheIntermediates: false])

    init(displays: [SCDisplay], settings: StreamSettings) {
        displayIDs = displays.map(\.displayID)
        let frames = displayIDs.map { CGDisplayBounds($0) }
        let union = frames.dropFirst().reduce(frames[0]) { $0.union($1) }
        frame = union
        composite = displays.count > 1
        fps = settings.fps
        audio = settings.audio
        // Full pixels up to `maxWidth`: zooming in on the phone should stay sharp.
        let pixelScale = displayIDs.map { id in
            guard let mode = CGDisplayCopyDisplayMode(id) else { return 1 }
            return max(1, mode.pixelWidth / max(1, mode.width))
        }.max() ?? 1
        let limit = CGFloat(settings.maxWidth)
        let scale = min(CGFloat(pixelScale), limit / union.width, limit / union.height)
        let width = Int(union.width * scale) & ~1
        let height = Int(union.height * scale) & ~1
        videoSize = CGSize(width: width, height: height)
        encoder = Encoder(width: Int32(width), height: Int32(height), fps: settings.fps, bitrate: settings.bitrate)
        super.init()
        if composite {
            // Core Image's origin is at the bottom.
            for (id, bounds) in zip(displayIDs, frames) {
                offsets[id] = CGPoint(x: ((bounds.minX - union.minX) * scale).rounded(),
                                      y: ((union.maxY - bounds.maxY) * scale).rounded())
            }
            let attributes: [CFString: Any] = [
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey: width, kCVPixelBufferHeightKey: height,
                kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
            ]
            CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &pool)
        }
    }

    func start(_ displays: [SCDisplay]) async throws {
        let scale = videoSize.width / frame.width
        for display in displays {
            let bounds = CGDisplayBounds(display.displayID)
            let config = SCStreamConfiguration()
            config.width = composite ? Int((bounds.width * scale).rounded()) : Int(videoSize.width)
            config.height = composite ? Int((bounds.height * scale).rounded()) : Int(videoSize.height)
            config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
            // One display goes to the encoder as it comes; several are drawn together first.
            config.pixelFormat = composite ? kCVPixelFormatType_32BGRA : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
            config.showsCursor = false
            config.queueDepth = composite ? 5 : 4
            config.colorSpaceName = CGColorSpace.sRGB

            // The sound is the whole Mac's, whichever display: once is enough.
            let withAudio = audio && running.isEmpty
            if withAudio {
                config.capturesAudio = true
                config.sampleRate = 24_000
                config.channelCount = 2
                config.excludesCurrentProcessAudio = true
            }

            let filter = SCContentFilter(display: display, excludingWindows: [])
            let stream = SCStream(filter: filter, configuration: config, delegate: self)
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
            if withAudio { try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue) }
            queue.sync { sources[ObjectIdentifier(stream)] = display.displayID }
            try await stream.startCapture()
            running.append(stream)
        }
        guard composite else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .nanoseconds(1_000_000_000 / max(1, fps)))
        timer.setEventHandler { [weak self] in self?.drawComposite() }
        timer.resume()
        self.timer = timer
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        if type == .audio {
            Self.sendAudio(sample)
            return
        }
        guard type == .screen, sample.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let rawStatus = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: rawStatus) == .complete,
              let buffer = CMSampleBufferGetImageBuffer(sample)
        else { return }
        guard composite else {
            encoder.encode(buffer, pts: CMSampleBufferGetPresentationTimeStamp(sample))
            return
        }
        guard let id = sources[ObjectIdentifier(stream)] else { return }
        latest[id] = buffer
        dirty = true
    }

    /// 16-bit stereo, a quarter of the floats' size: about 100 KB a second.
    private static func sendAudio(_ sample: CMSampleBuffer) {
        guard sample.isValid, let description = sample.formatDescription else { return }
        let format = AVAudioFormat(cmAudioFormatDescription: description)
        try? sample.withAudioBufferList { list, _ in
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: list.unsafePointer),
                  let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return }
            let frames = Int(buffer.frameLength), count = Int(format.channelCount)
            var payload = Data(capacity: 5 + frames * 4)
            payload.append(2)
            var rate = UInt32(format.sampleRate).bigEndian
            withUnsafeBytes(of: &rate) { payload.append(contentsOf: $0) }
            var samples = [Int16](repeating: 0, count: frames * 2)
            for frame in 0..<frames {
                for channel in 0..<2 {
                    let source = min(channel, count - 1)
                    let value = format.isInterleaved
                        ? channels[0][frame * buffer.stride + source]
                        : channels[source][frame]
                    samples[frame * 2 + channel] = Int16(max(-1, min(1, value)) * 32767).littleEndian
                }
            }
            samples.withUnsafeBytes { payload.append(contentsOf: $0) }
            emit(3, payload)
        }
    }

    /// The displays' latest pictures in one, black where none is; only when one of them changed.
    private func drawComposite() {
        guard dirty, !isStopping, let pool else { return }
        dirty = false
        var output: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &output)
        guard let output else { return }
        let canvas = CGRect(origin: .zero, size: videoSize)
        var image = CIImage(color: .black).cropped(to: canvas)
        for (id, buffer) in latest {
            guard let offset = offsets[id] else { continue }
            image = CIImage(cvPixelBuffer: buffer)
                .transformed(by: CGAffineTransform(translationX: offset.x, y: offset.y))
                .composited(over: image)
        }
        context.render(image, to: output, bounds: canvas, colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
        encoder.encode(output, pts: CMClockGetTime(CMClockGetHostTimeClock()))
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        guard !isStopping else { return }
        stopped?(self, error)
    }

    func stop() async {
        isStopping = true
        timer?.cancel()
        for stream in running { try? await stream.stopCapture() }
        running = []
        queue.sync { latest = [:] }
        encoder.stop()
    }
}

// MARK: Virtual display

/// A display that exists only for the phone (CoreGraphics' private CGVirtualDisplay, which
/// Sidecar-like apps use), sized to the phone's screen in points and drawn at 2× like its own.
/// It goes away with this object; macOS moves its windows back to the other displays. Made and
/// changed on the main thread, which its descriptor names as its queue.
@MainActor
final class VirtualDisplay {
    nonisolated let id: CGDirectDisplayID
    private let display: NSObject
    private var sizes: [CGSize] = []

    private typealias InitObject = @convention(c) (Unmanaged<AnyObject>, Selector, AnyObject) -> Unmanaged<AnyObject>?
    private typealias InitMode = @convention(c) (Unmanaged<AnyObject>, Selector, UInt32, UInt32, Double) -> Unmanaged<AnyObject>?
    private typealias Apply = @convention(c) (AnyObject, Selector, AnyObject) -> ObjCBool

    /// Nil when this macOS has no virtual displays to offer.
    init?(name: String, size: CGSize) {
        guard let descriptorClass = NSClassFromString("CGVirtualDisplayDescriptor") as? NSObject.Type,
              let displayClass = NSClassFromString("CGVirtualDisplay") else { return nil }
        let descriptor = descriptorClass.init()
        let longest = UInt32(max(size.width, size.height))
        // Room for 2× of either orientation and some resizing (Stage Manager).
        let maxPixels = max(5120, longest * 2)
        // The same IDs every time, so macOS remembers where the display sits next to the others.
        let values: [String: Any] = [
            "queue": DispatchQueue.main, "name": name,
            "maxPixelsWide": maxPixels, "maxPixelsHigh": maxPixels,
            "sizeInMillimeters": NSValue(size: CGSize(width: size.width * 0.2, height: size.height * 0.2)),
            "vendorID": 0x4865, "productID": 0x6c6d, "serialNum": 0x0001,
        ]
        for (key, value) in values {
            guard Self.set(descriptor, key, value) else { return nil }
        }
        let initSelector = NSSelectorFromString("initWithDescriptor:")
        guard let made = Self.make(displayClass, initSelector, { implementation, allocated in
            unsafeBitCast(implementation, to: InitObject.self)(allocated, initSelector, descriptor)
        }) as? NSObject,
            let id = (made.value(forKey: "displayID") as? NSNumber)?.uint32Value, id != 0 else { return nil }
        display = made
        self.id = id
    }

    /// Shows the display at `size` points, 2×.
    func use(_ size: CGSize) async -> Bool {
        let width = Int(size.width.rounded()), height = Int(size.height.rounded())
        let size = CGSize(width: width, height: height)
        if sizes != [size] {
            // Only the one: macOS won't switch a virtual display to another of its modes.
            sizes = [size]
            guard apply() else {
                log("virtual display: applying \(width)×\(height) failed")
                return false
            }
        }
        // A new mode shows up in the list a moment later; the display starts in its 1× one.
        let options = [kCGDisplayShowDuplicateLowResolutionModes: true] as CFDictionary
        for _ in 0..<30 {
            let modes = CGDisplayCopyAllDisplayModes(id, options) as? [CGDisplayMode] ?? []
            if let mode = modes.filter({ $0.width == width && $0.height == height }).max(by: { $0.pixelWidth < $1.pixelWidth }) {
                if let current = CGDisplayCopyDisplayMode(id), current.width == width, current.height == height,
                   current.pixelWidth == mode.pixelWidth { return true }
                var config: CGDisplayConfigRef?
                guard CGBeginDisplayConfiguration(&config) == .success else { return false }
                CGConfigureDisplayWithDisplayMode(config, id, mode, nil)
                let result = CGCompleteDisplayConfiguration(config, .forSession)
                if result != .success { log("virtual display: switching to \(width)×\(height) failed: \(result.rawValue)") }
                return result == .success
            }
            try? await Task.sleep(for: .milliseconds(100))
        }
        let modes = (CGDisplayCopyAllDisplayModes(id, options) as? [CGDisplayMode] ?? []).map { "\($0.width)×\($0.height)" }
        log("virtual display: no \(width)×\(height) mode among \(modes)")
        return false
    }

    private func apply() -> Bool {
        guard let settingsClass = NSClassFromString("CGVirtualDisplaySettings") as? NSObject.Type,
              let modeClass = NSClassFromString("CGVirtualDisplayMode") else { return false }
        let modeSelector = NSSelectorFromString("initWithWidth:height:refreshRate:")
        let modes = sizes.compactMap { size in
            Self.make(modeClass, modeSelector) { implementation, allocated in
                unsafeBitCast(implementation, to: InitMode.self)(
                    allocated, modeSelector, UInt32(size.width), UInt32(size.height), 60)
            }
        }
        let settings = settingsClass.init()
        guard modes.count == sizes.count, Self.set(settings, "hiDPI", 1), Self.set(settings, "modes", modes) else { return false }
        let applySelector = NSSelectorFromString("applySettings:")
        guard display.responds(to: applySelector),
              let implementation = class_getMethodImplementation(object_getClass(display), applySelector) else { return false }
        return unsafeBitCast(implementation, to: Apply.self)(display, applySelector, settings).boolValue
    }

    /// `[[Class alloc] init…]` for an initializer Swift can't call by name.
    private static func make(_ type: AnyClass, _ selector: Selector,
                             _ call: (IMP, Unmanaged<AnyObject>) -> Unmanaged<AnyObject>?) -> AnyObject? {
        guard class_getInstanceMethod(type, selector) != nil,
              let implementation = class_getMethodImplementation(type, selector),
              let allocated = (type as AnyObject).perform(NSSelectorFromString("alloc")) else { return nil }
        return call(implementation, allocated)?.takeRetainedValue()
    }

    /// Key-value coding, only where the property exists (a missing one would raise).
    private static func set(_ object: NSObject, _ key: String, _ value: Any) -> Bool {
        let setter = NSSelectorFromString("set\(key.prefix(1).uppercased())\(key.dropFirst()):")
        guard object.responds(to: setter) else { return false }
        object.setValue(value, forKey: key)
        return true
    }
}

// MARK: Keeper

// The separate display outlives one connection for a while (the phone's choice), so an iPad that
// locks or switches apps comes back to its windows where it left them. A detached
// `helm-screen --keep-display` owns it; each connection's helper asks it over a Unix socket:
//   helper → keeper: {"name", "width", "height", "linger": seconds} per size, one JSON a line
//   keeper → helper: {"id": displayID} or {"error": "…"}
// With no helper connected the keeper waits `linger` seconds, then quits and the display goes.

let keeperSocketPath = (NSTemporaryDirectory() as NSString).appendingPathComponent("helm-screen-display.sock")

func keeperAddress() -> sockaddr_un {
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
        raw.copyBytes(from: Array(keeperSocketPath.utf8.prefix(raw.count - 1)))
    }
    return address
}

/// A connection to a running keeper, or -1.
func connectToKeeper() -> Int32 {
    let socket = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard socket >= 0 else { return -1 }
    var address = keeperAddress()
    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.connect(socket, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard connected == 0 else {
        close(socket)
        return -1
    }
    var on: Int32 = 1
    setsockopt(socket, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    return socket
}

func writeLine(_ socket: Int32, _ object: [String: Any]) -> Bool {
    guard var data = try? JSONSerialization.data(withJSONObject: object) else { return false }
    data.append(10)
    return data.withUnsafeBytes { raw in
        var offset = 0
        while offset < raw.count {
            let written = write(socket, raw.baseAddress! + offset, raw.count - offset)
            if written <= 0 { return false }
            offset += written
        }
        return true
    }
}

/// This helper's line to the keeper, which it starts if none runs.
final class KeeperLink: @unchecked Sendable {
    private var socket: Int32 = -1
    private let queue = DispatchQueue(label: "helm-screen.keeper")

    /// The display at `size` points, made or resized; nil if the keeper couldn't.
    func request(name: String, size: CGSize, linger: Int) async -> CGDirectDisplayID? {
        await withCheckedContinuation { continuation in
            queue.async {
                continuation.resume(returning: self.send(["name": name, "width": Double(size.width),
                                                          "height": Double(size.height), "linger": linger]))
            }
        }
    }

    private func send(_ request: [String: Any]) -> CGDirectDisplayID? {
        for attempt in 0..<2 {
            if socket < 0 { socket = connectOrStart() }
            guard socket >= 0 else { return nil }
            if writeLine(socket, request), let reply = readReply() {
                guard let id = reply["id"] as? Int else {
                    log("keeper: \(reply["error"] as? String ?? "no display")")
                    return nil
                }
                return CGDirectDisplayID(id)
            }
            // The keeper quit between connections: start another.
            Darwin.close(socket)
            socket = -1
            if attempt == 1 { return nil }
        }
        return nil
    }

    private func readReply() -> [String: Any]? {
        var line = Data()
        var byte: UInt8 = 0
        while read(socket, &byte, 1) == 1 {
            if byte == 10 { return (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] }
            line.append(byte)
        }
        return nil
    }

    private func connectOrStart() -> Int32 {
        let existing = connectToKeeper()
        if existing >= 0 { return existing }
        guard let path = Bundle.main.executablePath else { return -1 }
        // Its own session, so it outlives this helper; no inherited pipes, so the server sees
        // this helper's output end when it does.
        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT))
        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        for descriptor: Int32 in 0...2 {
            posix_spawn_file_actions_addopen(&actions, descriptor, "/dev/null", descriptor == 0 ? O_RDONLY : O_WRONLY, 0)
        }
        let arguments = [path, "--keep-display"].map { strdup($0) } + [nil]
        var pid: pid_t = 0
        let status = posix_spawn(&pid, path, &actions, &attributes, arguments, environ)
        arguments.forEach { free($0) }
        posix_spawn_file_actions_destroy(&actions)
        posix_spawnattr_destroy(&attributes)
        guard status == 0 else {
            log("keeper: couldn't start (\(status))")
            return -1
        }
        for _ in 0..<40 {
            usleep(50_000)
            let socket = connectToKeeper()
            if socket >= 0 { return socket }
        }
        return -1
    }

    func close() {
        queue.sync {
            if socket >= 0 { Darwin.close(socket) }
            socket = -1
        }
    }
}

/// The keeper's side: owns the display and quits once no helper has wanted it for a while.
@MainActor
final class Keeper {
    private let server: Int32
    private var accepting: DispatchSourceRead?
    private var clients: [Int32: DispatchSourceRead] = [:]
    private var buffers: [Int32: Data] = [:]
    private var display: VirtualDisplay?
    private var linger = 0
    private var quitting: DispatchWorkItem?

    init(server: Int32) {
        self.server = server
        let source = DispatchSource.makeReadSource(fileDescriptor: server, queue: .main)
        source.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.accept() } }
        source.resume()
        accepting = source
        // Started for a helper that connects right away; if none does, nothing to keep.
        quit(after: 15)
    }

    private func accept() {
        let client = Darwin.accept(server, nil, nil)
        guard client >= 0 else { return }
        var on: Int32 = 1
        setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        quitting?.cancel()
        quitting = nil
        let source = DispatchSource.makeReadSource(fileDescriptor: client, queue: .main)
        source.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.receive(client) } }
        source.resume()
        clients[client] = source
    }

    private func receive(_ client: Int32) {
        var chunk = [UInt8](repeating: 0, count: 4096)
        let count = read(client, &chunk, chunk.count)
        guard count > 0 else {
            clients.removeValue(forKey: client)?.cancel()
            buffers[client] = nil
            close(client)
            if clients.isEmpty { quit(after: linger) }
            return
        }
        var buffer = buffers[client, default: Data()]
        buffer.append(contentsOf: chunk[0..<count])
        while let newline = buffer.firstIndex(of: 10) {
            let line = buffer[buffer.startIndex..<newline]
            buffer = Data(buffer[(newline + 1)...])
            if let request = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] {
                Task { await self.answer(client, request) }
            }
        }
        buffers[client] = buffer
    }

    private func answer(_ client: Int32, _ request: [String: Any]) async {
        guard let width = request["width"] as? Double, let height = request["height"] as? Double else { return }
        linger = max(0, min(3600, request["linger"] as? Int ?? 0))
        let size = CGSize(width: width, height: height)
        if display == nil { display = VirtualDisplay(name: request["name"] as? String ?? "Helm", size: size) }
        guard let display else {
            _ = writeLine(client, ["error": "This Mac can't add a virtual display."])
            return
        }
        if await display.use(size) {
            _ = writeLine(client, ["id": Int(display.id)])
        } else {
            _ = writeLine(client, ["error": "The display couldn't take that size."])
        }
    }

    private func quit(after seconds: Int) {
        quitting?.cancel()
        let work = DispatchWorkItem {
            unlink(keeperSocketPath)
            exit(0)
        }
        quitting = work
        DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(seconds), execute: work)
    }
}

/// `helm-screen --keep-display`: one per Mac user; a second one finds the first and leaves.
func runKeeper() -> Never {
    signal(SIGPIPE, SIG_IGN)
    let existing = connectToKeeper()
    if existing >= 0 { exit(0) }
    unlink(keeperSocketPath)
    let server = socket(AF_UNIX, SOCK_STREAM, 0)
    var address = keeperAddress()
    let bound = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard server >= 0, bound == 0, listen(server, 4) == 0 else { exit(1) }
    let keeper = MainActor.assumeIsolated { Keeper(server: server) }
    withExtendedLifetime(keeper) {
        NSApplication.shared.setActivationPolicy(.prohibited)
        NSApp.run()
    }
    exit(0)
}

// MARK: Screen

/// What the phone asked to see.
enum Shown: Equatable {
    case main, display(CGDirectDisplayID), all, virtual

    init(_ value: Any?) {
        switch value {
        case let id as Int: self = .display(CGDirectDisplayID(id))
        case "all" as String: self = .all
        case "virtual" as String: self = .virtual
        default: self = .main
        }
    }
}

/// The displays the phone can pick from, in global points.
@MainActor
func displayList(virtual: CGDirectDisplayID?, name virtualName: String) -> [[String: Any]] {
    var ids = [CGDirectDisplayID](repeating: 0, count: 16)
    var count: UInt32 = 0
    CGGetActiveDisplayList(16, &ids, &count)
    return ids.prefix(Int(count)).compactMap { id in
        // A display mirroring another shows the same picture; it isn't one of its own.
        guard CGDisplayMirrorsDisplay(id) == kCGNullDirectDisplay else { return nil }
        let bounds = CGDisplayBounds(id)
        let screen = NSScreen.screens.first {
            ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id
        }
        let name = id == virtual ? virtualName : screen?.localizedName ?? "Display"
        return ["id": Int(id), "name": name,
                "x": Int(bounds.minX), "y": Int(bounds.minY), "width": Int(bounds.width), "height": Int(bounds.height),
                "main": CGDisplayIsMain(id) != 0, "virtual": id == virtual]
    }
}

/// The capture and what it shows. Changes go through `onScreen`, one at a time in order: an
/// actor alone would let the next command in while one waits for a display.
actor Screen {
    private var settings = StreamSettings()
    private var shown = Shown.main
    private var session: Session?
    private let keeper = KeeperLink()
    private var virtualID: CGDirectDisplayID?
    private var virtualName = "Helm"
    /// How long the separate display stays once the phone has gone.
    private var linger = 0

    func start(_ settings: StreamSettings, show wanted: Shown, virtualSize: CGSize?, name: String?, linger: Int) async {
        guard CGPreflightScreenCaptureAccess() else {
            CGRequestScreenCaptureAccess()
            emitJSON(["t": "error", "code": "screenRecording",
                      "message": "Allow Helm to record the screen in System Settings → Privacy & Security."])
            return
        }
        self.settings = settings
        if let name, !name.isEmpty { virtualName = name }
        self.linger = linger
        await show(wanted, virtualSize: virtualSize)
    }

    func show(_ wanted: Shown, virtualSize: CGSize?) async {
        if wanted == .virtual, let virtualSize { await makeVirtual(virtualSize) }
        shown = wanted
        await restart()
    }

    /// The phone turned or resized: the virtual display follows it.
    func resizeVirtual(_ size: CGSize) async {
        guard virtualID != nil else { return }
        guard await keeper.request(name: virtualName, size: size, linger: linger) != nil else {
            emitJSON(["t": "error", "code": "virtualDisplay", "message": "The display for the phone couldn't change its size."])
            return
        }
        if shown == .virtual || shown == .all { await restart() }
    }

    func keyframe() { session?.encoder.requestKeyframe() }

    func stop() async {
        await session?.stop()
        session = nil
        keeper.close()
    }

    /// Displays came, went or changed size: the phone's list follows, and so does the picture.
    func displaysChanged() async {
        await emitDisplays()
        guard let session,
              let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        else { return }
        let wanted = pick(content.displays).map(\.displayID)
        let frames = wanted.map { CGDisplayBounds($0) }
        let frame = frames.dropFirst().reduce(frames.first ?? .zero) { $0.union($1) }
        if wanted != session.displayIDs || frame != session.frame { await restart() }
    }

    func stopped(_ stopped: Session, _ error: Error) async {
        guard stopped === session else { return }
        if shown != .main {
            // Its display went away: back to the main one.
            shown = .main
            await restart()
        } else {
            emitJSON(["t": "error", "code": "capture", "message": error.localizedDescription])
            exit(1)
        }
    }

    private func makeVirtual(_ size: CGSize) async {
        guard let id = await keeper.request(name: virtualName, size: size, linger: linger) else {
            emitJSON(["t": "error", "code": "virtualDisplay", "message": "This Mac couldn't add a display for the phone."])
            return
        }
        virtualID = id
        // It can be captured a moment after it appears.
        for _ in 0..<30 {
            if let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true),
               content.displays.contains(where: { $0.displayID == id }) { return }
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    private func pick(_ displays: [SCDisplay]) -> [SCDisplay] {
        let main = displays.first { $0.displayID == CGMainDisplayID() } ?? displays.first
        let fallback = main.map { [$0] } ?? []
        switch shown {
        case .main: return fallback
        case .display(let id): return displays.first { $0.displayID == id }.map { [$0] } ?? fallback
        case .virtual: return displays.first { $0.displayID == virtualID }.map { [$0] } ?? fallback
        case .all:
            let own = displays.filter { CGDisplayMirrorsDisplay($0.displayID) == kCGNullDirectDisplay }
            return own.isEmpty ? fallback : own
        }
    }

    private func restart() async {
        await session?.stop()
        session = nil
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            let displays = pick(content.displays)
            guard !displays.isEmpty else {
                emitJSON(["t": "error", "code": "noDisplay", "message": "No display to share."])
                return
            }
            let session = Session(displays: displays, settings: settings)
            session.stopped = { stopped, error in onScreen { await screen.stopped(stopped, error) } }
            self.session = session
            try await session.start(displays)
            shownFrame.value = session.frame
            await emitDisplays()
            var info: [String: Any] = [
                "t": "info", "width": Int(session.frame.width), "height": Int(session.frame.height),
                "videoWidth": Int(session.videoSize.width), "videoHeight": Int(session.videoSize.height),
                "accessibility": AXIsProcessTrusted(),
                "display": displays.count > 1 ? "all" as Any : Int(displays[0].displayID) as Any,
            ]
            if let virtualID { info["virtual"] = Int(virtualID) }
            emitJSON(info)
        } catch {
            await session?.stop()
            session = nil
            emitJSON(["t": "error", "code": "capture", "message": error.localizedDescription])
        }
    }

    private func emitDisplays() async {
        let virtualID = virtualID, name = virtualName
        let list = await MainActor.run { displayList(virtual: virtualID, name: name) }
        emitJSON(["t": "displays", "displays": list])
    }
}

// MARK: Cursor

/// Reports where the cursor is, in the shown frame's points from its top-left, whenever it moves.
final class CursorWatch: @unchecked Sendable {
    private var timer: DispatchSourceTimer?
    private var last = CGPoint(x: -1, y: -1)

    func start() {
        guard timer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: .milliseconds(16))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            // CGEvent's location is in global points with a top-left origin, like CGDisplayBounds.
            guard let location = CGEvent(source: nil)?.location else { return }
            let frame = shownFrame.value
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
    private var warnedAccessibility = false

    private func global(_ x: Double, _ y: Double) -> CGPoint {
        let frame = shownFrame.value
        return CGPoint(x: frame.minX + min(max(0, x), frame.width - 1),
                       y: frame.minY + min(max(0, y), frame.height - 1))
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

// MARK: Clipboard

/// The Mac's copied text goes to the phone as it's copied; the phone's comes in to be pasted.
@MainActor
final class Clipboard {
    private var seen = NSPasteboard.general.changeCount
    private var timer: Timer?

    func start() {
        guard timer == nil else { return }
        seen = NSPasteboard.general.changeCount
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.check() }
        }
    }

    private func check() {
        let pasteboard = NSPasteboard.general
        guard pasteboard.changeCount != seen else { return }
        seen = pasteboard.changeCount
        guard let text = pasteboard.string(forType: .string), !text.isEmpty, text.utf8.count <= 1_000_000 else { return }
        emitJSON(["t": "clipboard", "text": text])
    }

    /// The phone's text, ready for ⌘V; not echoed back.
    func set(_ text: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        seen = pasteboard.changeCount
    }
}

// MARK: Main

let screen = Screen()
let (screenWork, screenQueue) = AsyncStream.makeStream(of: (@Sendable () async -> Void).self)
Task { for await work in screenWork { await work() } }

func onScreen(_ work: @escaping @Sendable () async -> Void) {
    screenQueue.yield(work)
}
let input = Input()
let cursor = CursorWatch()
let clipboard = MainActor.assumeIsolated { Clipboard() }

/// `{"width", "height"}` in points, within what a display can be.
func size(_ value: Any?) -> CGSize? {
    guard let object = value as? [String: Any],
          let width = object["width"] as? Double, let height = object["height"] as? Double,
          (320...4096).contains(width), (320...4096).contains(height) else { return nil }
    return CGSize(width: width, height: height)
}

// Commands:
//   start        {maxWidth, fps, bitrate, audio?, clipboard?, display?, virtual?: {width, height},
//                 name?, keepDisplay?: seconds the separate display stays after this connection}
//   show         {display: "main" | "all" | "virtual" | id, virtual?: {width, height}}
//   virtualSize  {width, height}: the phone turned or its window changed
//   clipboard    {text}: the phone's copied text, for the Mac's clipboard
//   keyframe, move {x, y}, button {b, down, x, y}, scroll {dx, dy}, key {code, mods}, text {s}, stop
func handle(_ line: String) {
    guard let data = line.data(using: .utf8),
          let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = command["t"] as? String else { return }
    let x = command["x"] as? Double ?? 0, y = command["y"] as? Double ?? 0
    switch type {
    case "start":
        let settings = StreamSettings(maxWidth: command["maxWidth"] as? Int ?? 3024,
                                      fps: command["fps"] as? Int ?? 30,
                                      bitrate: command["bitrate"] as? Int ?? 8_000_000,
                                      audio: command["audio"] as? Bool ?? false)
        let shown = Shown(command["display"])
        let virtualSize = size(command["virtual"])
        let name = command["name"] as? String
        let linger = command["keepDisplay"] as? Int ?? 0
        let sharesClipboard = command["clipboard"] as? Bool ?? false
        onScreen {
            await screen.start(settings, show: shown, virtualSize: virtualSize, name: name, linger: linger)
            DispatchQueue.main.async {
                cursor.start()
                if sharesClipboard { MainActor.assumeIsolated { clipboard.start() } }
            }
        }
    case "show":
        let shown = Shown(command["display"])
        let virtualSize = size(command["virtual"])
        onScreen { await screen.show(shown, virtualSize: virtualSize) }
    case "virtualSize":
        guard let size = size(command) else { return }
        onScreen { await screen.resizeVirtual(size) }
    case "keyframe": Task { await screen.keyframe() }
    case "clipboard":
        guard let text = command["text"] as? String else { return }
        DispatchQueue.main.async { MainActor.assumeIsolated { clipboard.set(text) } }
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
        onScreen { await screen.stop(); exit(0) }
    default: break
    }
}

if CommandLine.arguments.contains("--check") {
    // `helm-screen --check`: what this Mac allows, for the server's capability probe.
    let result = ["screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()]
    print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
    exit(0)
}

if CommandLine.arguments.contains("--keep-display") { runKeeper() }

signal(SIGPIPE, SIG_IGN)
// Displays plugged in, removed or resized; one look once they settle.
var reconfiguration = 0
CGDisplayRegisterReconfigurationCallback({ _, flags, _ in
    guard !flags.contains(.beginConfigurationFlag) else { return }
    reconfiguration += 1
    let current = reconfiguration
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
        guard current == reconfiguration else { return }
        onScreen { await screen.displaysChanged() }
    }
}, nil)
Thread.detachNewThread {
    while let line = readLine() { handle(line) }
    // stdin closed: the server let go of us.
    exit(0)
}
NSApplication.shared.setActivationPolicy(.prohibited)
// The app's own event loop, not just the run loop: display changes (a virtual display's modes,
// NSScreen's list) reach an NSApplication only through it.
NSApp.run()
