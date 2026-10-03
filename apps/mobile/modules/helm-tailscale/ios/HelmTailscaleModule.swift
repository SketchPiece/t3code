import ExpoModulesCore

// Helm fork: JS surface of TailnetNode. See src/features/tailscale in the
// mobile app (apps/mobile/helm/tailscale) for how URLs are routed through it.
@ExpoModule("HelmTailscale")
public final class HelmTailscaleModule: Module {
  public func definition() -> ModuleDefinition {
    Function("hasState") { () -> Bool in
      TailnetNode.shared.hasState
    }

    AsyncFunction("start") { (hostname: String) in
      try TailnetNode.shared.start(hostname: hostname)
    }

    /// ipnstate.Status as JSON, or null while the node is stopped.
    AsyncFunction("statusJson") { () -> String? in
      try TailnetNode.shared.statusJSON()
    }

    AsyncFunction("logout") {
      TailnetNode.shared.logout()
    }

    // Synchronous so a WebSocket constructor can rewrite its URL in place.
    Function("forward") { (host: String, port: Int) -> Int in
      try TailnetNode.shared.forward(host: host, port: port)
    }
  }
}
