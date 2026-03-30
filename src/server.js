// =============================================================================
//  virtual-waynitor — server.js
//
//  Single-process server that handles three responsibilities:
//    1. HTTP — serves the host and client static pages
//    2. REST API — exposes hyprctl data and window management actions
//    3. WebSocket signaling — relays WebRTC offer/answer/ICE between host and viewers
//
//  The server also manages the lifecycle of the HEADLESS-1 virtual monitor:
//  it enables the monitor on startup and disables it on shutdown, so the
//  workspace stays hidden when the server isn't running.
// =============================================================================

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { execSync, exec } = require('child_process');

const PORT   = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

// ── Firewall management state ─────────────────────────────────────────────────
// Detects and manages firewall rules (firewalld/ufw) to allow WebRTC P2P
// connections from other devices on the LAN.
let activeFirewall = null;
let portsOpened    = false;

// ── Connection state ──────────────────────────────────────────────────────────
// Only one host is allowed at a time; any number of viewers can connect.
let hostSocket = null;
const viewers  = new Set();

// ── Headless monitor state ────────────────────────────────────────────────────
// Populated by ensureHeadlessMonitor() at startup.
// weCreatedHeadless tracks whether this process enabled the monitor so we
// know whether to clean it up on exit.
let activeHeadless    = null;
let weCreatedHeadless = false;

// ── hyprctl helpers ───────────────────────────────────────────────────────────
// Thin wrappers around hyprctl that always request JSON output.
// Return null on error rather than crashing — callers handle the null case.

function hyprctl(args) {
  try {
    return JSON.parse(execSync(`hyprctl ${args} -j`, { timeout: 2000 }).toString());
  } catch {
    return null;
  }
}

function getMonitors() {
  return hyprctl('monitors') || [];
}

function getClients() {
  return hyprctl('clients') || [];
}

// Returns the active HEADLESS-1 monitor object, falling back to any other
// HEADLESS-* monitor if HEADLESS-1 is not found. Returns null when none exist.
function getHeadlessMonitor() {
  const monitors = hyprctl('monitors all') || [];
  if (!Array.isArray(monitors)) return null;
  return monitors.find(m => m.name === 'HEADLESS-1')
      || monitors.find(m => m.name && m.name.startsWith('HEADLESS-'))
      || null;
}

// Returns true only when a headless monitor is tracked and currently enabled.
function headlessActive() {
  return activeHeadless !== null && !activeHeadless.disabled;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // ── REST API endpoints ──────────────────────────────────────────────────────

  // Reports the current state of the headless monitor, streaming, and viewer count.
  if (url === '/api/status') {
    const monitors = getMonitors();
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    res.end(JSON.stringify({
      headless: !!activeHeadless,
      headlessMonitor: activeHeadless ? activeHeadless.name : null,
      monitors: monitors.map(m => ({ name: m.name, resolution: `${m.width}x${m.height}@${Math.round(m.refreshRate)}`, active: m.activeWorkspace?.id })),
      streaming: hostSocket !== null,
      viewers: viewers.size,
    }));
    return;
  }

  // Returns the full hyprctl monitor list as JSON.
  if (url === '/api/monitors') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    res.end(JSON.stringify(getMonitors() || []));
    return;
  }

  // Returns client windows currently living on the HEADLESS monitor.
  if (url === '/api/windows') {
    const clients = getClients();
    const monName = activeHeadless?.name;
    const headlessClients = monName
      ? (clients || []).filter(c => c.monitor === monName)
      : [];
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    res.end(JSON.stringify(headlessClients));
    return;
  }

  // Moves a window (by address) to a given workspace on the headless monitor.
  if (url === '/api/move-window' && req.method === 'POST') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      try {
        const { windowAddress, workspace } = JSON.parse(body);
        const ws = workspace || 10;
        exec(`hyprctl dispatch movetoworkspacesilent ${ws},address:${windowAddress}`, (err) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders() });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
            res.end(JSON.stringify({ ok: true }));
          }
        });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders() });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
      }
    });
    return;
  }

  // Moves keyboard and cursor focus to the headless monitor in Hyprland.
  if (url === '/api/focus-monitor' && req.method === 'POST') {
    if (!activeHeadless) {
      res.writeHead(503, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ ok: false, error: 'No headless monitor active.' }));
      return;
    }
    exec(`hyprctl dispatch focusmonitor ${activeHeadless.name}`, () => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ ok: true, monitor: activeHeadless.name }));
    });
    return;
  }

  // ── Static file routes ──────────────────────────────────────────────────────
  // The host page is the broadcaster UI; the client page is the viewer UI.

  let filePath;
  if (url === '/' || url === '/host' || url === '/host.html') {
    filePath = path.join(PUBLIC, 'host.html');
  } else if (url === '/client' || url === '/client.html') {
    filePath = path.join(PUBLIC, 'client.html');
  } else {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Internal server error');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

// Permissive CORS headers — allows the pages to call the API from any origin.
// Tighten this in production if the API is exposed beyond your local network.
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// ── WebSocket signaling relay ─────────────────────────────────────────────────
//
// The signaling server is a pure relay — it does not interpret WebRTC messages,
// it only routes them between the host and viewer peers.
//
// Message types:
//   register      { role: 'host' | 'viewer' }    — first message after connecting
//   offer         host → viewers                  — WebRTC SDP offer
//   answer        viewer → host                   — WebRTC SDP answer
//   ice-candidate either direction                — ICE candidate exchange
//   viewer-count  server → host                   — current viewer count
//   host-joined   server → viewers                — notifies viewers when host connects
//   host-left     server → viewers                — notifies viewers when host disconnects
//   info          server → peer                   — initial state on connect
//   error         server → host                   — registration rejected

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  let role = null; // assigned on 'register'

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── Registration ────────────────────────────────────────────────────────
    if (msg.type === 'register') {
      role = msg.role;

      if (role === 'host') {
        // Reject a second host if one is already connected.
        if (hostSocket && hostSocket.readyState === 1) {
          ws.send(JSON.stringify({ type: 'error', message: 'A host is already connected.' }));
          ws.close();
          return;
        }
        hostSocket = ws;
        console.log('[+] Host connected');

        // Tell the host how many viewers are already waiting.
        ws.send(JSON.stringify({ type: 'info', viewers: viewers.size }));

        // Notify any waiting viewers that the host is now online.
        broadcast(viewers, { type: 'host-joined' });
        return;
      }

      if (role === 'viewer') {
        viewers.add(ws);
        console.log(`[+] Viewer connected (total: ${viewers.size})`);

        // Tell the viewer whether a host is already streaming.
        ws.send(JSON.stringify({ type: 'info', hostPresent: hostSocket !== null && hostSocket.readyState === 1 }));

        // Update the host's viewer count display.
        if (hostSocket && hostSocket.readyState === 1) {
          hostSocket.send(JSON.stringify({ type: 'viewer-count', count: viewers.size }));
        }
        return;
      }
    }

    // ── Host → viewers relay ─────────────────────────────────────────────────
    // SDP offers and ICE candidates go from the host to all connected viewers.
    // If a targetId is specified, route to that viewer only.
    if (ws === hostSocket) {
      if (msg.type === 'offer' || msg.type === 'ice-candidate') {
        if (msg.targetId) {
          const target = [...viewers].find(v => v._id === msg.targetId);
          if (target && target.readyState === 1) target.send(raw.toString());
        } else {
          broadcast(viewers, null, raw.toString());
        }
      }
      return;
    }

    // ── Viewer → host relay ──────────────────────────────────────────────────
    // SDP answers and ICE candidates go from a viewer back to the host.
    if (viewers.has(ws)) {
      if (msg.type === 'answer' || msg.type === 'ice-candidate') {
        if (hostSocket && hostSocket.readyState === 1) {
          hostSocket.send(raw.toString());
        }
      }
      return;
    }
  });

  ws.on('close', () => {
    if (ws === hostSocket) {
      hostSocket = null;
      console.log('[-] Host disconnected');
      broadcast(viewers, { type: 'host-left' });
    } else if (viewers.has(ws)) {
      viewers.delete(ws);
      console.log(`[-] Viewer disconnected (remaining: ${viewers.size})`);
      if (hostSocket && hostSocket.readyState === 1) {
        hostSocket.send(JSON.stringify({ type: 'viewer-count', count: viewers.size }));
      }
    }
  });

  ws.on('error', (e) => console.error('[ws error]', e.message));
});

// Sends a message to every socket in a Set.
// Pass either a plain object (will be JSON-stringified) or a raw string.
function broadcast(targets, obj, raw) {
  const payload = raw || JSON.stringify(obj);
  for (const t of targets) {
    if (t.readyState === 1) t.send(payload);
  }
}

// ── Headless monitor lifecycle ────────────────────────────────────────────────
//
// Strategy (in priority order):
//   1. If HEADLESS-1 is already active, adopt it and leave it alone on exit.
//   2. If HEADLESS-1 exists but is disabled (left over from last shutdown),
//      re-enable it with a monitor keyword command.
//   3. If no headless output exists at all, create one with `hyprctl output`.
//
// Cases 2 and 3 poll every second for up to 3 seconds while Hyprland
// processes the change asynchronously.

function ensureHeadlessMonitor() {
  const existing = getHeadlessMonitor();

  // Case 1: already running — nothing to do.
  if (existing && !existing.disabled) {
    activeHeadless    = existing;
    weCreatedHeadless = false;
    console.log(`  Headless monitor: ✔ ${existing.name} (already active)`);
    return;
  }

  // Case 2: monitor exists but was disabled on last shutdown — wake it up.
  if (existing && existing.disabled) {
    console.log(`  Waking up disabled monitor: ${existing.name}…`);
    exec(`hyprctl keyword monitor ${existing.name},1920x1080@60,auto,1`, (err) => {
      if (err) console.warn(`  [warn] Failed to wake up ${existing.name}:`, err.message);
    });
  }

  // Case 3: no headless output exists — request Hyprland to create one.
  if (!existing) {
    console.log('  No headless monitor found — creating one…');
    exec('hyprctl output create headless', (err) => {
      if (err) console.warn('  [warn] Failed to create headless monitor:', err.message);
    });
  }

  // Poll until the monitor appears in the active list (max 3 seconds).
  let checks = 0;
  const poll = setInterval(() => {
    checks++;
    const mon = getHeadlessMonitor();
    if (mon && !mon.disabled) {
      clearInterval(poll);
      activeHeadless    = mon;
      weCreatedHeadless = true;
      console.log(`  Headless monitor: ✔ ${mon.name} (active — will disable on exit)`);
    } else if (checks >= 3) {
      clearInterval(poll);
      console.warn('  [warn] Headless monitor still not active after 3 s.');
      console.warn('         Is Hyprland running?');
    }
  }, 1000);
}

// ── Firewall lifecycle ────────────────────────────────────────────────────────

function detectFirewall() {
  try {
    if (execSync('systemctl is-active firewalld 2>/dev/null || true').toString().trim() === 'active') {
      return 'firewalld';
    }
  } catch {}

  try {
    if (execSync('command -v ufw 2>/dev/null && sudo ufw status 2>/dev/null || true').toString().includes('Status: active')) {
      return 'ufw';
    }
  } catch {}

  return null;
}

function manageFirewall(open) {
  if (!activeFirewall) return;

  const actionStr = open ? 'Opening' : 'Closing';
  console.log(`  [sudo] ${actionStr} firewall ports for WebRTC (${activeFirewall})…`);

  try {
    // Only prompt for sudo if we are trying to open (at startup).
    // On shutdown, sudo privileges usually persist via timeout, but if they
    // expired, the teardown will gracefully fail and print a warning.
    if (open) {
      execSync('sudo -v', { stdio: 'inherit' });
    }

    if (activeFirewall === 'firewalld') {
      const mode = open ? '--add-port' : '--remove-port';
      execSync(`sudo firewall-cmd ${mode}=${PORT}/tcp`, { stdio: 'ignore' });
      execSync(`sudo firewall-cmd ${mode}=49152-65535/udp`, { stdio: 'ignore' });
    } else if (activeFirewall === 'ufw') {
      const mode = open ? 'allow' : 'delete allow';
      execSync(`sudo ufw ${mode} ${PORT}/tcp`, { stdio: 'ignore' });
      execSync(`sudo ufw ${mode} 49152:65535/udp`, { stdio: 'ignore' });
    }

    portsOpened = open;
    if (open) console.log(`  Ports: ✔ ${PORT}/tcp (Web), 49152-65535/udp (WebRTC)`);
  } catch (e) {
    if (open) {
      console.warn('  [warn] Failed to open firewall ports. LAN streaming may fail.');
    } else {
      console.warn('  [warn] Failed to close firewall ports. You may need to remove them manually.');
    }
  }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
//
// On SIGINT/SIGTERM the server disables the headless monitor rather than
// removing it. Disabling preserves the internal output ID so the HEADLESS-*
// counter does not increment each time the server restarts.
// It also closes any firewall ports that were opened during startup.

function shutdown(signal) {
  console.log(`\n  [${signal}] Shutting down…`);

  if (portsOpened) {
    manageFirewall(false);
  }

  if (weCreatedHeadless && activeHeadless) {
    try {
      execSync(`hyprctl keyword monitor ${activeHeadless.name},disable`, { timeout: 2000 });
      console.log(`  Disabled headless monitor: ${activeHeadless.name}`);
    } catch (e) {
      console.warn(`  [warn] Could not disable ${activeHeadless.name}:`, e.message);
    }
  }
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── Start ─────────────────────────────────────────────────────────────────────

// 1. Check for firewall before booting HTTP
activeFirewall = detectFirewall();

if (activeFirewall) {
  console.log(`\n  [i] Firewall detected: ${activeFirewall}`);
  console.log('      virtual-waynitor needs to temporarily open ports for WebRTC streaming.');
  manageFirewall(true);
}

httpServer.listen(PORT, () => {
  console.log('\n  ╔══════════════════════════════════════════╗');
  console.log('  ║       virtual-waynitor server            ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log(`\n  Host page  →  http://localhost:${PORT}/`);
  console.log(`  Viewer     →  http://localhost:${PORT}/client`);
  console.log(`  API status →  http://localhost:${PORT}/api/status\n`);

  ensureHeadlessMonitor();
  console.log('');
});
