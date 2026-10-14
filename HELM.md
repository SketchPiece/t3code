# Helm

Helm is my personal distribution of [T3 Code](https://github.com/pingdotgg/t3code), the open-source
control surface for coding agents (Claude Code, Codex, Cursor, OpenCode and more). It tracks upstream
closely: a scheduled task merges every upstream nightly into the `helm` branch and ships it as a signed
Helm release together with Helm's own changes. Upstream features land here within a day; Helm adds a
layer on top.

Companion app: **[Helm Mobile](https://github.com/SketchPiece/helm-mobile)**, a native SwiftUI client
for iPhone and iPad.

## What Helm adds

**Phone and iPad as first-class clients**

- **Screen remote (experimental).** `/api/helm/screen` streams the Mac's screen to Helm Mobile (HEVC at
  the phone's frame rate, the Mac's cursor shape and sound, a shared clipboard) and takes the phone's mouse
  and keys. It can pick a display, show all of them, add a virtual display sized to the device, and bring
  windows over from other displays.
- **Mac remote.** Helm Mobile can open a thread on the Mac, type into its composer, scroll its timeline like
  a trackpad and send the draft, without bringing the window forward.
- **Shared drafts.** Unsent drafts, text and uploads, sync between Helm and Helm Mobile.
- **Pairing without friction.** Phones on the tailnet ask to pair and the Mac approves; devices on the local
  network pair with an AirPlay-style code; the server announces itself over Bonjour.
- **Tailnet access without the Tailscale app**, with connections refused until the phone has logged in.
- **Agent alerts and Live Activity** through a self-hosted push relay instead of T3 Connect.

**Voice**

- Dictation in the web and mobile composers: hold the mic to talk and release to send, retry a failed take,
  and coding words hinted to the transcriber so they stay in Latin script.

**Agents**

- MCP tools that let an agent start threads with other agents and talk to them.

**Identity and design**

- Its own app identity next to T3 Code: name, icon, keychain item, data directory, and port 3783 (falling
  back to the next ports), so both apps can be installed side by side. T3 Code's threads are imported only
  when asked.
- The "Bakelite" theme: a warm palette with an amber lamp as the action color, IBM Plex type and an
  Unbounded wordmark, a Bakelite splash and installer window.
- Russian localization across web, desktop and mobile copy.

**Shipping**

- `scripts/helm-release.sh` builds and publishes signed releases to this repository; every update is
  launch-checked before it is published, and the desktop app installs updates automatically once local
  threads are idle.
- [`scripts/helm-upstream-sync.md`](scripts/helm-upstream-sync.md): the daily upstream sync procedure.

## Branches

- `helm` (default): upstream T3 Code plus everything above.
- Upstream lives at [pingdotgg/t3code](https://github.com/pingdotgg/t3code); its README follows in
  [README.md](README.md).

Helm is a personal project and is not affiliated with T3 Tools Inc. Like T3 Code, it is MIT-licensed.
