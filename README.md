# BridgeDesk

Simple, lightweight remote desktop access: connect by ID, see the other screen, control mouse and keyboard.

```
 Computer A (you)                             Computer B (controlled)
 ┌──────────────────┐   1) find by ID        ┌──────────────────────┐
 │ web page or      │ ◄── signaling server ─►│ BridgeDesk desktop   │
 │ desktop app      │                        │ app (Electron)       │
 │                  │ ◄═══ 2) direct ═══════►│                      │
 │ view the screen, │   WebRTC connection    │ shares the screen,   │
 │ send mouse and   │   (encrypted)          │ performs mouse and   │
 │ keyboard         │                        │ keyboard input       │
 └──────────────────┘                        └──────────────────────┘
```

* **Signaling server** — the free public PeerJS server. It only introduces the two computers; the video never passes through it.
* **The connection** is direct (P2P) and encrypted (DTLS-SRTP). If the network blocks direct connections it falls back to a TURN relay.

## Structure

```
web/      web page (Cloudflare Pages / GitHub Pages) — the same UI is used inside the app
  config.js   ← settings (ID prefix, signaling server, TURN, download link)
agent/    desktop app (Electron)
  main.js       window, tray, screen capture, updates
  input.js      mouse/keyboard (SendInput on Windows, nut-js on macOS/Linux)
.github/workflows/
  build-agent.yml   builds Windows / macOS installers and publishes them to Releases
  pages.yml         publishes web/ to GitHub Pages
```

## Video engines

* **GPU (Turbo)** — WebCodecs hardware H.264 encoder on the host (Intel Quick Sync / NVIDIA NVENC / AMD AMF via Media Foundation),
  fragments sent over an unordered, partially reliable DataChannel, hardware decoding on the viewer, only the newest frame is drawn.
  Stale frames are dropped instead of queued; a lost frame triggers a keyframe request. Used automatically when the host has a hardware encoder.
* **Standard (WebRTC)** — fallback; Chromium encodes screen video in software on most Windows machines.

Performance modes: **Automatic** (1080p60, steps down 900p → 720p → 540p on measured drops/congestion and back up when calm),
**Balanced** (1080p60), **High quality** (up to 1440p60, sharper text), **Max performance** (720p60, lowest latency).

## Features

* 9-digit ID, one-time password or Accept/Decline prompt
* Permanent password for unattended access (stored as a salted hash; changing or removing it requires the current password)
* Lock-out for 1 minute after 5 wrong passwords
* Quality modes: High 1080p60 · Native · Smooth · Low bandwidth 720p
* Multiple monitors, two-way clipboard sync, Win and Alt+Tab buttons, full screen
* Live latency / resolution / fps / bitrate / connection type, diagnostics panel
* Automatic updates from GitHub Releases
* Lightweight: no HTTP disk cache, background work only during a session

## Publishing

1. Create a GitHub organization (e.g. `bridgedesk-app`) and a repository `bridgedesk`, and push this project.
   If you use different names, update `agent/package.json` (`build.publish`, `repository`) and `web/config.js` (`downloadUrl`).
2. **Web page** — Cloudflare → Workers & Pages → Create → Pages → Connect to Git.
   Build command: *(empty)*. Build output directory: **`web`**.
3. **Installers** — bump `version` in `agent/package.json`, then `git tag v0.3.0 && git push --tags`.
   GitHub Actions builds the Windows and macOS installers and publishes them to Releases; installed apps update themselves.

Local development:
```bash
cd agent
npm install
npm start
```

## First launch

**Windows** — SmartScreen may say “unknown publisher” (the app is not code-signed yet) → *More info → Run anyway*.

**macOS** — open it, then *System Settings → Privacy & Security → Open Anyway*. If this Mac will be controlled, enable **Screen Recording** and **Accessibility** for BridgeDesk (the app shows buttons that open the right settings page).

## Known limitations

* Ctrl+Alt+Del, the Windows sign-in screen and UAC prompts cannot be controlled by a regular app (needs a Windows service — planned).
* Windows running “as administrator” on the remote computer only accept input if BridgeDesk also runs as administrator (Settings).
* The public PeerJS server has no uptime guarantee. For company use, run your own (`npx peerjs --port 9000`) and/or a TURN server, and set them in `web/config.js`.

## Palette
`#000000` black · `#14213D` navy · `#FCA311` gold · `#E5E5E5` silver · `#FFFFFF` white
