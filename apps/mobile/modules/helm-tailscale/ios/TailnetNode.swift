import Darwin
import Foundation
import UIKit

// Helm fork: the app's own Tailscale node (tsnet through libtailscale), so the
// phone reaches Helm machines on the user's tailnet without the Tailscale VPN
// app. Nothing is routed at the OS level: each tailnet address the app talks
// to gets a loopback port, and connections to that port are dialed through
// the node. One node per app process; its state survives relaunches.
final class TailnetNode {
  static let shared = TailnetNode()

  private let queue = DispatchQueue(label: "helm.tailscale.node")
  private var handle: Int32 = -1
  private var forwarders: [String: TailnetForwarder] = [:]
  private let forwardersLock = NSLock()

  private init() {
    // iOS may reclaim listening sockets of a suspended app; rebind on return.
    NotificationCenter.default.addObserver(
      forName: UIApplication.willEnterForegroundNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      self?.rebindForwarders()
    }
  }

  static var stateDirectory: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("helm-tailscale", isDirectory: true)
  }

  /// True once a node has run here; its login lives in the state directory.
  var hasState: Bool {
    FileManager.default.fileExists(atPath: Self.stateDirectory.path)
  }

  /// Starts the node without waiting for login. A node that needs login
  /// reports an auth URL in its status shortly after.
  func start(hostname: String) throws {
    try queue.sync {
      if handle >= 0 { return }
      try FileManager.default.createDirectory(
        at: Self.stateDirectory, withIntermediateDirectories: true)
      let node = tailscale_new()
      guard node >= 0 else { throw TailnetError("Could not create the Tailscale node") }
      tailscale_set_logfd(node, -1)
      _ = Self.stateDirectory.path.withCString { tailscale_set_dir(node, $0) }
      _ = hostname.withCString { tailscale_set_hostname(node, $0) }
      if tailscale_start(node) != 0 {
        let message = Self.errorMessage(node)
        tailscale_close(node)
        throw TailnetError(message)
      }
      handle = node
    }
  }

  func statusJSON() throws -> String? {
    let node = queue.sync { handle }
    if node < 0 { return nil }
    var output: UnsafeMutablePointer<CChar>?
    if tailscale_status_json(node, &output) != 0 {
      throw TailnetError(Self.errorMessage(node))
    }
    guard let output else { return nil }
    defer { free(output) }
    return String(cString: output)
  }

  /// Stops the node and forgets its login. The device stays listed in the
  /// tailnet's admin console until removed there.
  func logout() {
    queue.sync {
      if handle >= 0 {
        tailscale_close(handle)
        handle = -1
      }
      try? FileManager.default.removeItem(at: Self.stateDirectory)
    }
  }

  /// Loopback port that tunnels to `host:port` on the tailnet. Stable for the
  /// life of the process, so URLs built from it stay valid across suspension.
  func forward(host: String, port: Int) throws -> Int {
    let target = host.contains(":") ? "[\(host)]:\(port)" : "\(host):\(port)"
    forwardersLock.lock()
    defer { forwardersLock.unlock() }
    if let existing = forwarders[target] { return Int(existing.localPort) }
    let forwarder = TailnetForwarder(target: target) { [weak self] in
      self?.dial(target: target) ?? -1
    }
    try forwarder.bind()
    forwarders[target] = forwarder
    return Int(forwarder.localPort)
  }

  private func dial(target: String) -> Int32 {
    let node = queue.sync { handle }
    if node < 0 { return -1 }
    var connection: Int32 = -1
    let result = "tcp".withCString { network in
      target.withCString { address in tailscale_dial(node, network, address, &connection) }
    }
    return result == 0 ? connection : -1
  }

  private func rebindForwarders() {
    forwardersLock.lock()
    let all = Array(forwarders.values)
    forwardersLock.unlock()
    for forwarder in all { try? forwarder.bind() }
  }

  private static func errorMessage(_ node: Int32) -> String {
    var buffer = [CChar](repeating: 0, count: 1024)
    if tailscale_errmsg(node, &buffer, buffer.count) != 0 { return "Tailscale error" }
    return String(cString: buffer)
  }
}

struct TailnetError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

/// Accepts loopback connections and pipes each one to a fresh tailnet dial.
final class TailnetForwarder {
  let target: String
  private(set) var localPort: UInt16 = 0
  private let dial: () -> Int32
  private let lock = NSLock()
  private var listener: Int32 = -1

  init(target: String, dial: @escaping () -> Int32) {
    self.target = target
    self.dial = dial
  }

  /// (Re)opens the listener, on the same port after the first bind.
  func bind() throws {
    lock.lock()
    defer { lock.unlock() }
    if listener >= 0 {
      close(listener)
      listener = -1
    }
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { throw TailnetError("socket() failed: \(errno)") }
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, socklen_t(MemoryLayout<Int32>.size))
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = localPort.bigEndian
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard bound == 0, listen(fd, 64) == 0 else {
      let code = errno
      close(fd)
      throw TailnetError("Could not listen on loopback for \(target): \(code)")
    }
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
    }
    localPort = UInt16(bigEndian: address.sin_port)
    listener = fd
    let thread = Thread { [weak self] in self?.acceptLoop(fd) }
    thread.name = "helm.tailscale.accept"
    thread.start()
  }

  private func acceptLoop(_ fd: Int32) {
    while true {
      let client = accept(fd, nil, nil)
      if client < 0 {
        if errno == EINTR { continue }
        return  // closed by a rebind, or reclaimed by the system
      }
      Self.noSigPipe(client)
      DispatchQueue.global(qos: .userInitiated).async { [dial] in
        let remote = dial()
        guard remote >= 0 else {
          close(client)
          return
        }
        Self.noSigPipe(remote)
        Self.pipe(client, remote)
      }
    }
  }

  private static func noSigPipe(_ fd: Int32) {
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
  }

  /// Copies both directions until each side closes, then closes both.
  private static func pipe(_ a: Int32, _ b: Int32) {
    let group = DispatchGroup()
    for (source, destination) in [(a, b), (b, a)] {
      group.enter()
      Thread {
        copy(from: source, to: destination)
        shutdown(destination, SHUT_WR)
        group.leave()
      }.start()
    }
    group.notify(queue: .global()) {
      close(a)
      close(b)
    }
  }

  private static func copy(from source: Int32, to destination: Int32) {
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
      let count = buffer.withUnsafeMutableBytes { read(source, $0.baseAddress, $0.count) }
      if count < 0, errno == EINTR { continue }
      if count <= 0 { return }
      var offset = 0
      while offset < count {
        let written = buffer.withUnsafeBytes {
          write(destination, $0.baseAddress! + offset, count - offset)
        }
        if written < 0, errno == EINTR { continue }
        if written <= 0 { return }
        offset += written
      }
    }
  }
}
