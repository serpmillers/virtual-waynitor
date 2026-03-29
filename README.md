# Virtual Waynitor

> Headless virtual monitor for Hyprland (Wayland) with WebRTC browser streaming.

Stream your `HEADLESS-1` virtual display to any browser — no plugins, no HDMI dummy plug, no X11.

> [!WARNING]
> **Project Status (WIP)**
> This tool currently revolves around local testing using SSH tunneling. While the core features (like Headless Monitor management and capturing WebRTC video feeds) are firmly implemented and functioning, the capability to work natively over LAN or external networks is a work in progress.

## Roadmap

- [x] Create and manage headless monitor in Hyprland
- [x] Capture virtual screen via browser `getDisplayMedia`
- [x] Initial signaling server implementation (local WebSockets)
- [x] P2P WebRTC streaming
- [ ] Network NAT traversal (TURN Server) for reliable non-local streaming
- [ ] Decouple signaling server (Render) from local API (cclab machine)
- [ ] Static frontend deployment (Vercel)

---

## How it works

```
Browser on host machine          Signaling server (Node.js)         Any browser (viewer)
  ┌──────────────────┐              ┌──────────────────┐           ┌──────────────────┐
  │  host.html       │◄─ WebSocket ─►  server.js        ◄─ WebSocket ─►  client.html   │
  │  getDisplayMedia │              │  WS relay + API  │           │  <video> player  │
  │  RTCPeerConn     │◄─────────── WebRTC P2P (video) ────────────►│  RTCPeerConn     │
  └──────────────────┘              └──────────────────┘           └──────────────────┘
```

1. The **host page** captures the `HEADLESS-1` virtual output via `getDisplayMedia`
2. The **signaling server** relays WebRTC offer/answer/ICE messages between peers
3. The **viewer page** receives the video stream directly via WebRTC P2P

---

## Stack

| Layer | Tool |
|---|---|
| Compositor | Hyprland + wlroots headless backend |
| Display capture | `getDisplayMedia` via xdg-desktop-portal-hyprland |
| Signaling | Node.js WebSocket server (`ws`) |
| Streaming | WebRTC (browser-native, peer-to-peer) |
| A/V pipeline | PipeWire + WirePlumber |

---

## Requirements

| Package | Purpose |
|---|---|
| `hyprland` | Compositor with headless backend support |
| `pipewire` + `wireplumber` | Audio/video pipeline for screen capture |
| `xdg-desktop-portal-hyprland` | Lets the browser access the display via the portal |
| `wf-recorder` | (Optional) used for verification |
| `nodejs` ≥ 18, `npm` | Runs the signaling server |

---

## Setup

```bash
chmod +x setup.sh
./setup.sh
```

The script runs interactively through five phases:

| Phase | What it does |
|---|---|
| 1 — Preflight | Checks all required tools are installed |
| 2 — `/etc/environment` | Writes the three wlroots env vars (requires sudo) |
| 3 — Hyprland config | Appends `HEADLESS-1` monitor and workspace 10 binding |
| 4 — Verify | Confirms `HEADLESS-1` is live via `hyprctl monitors` |
| 5 — npm install | Installs Node.js dependencies |

> **After setup** — restart Hyprland if you changed `/etc/environment` or your monitor config for the changes to take effect.

---

## Usage

```bash
npm start
```

| URL | Who opens it | Purpose |
|---|---|---|
| `http://localhost:3000/` | Browser **on the host machine** | Capture & stream |
| `http://localhost:3000/client` | Any browser on the **same network** | Watch the stream |
| `http://<host-ip>:3000/client` | Remote viewer (same LAN) | Watch the stream |

### Host workflow
1. Open `http://localhost:3000/` on the Linux machine running Hyprland
2. Click **Capture HEADLESS** — select workspace 10 or the `HEADLESS-1` output in the portal picker
3. Click **Start Streaming**
4. Share the `/client` URL with viewers

### Viewer
Navigate to `/client` — the stream appears automatically when the host starts broadcasting.  
Double-click the video or use the **⛶ Fullscreen** button.

---

## REST API

These endpoints are used by `host.html` to manage the headless monitor. All return JSON.

| Endpoint | Method | Description |
|---|---|---|
| `/api/status` | GET | Headless monitor state, streaming status, viewer count |
| `/api/monitors` | GET | `hyprctl monitors` output |
| `/api/windows` | GET | Windows currently on `HEADLESS-1` |
| `/api/move-window` | POST | Move a window to workspace 10 — body: `{ windowAddress, workspace }` |
| `/api/focus-monitor` | POST | Move keyboard focus to `HEADLESS-1` |

---

## Manual environment setup

If you prefer not to use `/etc/environment`, add these to your Hyprland config:

```ini
# ~/.config/hypr/hyprland.conf

# Enable the headless wlroots backend alongside DRM
env = WLR_BACKENDS,drm,headless
env = WLR_RENDERER,vulkan
env = WLR_NO_HARDWARE_CURSORS,1

# Bind the virtual monitor to workspace 10
monitor = HEADLESS-1, 1920x1080@60, auto, 1
workspace = 10, monitor:HEADLESS-1, default:true
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `HEADLESS-1` missing in `hyprctl monitors` | Ensure `WLR_BACKENDS=drm,headless` is set before Hyprland starts (restart session) |
| Portal picker doesn't show `HEADLESS-1` | Restart `xdg-desktop-portal-hyprland`; check `XDG_CURRENT_DESKTOP=Hyprland` is set |
| Black video on viewer | Move a window to workspace 10 so `HEADLESS-1` has content to capture |
| NVIDIA EGL errors | Use `WLR_RENDERER=vulkan`; ensure `nvidia_drm.modeset=1` is a kernel parameter |
| P2P connection fails across networks | WebRTC needs a TURN server for NAT traversal across different networks; on the same LAN STUN is sufficient |
| High latency | Use wired LAN; browser WebRTC uses software encoding (no NVENC/VAAPI in this path) |

---

## License

MIT