// Fake Helm: listens on the socket, signs like the phone would.
import Foundation
import CryptoKit
let mode = CommandLine.arguments[1]  // approve | deny | badsig | silent; then socket path, work dir
let sockPath = CommandLine.arguments[2]
let key: P256.Signing.PrivateKey
let dir = CommandLine.arguments[3]
let keyFile = "\(dir)/key.raw"
if let d = FileManager.default.contents(atPath: keyFile) { key = try! .init(rawRepresentation: d) } else { key = .init(); FileManager.default.createFile(atPath: keyFile, contents: key.rawRepresentation) }
try! (key.publicKey.x963Representation.base64EncodedString() + "\n").write(toFile: "\(dir)/approvers", atomically: true, encoding: .utf8)
unlink(sockPath)
let fd = socket(AF_UNIX, SOCK_STREAM, 0)
var addr = sockaddr_un(); addr.sun_family = sa_family_t(AF_UNIX)
withUnsafeMutableBytes(of: &addr.sun_path) { p in _ = sockPath.withCString { strcpy(p.baseAddress!.assumingMemoryBound(to: CChar.self), $0) } }
withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { _ = bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
listen(fd, 1)
print("ready"); fflush(stdout)
let c = accept(fd, nil, nil)
var buf = [UInt8](repeating: 0, count: 8192); let n = read(c, &buf, 8192)
let req = try! JSONSerialization.jsonObject(with: Data(buf[0..<n])) as! [String: Any]
print("request:", req)
_ = "{\"status\":\"pending\"}\n".withCString { write(c, $0, strlen($0)) }
if mode == "silent" { sleep(10); exit(0) }
let msg = "helm-sudo-v1\n\(req["nonce"]!)\n\(req["user"]!)\n\(req["host"]!)\n\(req["command"]!)" + (mode == "badsig" ? "x" : "")
let sig = try! key.signature(for: Data(msg.utf8)).derRepresentation.base64EncodedString()
let reply = mode == "deny" ? "{\"status\":\"denied\"}\n" : "{\"status\":\"approved\",\"signature\":\"\(sig)\"}\n"
_ = reply.withCString { write(c, $0, strlen($0)) }
close(c)
