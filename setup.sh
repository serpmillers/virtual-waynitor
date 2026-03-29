#!/bin/bash
# =============================================================================
#  virtual-waynitor — setup.sh
#  Sets up a headless Hyprland virtual monitor + WebRTC streaming stack.
#  Run as a regular user (sudo will be called where needed).
# =============================================================================

set -euo pipefail

# ── colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()   { echo -e "${GREEN}✔${RESET}  $*"; }
warn() { echo -e "${YELLOW}⚠${RESET}  $*"; }
err()  { echo -e "${RED}✘${RESET}  $*"; }
info() { echo -e "${CYAN}→${RESET}  $*"; }
hdr()  { echo -e "\n${BOLD}${CYAN}━━━  $*  ━━━${RESET}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# =============================================================================
#  PHASE 0 — Banner
# =============================================================================
echo -e "${BOLD}${CYAN}"
cat << 'EOF'
 ██╗   ██╗██╗██████╗ ████████╗██╗   ██╗ █████╗ ██╗
 ██║   ██║██║██╔══██╗╚══██╔══╝██║   ██║██╔══██╗██║
 ██║   ██║██║██████╔╝   ██║   ██║   ██║███████║██║
 ╚██╗ ██╔╝██║██╔══██╗   ██║   ██║   ██║██╔══██║██║
  ╚████╔╝ ██║██║  ██║   ██║   ╚██████╔╝██║  ██║███████╗
   ╚═══╝  ╚═╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚══════╝
  W A Y N I T O R   —   headless virtual monitor setup
EOF
echo -e "${RESET}"

# =============================================================================
#  PHASE 1 — Preflight checks
# =============================================================================
hdr "Phase 1 — Preflight checks"

ERRORS=0

check_cmd() {
  local cmd="$1" hint="$2"
  if command -v "$cmd" &>/dev/null; then
    ok "$cmd found ($(command -v "$cmd"))"
  else
    err "$cmd not found — $hint"
    ERRORS=$(( ERRORS + 1 ))
  fi
}

# Compositor
if [[ "${WAYLAND_DISPLAY:-}" == "" ]]; then
  warn "WAYLAND_DISPLAY is not set. Are you running inside a Hyprland session?"
else
  ok "Wayland session detected (WAYLAND_DISPLAY=$WAYLAND_DISPLAY)"
fi

check_cmd hyprctl   "install Hyprland"
check_cmd pipewire  "sudo pacman -S pipewire"
check_cmd wireplumber "sudo pacman -S wireplumber"
check_cmd wf-recorder "sudo pacman -S wf-recorder"
check_cmd node      "sudo pacman -S nodejs"
check_cmd npm       "sudo pacman -S npm"

# xdg-desktop-portal-hyprland
if systemctl --user is-active --quiet xdg-desktop-portal-hyprland 2>/dev/null; then
  ok "xdg-desktop-portal-hyprland is running"
elif command -v xdg-desktop-portal-hyprland &>/dev/null; then
  warn "xdg-desktop-portal-hyprland is installed but not running — consider: systemctl --user enable --now xdg-desktop-portal-hyprland"
else
  err "xdg-desktop-portal-hyprland not found — sudo pacman -S xdg-desktop-portal-hyprland"
  ERRORS=$(( ERRORS + 1 ))
fi

# PipeWire running?
if systemctl --user is-active --quiet pipewire 2>/dev/null; then
  ok "PipeWire is running"
else
  warn "PipeWire user service does not appear active — stream capture may not work"
fi

if [[ $ERRORS -gt 0 ]]; then
  echo ""
  err "$ERRORS required dependency/dependencies missing. Fix them and re-run setup."
  echo -e "  ${YELLOW}Tip: sudo pacman -S pipewire wireplumber wf-recorder xdg-desktop-portal-hyprland nodejs npm${RESET}"
  exit 1
fi

echo ""
ok "All preflight checks passed."

# =============================================================================
#  PHASE 2 — /etc/environment (Option C — system-wide, persistent)
# =============================================================================
hdr "Phase 2 — /etc/environment (Option C)"

ETC_ENV="/etc/environment"
declare -A WANTED_VARS=(
  [WLR_BACKENDS]="drm,headless"
  [WLR_RENDERER]="vulkan"
  [WLR_NO_HARDWARE_CURSORS]="1"
)

NEED_WRITE=0
for key in "${!WANTED_VARS[@]}"; do
  val="${WANTED_VARS[$key]}"
  if grep -qE "^${key}=" "$ETC_ENV" 2>/dev/null; then
    current=$(grep -E "^${key}=" "$ETC_ENV" | cut -d= -f2- | tr -d '"')
    if [[ "$current" == "$val" ]]; then
      ok "$key=$val already set"
    else
      warn "$key is set to '$current', expected '$val' — will update"
      NEED_WRITE=1
    fi
  else
    info "$key=$val — will add"
    NEED_WRITE=1
  fi
done

if [[ $NEED_WRITE -eq 1 ]]; then
  echo ""
  echo -e "  ${BOLD}The following lines will be written/updated in ${ETC_ENV}:${RESET}"
  for key in "${!WANTED_VARS[@]}"; do
    echo -e "    ${CYAN}${key}=${WANTED_VARS[$key]}${RESET}"
  done
  echo ""
  read -rp "  Proceed? This requires sudo. [Y/n]: " CONFIRM
  CONFIRM="${CONFIRM:-Y}"
  if [[ "${CONFIRM,,}" != "y" ]]; then
    warn "Skipping /etc/environment update. You may need to set these manually."
  else
    # Write a temporary file with the merged contents
    TMP_ENV=$(mktemp)
    # Copy existing, removing lines we're replacing
    if [[ -f "$ETC_ENV" ]]; then
      grep -vE "^(WLR_BACKENDS|WLR_RENDERER|WLR_NO_HARDWARE_CURSORS)=" "$ETC_ENV" > "$TMP_ENV" || true
    fi
    # Append new values
    {
      echo ""
      echo "# virtual-waynitor — headless monitor environment"
      echo "WLR_BACKENDS=drm,headless"
      echo "WLR_RENDERER=vulkan"
      echo "WLR_NO_HARDWARE_CURSORS=1"
    } >> "$TMP_ENV"
    sudo cp "$TMP_ENV" "$ETC_ENV"
    rm -f "$TMP_ENV"
    ok "Written to $ETC_ENV"
    warn "These env vars take effect on your next Hyprland session (login or exec Hyprland)."
  fi
else
  ok "All environment variables are already correctly set."
fi

# =============================================================================
#  PHASE 3 — Hyprland monitor config (interactive)
# =============================================================================
hdr "Phase 3 — Hyprland monitor config"

HEADLESS_RESOLUTION="1920x1080@60"
HEADLESS_WORKSPACE="10"

info "We'll add the HEADLESS-1 virtual monitor to your Hyprland config."
echo ""

# Single default: hyprland.conf — user can freely edit or Tab-complete to another path
DEFAULT_CONF="$HOME/.config/hypr/hyprland.conf"

echo -e "  ${BOLD}Where is your Hyprland monitor config?${RESET}"
echo -e "  ${CYAN}Tab completion works — edit the path below or press Enter to accept the default${RESET}"
echo ""
read -e -i "$DEFAULT_CONF" -p "  → " MONITOR_CONF
MONITOR_CONF="${MONITOR_CONF/#\~/$HOME}"   # expand ~ if user typed it

if [[ -z "$MONITOR_CONF" ]]; then
  err "No config file specified."
  exit 1
fi

if [[ ! -f "$MONITOR_CONF" ]]; then
  err "File not found: $MONITOR_CONF"
  exit 1
fi

ok "Using config: $MONITOR_CONF"

# Check if HEADLESS-1 already exists ANYWHERE under ~/.config/hypr/
# This prevents duplicates if the script was run before with a different target file
HEADLESS_CONFIGURED=0
if grep -rlE "^monitor\s*=\s*HEADLESS-1" "$HOME/.config/hypr/" 2>/dev/null | grep -q .; then
  FOUND_IN=$(grep -rlE "^monitor\s*=\s*HEADLESS-1" "$HOME/.config/hypr/" 2>/dev/null | head -1)
  ok "HEADLESS-1 already configured (found in: $FOUND_IN) — skipping write"
  HEADLESS_CONFIGURED=1
fi

if [[ $HEADLESS_CONFIGURED -eq 0 ]]; then
  echo ""
  echo -e "  ${BOLD}The following lines will be appended to ${MONITOR_CONF}:${RESET}"
  echo -e "${CYAN}"
  cat << PREVIEW
    # virtual-waynitor — virtual headless monitor
    monitor = HEADLESS-1, ${HEADLESS_RESOLUTION}, auto, 1
    workspace = ${HEADLESS_WORKSPACE}, monitor:HEADLESS-1, default:true
PREVIEW
  echo -e "${RESET}"
  read -rp "  Append these lines? [Y/n]: " CONFIRM2
  CONFIRM2="${CONFIRM2:-Y}"
  if [[ "${CONFIRM2,,}" == "y" ]]; then
    cat >> "$MONITOR_CONF" << BLOCK

# virtual-waynitor — virtual headless monitor
monitor = HEADLESS-1, ${HEADLESS_RESOLUTION}, auto, 1
workspace = ${HEADLESS_WORKSPACE}, monitor:HEADLESS-1, default:true
BLOCK
    ok "Appended HEADLESS-1 config to $MONITOR_CONF"
  else
    warn "Skipping monitor config update."
  fi
fi

# =============================================================================
#  PHASE 4 — Verify headless output (live check)
# =============================================================================
hdr "Phase 4 — Verifying headless monitor"

if command -v hyprctl &>/dev/null && [[ -n "${WAYLAND_DISPLAY:-}" ]]; then
  info "Running: hyprctl monitors"
  echo ""
  hyprctl monitors 2>/dev/null | grep -E --color=always "HEADLESS|^Monitor" || true
  echo ""
  if hyprctl monitors 2>/dev/null | grep -q "HEADLESS-1"; then
    ok "HEADLESS-1 is LIVE ✓"
  else
    warn "HEADLESS-1 not detected yet."
    echo -e "  ${YELLOW}→ This is expected if you just updated /etc/environment or hyprland.conf."
    echo -e "  → Restart Hyprland (or run: hyprctl reload) then re-run this script to verify.${RESET}"
  fi
else
  warn "Cannot run hyprctl (not in a Hyprland session or hyprctl missing). Skipping live check."
fi

# =============================================================================
#  PHASE 5 — Install Node.js dependencies
# =============================================================================
hdr "Phase 5 — Node.js dependencies"

cd "$SCRIPT_DIR"

if [[ ! -f "package.json" ]]; then
  err "package.json not found in $SCRIPT_DIR. Is this the right directory?"
  exit 1
fi

info "Running npm install..."
npm install
ok "npm dependencies installed."

# =============================================================================
#  PHASE 6 — Done!
# =============================================================================
hdr "Setup complete"

LOCAL_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)
PORT=3000

echo ""
echo -e "${GREEN}${BOLD}  virtual-waynitor is ready to run!${RESET}"
echo ""
echo -e "  ${BOLD}Start the server:${RESET}"
echo -e "    ${CYAN}npm start${RESET}   (from ${SCRIPT_DIR})"
echo ""
echo -e "  ${BOLD}Then open in your browser on this machine:${RESET}"
echo -e "    ${CYAN}http://localhost:${PORT}/${RESET}          ← Host (capture & stream)"
echo ""
echo -e "  ${BOLD}On any other device on the same network:${RESET}"
if [[ -n "${LOCAL_IP:-}" ]]; then
  echo -e "    ${CYAN}http://${LOCAL_IP}:${PORT}/client${RESET}    ← Viewer"
else
  echo -e "    ${CYAN}http://<your-ip>:${PORT}/client${RESET}     ← Viewer"
fi
echo ""
echo -e "  ${BOLD}Management API:${RESET}"
echo -e "    ${CYAN}http://localhost:${PORT}/api/status${RESET}   ← JSON status"
echo -e "    ${CYAN}http://localhost:${PORT}/api/monitors${RESET} ← Monitor list"
echo -e "    ${CYAN}http://localhost:${PORT}/api/windows${RESET}  ← Windows on HEADLESS-1"
echo ""
if ! hyprctl monitors 2>/dev/null | grep -q "HEADLESS-1" &>/dev/null 2>&1; then
  echo -e "  ${YELLOW}⚠  Remember: restart Hyprland first if you just updated the configs!${RESET}"
  echo ""
fi
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
