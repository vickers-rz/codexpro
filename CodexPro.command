#!/bin/sh
set -eu

SCRIPT_ROOT="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_ROOT="/Users/vickers/Documents"
DEFAULT_EXTRA_ALLOW_ROOT="/Volumes/T7_APFS/MacBackup/Movies"
SESSION="${CODEXPRO_TMUX_SESSION:-codexpro-local}"
DEFAULT_HOSTNAME="${CODEXPRO_PUBLIC_HOSTNAME:-codexpro.runzhe.uk}"
DEFAULT_PORT="8787"
DEFAULT_BIND_HOST="${CODEXPRO_BIND_HOST:-${CODEXPRO_HOST:-0.0.0.0}}"
EXTERNAL_TUNNEL="${CODEXPRO_EXTERNAL_TUNNEL:-1}"

usage() {
  cat <<EOF
CodexPro control

Usage:
  ./CodexPro.command start       Start CodexPro and optional Cloudflare Tunnel
  ./CodexPro.command start-custom
                                    Start with prompted root/allow/bash/write/tool options
  ./CodexPro.command stop        Stop CodexPro and optional Cloudflare Tunnel
  ./CodexPro.command restart     Stop then start both
  ./CodexPro.command status      Show process and health status
  ./CodexPro.command check       Run public/local health checks
  ./CodexPro.command doctor      Run CodexPro preflight diagnostics
  ./CodexPro.command settings    Show saved CodexPro workspace settings
  ./CodexPro.command logs        Open project folder in Finder
  ./CodexPro.command tail        Tail the CodexPro tmux pane
  ./CodexPro.command attach      Attach to the CodexPro tmux session
  ./CodexPro.command url         Print ChatGPT App Server URL

Double-clicking this .command file opens an interactive menu.
EOF
}

ensure_ready() {
  cd "$SCRIPT_ROOT"
  if [ ! -d node_modules ]; then
    echo "Installing npm dependencies..."
    npm install
  fi
  if [ ! -f dist/http.js ]; then
    echo "Building CodexPro..."
    npm run build
  fi
}

shell_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

append_unique_colon_item() {
  list="$1"
  item="$2"
  [ -n "$item" ] || {
    echo "$list"
    return 0
  }
  case ":$list:" in
    *:"$item":*) echo "$list" ;;
    "::") echo "$item" ;;
    *) echo "${list}:$item" ;;
  esac
}

default_allow_roots() {
  echo "$DEFAULT_EXTRA_ALLOW_ROOT"
}

profile_json() {
  PROFILE_ROOT="$DEFAULT_ROOT" node --input-type=module <<'NODE'
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(process.env.PROFILE_ROOT);
const dir = path.join(os.homedir(), ".codexpro", "profiles");
if (!fs.existsSync(dir)) process.exit(0);
for (const name of fs.readdirSync(dir)) {
  if (!name.endsWith(".json")) continue;
  const file = path.join(dir, name);
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.root && fs.existsSync(data.root) && fs.realpathSync(data.root) === root) {
      process.stdout.write(JSON.stringify({ ...data, profilePath: file }));
      process.exit(0);
    }
  } catch {}
}
NODE
}

profile_value() {
  key="$1"
  json="$(profile_json)"
  [ -n "$json" ] || return 0
  PROFILE_JSON="$json" PROFILE_KEY="$key" node --input-type=module <<'NODE'
const data = JSON.parse(process.env.PROFILE_JSON);
const value = data[process.env.PROFILE_KEY];
if (value !== undefined && value !== null) process.stdout.write(String(value));
NODE
}

port() {
  value="$(profile_value port || true)"
  echo "${value:-$DEFAULT_PORT}"
}

hostname() {
  value="$(profile_value hostname || true)"
  echo "${value:-$DEFAULT_HOSTNAME}"
}

token() {
  profile_value token || true
}

tunnel_name() {
  value="$(profile_value tunnelName || true)"
  echo "${value:-codexpro-local}"
}

connector_url() {
  host="$(hostname)"
  tok="$(token)"
  if [ -n "$tok" ]; then
    echo "https://$host/mcp?codexpro_token=$tok"
  else
    echo "https://$host/mcp"
  fi
}

bind_host() {
  value="$(profile_value host || true)"
  echo "${value:-$DEFAULT_BIND_HOST}"
}

health_host() {
  value="${CODEXPRO_HEALTH_HOST:-}"
  if [ -n "$value" ]; then
    echo "$value"
    return 0
  fi
  current_host="$(bind_host)"
  case "$current_host" in
    0.0.0.0|::) echo "127.0.0.1" ;;
    *) echo "$current_host" ;;
  esac
}

external_tunnel_enabled() {
  case "${EXTERNAL_TUNNEL}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

codexpro_pid() {
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    pane_pid="$(tmux display-message -p -t "$SESSION" "#{pane_pid}" 2>/dev/null || true)"
    if [ -n "$pane_pid" ] && kill -0 "$pane_pid" 2>/dev/null; then
      echo "$pane_pid"
      return 0
    fi
  fi
  pgrep -f "[n]ode scripts/codexpro.mjs .*--hostname $(hostname)" | head -n 1 || true
}

cloudflared_pid() {
  current_tunnel="$(tunnel_name)"
  pgrep -f "[c]loudflared tunnel run .*${current_tunnel}" | head -n 1 || true
}

curl_health() {
  url="$1"
  tok="$(token)"
  if [ -n "$tok" ]; then
    curl -fsS --connect-timeout 10 -H "Authorization: Bearer $tok" "$url"
  else
    curl -fsS --connect-timeout 10 "$url"
  fi
}

local_ok() {
  curl_health "http://$(health_host):$(port)/healthz" >/dev/null 2>&1
}

public_ok() {
  curl_health "https://$(hostname)/healthz" >/dev/null 2>&1
}

curl_with_retries() {
  url="$1"
  attempts="${2:-3}"
  i=1
  while [ "$i" -le "$attempts" ]; do
    if curl_health "$url"; then
      return 0
    fi
    if [ "$i" -lt "$attempts" ]; then
      echo
      echo "Attempt $i failed; retrying..."
      sleep 2
    fi
    i=$((i + 1))
  done
  return 1
}

status() {
  cp_id="$(codexpro_pid)"
  cf_id="$(cloudflared_pid)"
  current_port="$(port)"
  current_host="$(hostname)"
  current_bind_host="$(bind_host)"
  current_health_host="$(health_host)"

  if [ -n "$cp_id" ]; then
    echo "CodexPro: running pid=$cp_id tmux=$SESSION"
  else
    echo "CodexPro: stopped"
  fi

  if local_ok; then
    echo "Local health: ok (http://$current_health_host:$current_port/healthz)"
  else
    echo "Local health: unavailable (http://$current_health_host:$current_port/healthz)"
  fi

  if external_tunnel_enabled; then
    echo "Cloudflare Tunnel: external"
  elif [ -n "$cf_id" ]; then
    echo "Cloudflare Tunnel: running pid=$cf_id"
  else
    echo "Cloudflare Tunnel: stopped"
  fi

  if public_ok; then
    echo "Public health: ok (https://$current_host/healthz)"
  else
    echo "Public health: unavailable (https://$current_host/healthz)"
  fi

  echo "Connector URL: $(connector_url)"
  echo "Bind host: $current_bind_host"
}

start_all() {
  ensure_ready
  start_with_args "$DEFAULT_ROOT" "" "no" "full" "workspace" "full"
}

start_with_args() {
  start_root="$1"
  start_allow_roots="$2"
  start_allow_home="$3"
  start_bash="$4"
  start_write="$5"
  start_tool_mode="$6"
  merged_allow_roots="$(append_unique_colon_item "$start_allow_roots" "$(default_allow_roots)")"

  if local_ok && public_ok && tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "CodexPro already healthy."
    echo
    status
    return 0
  fi

  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "CodexPro tmux session exists but health is not ready."
    echo "Use: ./CodexPro.command tail"
    return 1
  fi

  echo "Starting CodexPro in tmux session: $SESSION"
  cmd="export TUNNEL_TRANSPORT_PROTOCOL=http2; exec node scripts/codexpro.mjs stable"
  cmd="$cmd --root $(shell_quote "$start_root")"
  cmd="$cmd --host $(shell_quote "$(bind_host)")"
  cmd="$cmd --port $(shell_quote "$(port)")"
  cmd="$cmd --hostname $(shell_quote "$(hostname)")"
  if external_tunnel_enabled; then
    cmd="$cmd --tunnel none"
  else
    cmd="$cmd --tunnel-name $(shell_quote "$(tunnel_name)")"
  fi
  cmd="$cmd --bash $(shell_quote "$start_bash")"
  cmd="$cmd --write $(shell_quote "$start_write")"
  cmd="$cmd --tool-mode $(shell_quote "$start_tool_mode")"

  old_ifs="$IFS"
  IFS=':'
  for allow_root in $merged_allow_roots; do
    if [ -n "$allow_root" ]; then
      cmd="$cmd --allow-root $(shell_quote "$allow_root")"
    fi
  done
  IFS="$old_ifs"

  case "$start_allow_home" in
    y|Y|yes|YES|true|TRUE|1) cmd="$cmd --allow-home" ;;
  esac

  tmux new-session -d -s "$SESSION" -c "$SCRIPT_ROOT" "$cmd"

  i=0
  while [ "$i" -lt 75 ]; do
    if external_tunnel_enabled; then
      if local_ok; then
        break
      fi
    elif public_ok; then
      break
    fi
    if ! tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "CodexPro exited before public health became ready."
      echo "Recent output:"
      tail_logs
      return 1
    fi
    sleep 1
    i=$((i + 1))
  done

  echo
  status

  if external_tunnel_enabled; then
    if ! local_ok; then
      echo
      echo "Local health did not become ready within 75 seconds."
      echo "Use './CodexPro.command tail' for the launcher output."
      return 1
    fi
    if ! public_ok; then
      echo
      echo "External tunnel mode is enabled. Local service is ready, but public health is not yet reachable."
      echo "Check your router/Lucky route for https://$(hostname)/healthz -> http://$(bind_host):$(port)/healthz"
    fi
    return 0
  fi

  if ! public_ok; then
    echo
    echo "Public health did not become ready within 75 seconds."
    echo "Use './CodexPro.command tail' for the launcher output."
    return 1
  fi
}

choose_value() {
  prompt="$1"
  default="$2"
  allowed="$3"
  while true; do
    printf "%s [%s]: " "$prompt" "$default"
    read value
    value="${value:-$default}"
    case " $allowed " in
      *" $value "*) echo "$value"; return 0 ;;
      *) echo "Invalid value. Choose one of: $allowed" ;;
    esac
  done
}

start_custom() {
  ensure_ready
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "CodexPro is already running."
    printf "Stop current instance and start with custom options? [no]: "
    read stop_first
    case "${stop_first:-no}" in
      y|Y|yes|YES)
        stop_all
        ;;
      *)
        echo "Canceled. Current instance is still running."
        return 1
        ;;
    esac
  fi

  echo "Custom CodexPro start"
  echo
  echo "Root is the default workspace ChatGPT opens."
  printf "Root [%s]: " "$DEFAULT_ROOT"
  read custom_root
  custom_root="${custom_root:-$DEFAULT_ROOT}"

  echo
  echo "Optional additional allowed roots. Separate multiple paths with ':'"
  echo "Example: /Users/vickers/Documents/MCP_Creator:/Users/vickers/Documents/OtherRepo"
  printf "Allow roots [%s]: " "$(default_allow_roots)"
  read custom_allow_roots
  custom_allow_roots="${custom_allow_roots:-$(default_allow_roots)}"

  printf "Allow opening any workspace under HOME? This is broad. [no]: "
  read custom_allow_home
  custom_allow_home="${custom_allow_home:-no}"

  echo
  custom_bash="$(choose_value "Bash mode" "safe" "off safe full")"
  custom_write="$(choose_value "Write mode" "workspace" "off handoff workspace")"
  custom_tool_mode="$(choose_value "Tool mode" "full" "minimal standard full")"

  echo
  echo "Starting with:"
  echo "  root:       $custom_root"
  echo "  allowRoot:  ${custom_allow_roots:-none}"
  echo "  allowHome:  $custom_allow_home"
  echo "  bash:       $custom_bash"
  echo "  write:      $custom_write"
  echo "  tool mode:  $custom_tool_mode"
  echo

  case "$custom_bash" in
    full)
      echo "Warning: full bash allows arbitrary shell commands from the connected ChatGPT app."
      printf "Type FULL to confirm: "
      read confirm
      [ "$confirm" = "FULL" ] || { echo "Canceled."; return 1; }
      ;;
  esac

  case "$custom_allow_home" in
    y|Y|yes|YES|true|TRUE|1)
      echo "Warning: --allow-home allows opening many local folders under your home directory."
      printf "Type HOME to confirm: "
      read confirm_home
      [ "$confirm_home" = "HOME" ] || { echo "Canceled."; return 1; }
      ;;
  esac

  start_with_args "$custom_root" "$custom_allow_roots" "$custom_allow_home" "$custom_bash" "$custom_write" "$custom_tool_mode"
}

stop_all() {
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Stopping CodexPro tmux session: $SESSION"
    tmux send-keys -t "$SESSION" q
    for _ in 1 2 3 4 5; do
      if ! tmux has-session -t "$SESSION" 2>/dev/null; then
        echo "CodexPro stopped"
        return 0
      fi
      sleep 1
    done
    echo "CodexPro did not exit cleanly; killing tmux session"
    tmux kill-session -t "$SESSION" 2>/dev/null || true
  else
    echo "CodexPro tmux session: not running"
  fi

  cf_id="$(cloudflared_pid)"
  if external_tunnel_enabled; then
    echo "Cloudflare Tunnel: managed externally"
  elif [ -n "$cf_id" ]; then
    echo "Stopping leftover Cloudflare Tunnel: pid=$cf_id"
    kill "$cf_id" 2>/dev/null || true
  fi
}

restart_all() {
  stop_all
  start_all
}

check_all() {
  current_port="$(port)"
  current_host="$(hostname)"
  current_health_host="$(health_host)"
  echo "Checking local health..."
  curl_with_retries "http://$current_health_host:$current_port/healthz" 3
  echo
  echo "Checking public health..."
  curl_with_retries "https://$current_host/healthz" 3
  echo
  echo "Checking MCP initialize..."
  tok="$(token)"
  i=1
  while [ "$i" -le 3 ]; do
    if curl -fsS --connect-timeout 15 \
      --http1.1 \
      --max-time 25 \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      ${tok:+-H "Authorization: Bearer $tok"} \
      "https://$current_host/mcp" \
      --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"codexpro-command","version":"1"}}}'; then
      break
    fi
    if [ "$i" -lt 3 ]; then
      echo
      echo "MCP initialize attempt $i failed; retrying..."
      sleep 2
    else
      return 1
    fi
    i=$((i + 1))
  done
  echo
}

doctor() {
  ensure_ready
  if local_ok; then
    echo "CodexPro is already running on port $(port)."
    echo "The upstream doctor may report the local port as in use; that is expected while the service is running."
    echo
  fi
  node "$SCRIPT_ROOT/scripts/codexpro.mjs" doctor --root "$DEFAULT_ROOT" --port "$(port)"
}

settings() {
  node "$SCRIPT_ROOT/scripts/codexpro.mjs" settings show --root "$DEFAULT_ROOT"
}

open_logs() {
  open "$SCRIPT_ROOT"
}

tail_logs() {
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux capture-pane -t "$SESSION" -p -S -200
    echo
    echo "Attach for live controls: ./CodexPro.command attach"
  else
    echo "CodexPro tmux session is not running."
  fi
}

attach_session() {
  tmux attach -t "$SESSION"
}

interactive_menu() {
  while true; do
    clear 2>/dev/null || true
    status
    cat <<EOF

Choose an action:
  1) Start
  2) Start with custom root/options
  3) Stop
  4) Restart
  5) Check health
  6) Tail tmux pane
  7) Attach tmux session
  8) Open project folder
  9) Doctor
  10) Settings
  11) Print Connector URL
  q) Quit
EOF
    printf "> "
    read choice || exit 0
    set +e
    case "$choice" in
      1) start_all; action_status=$? ;;
      2) start_custom; action_status=$? ;;
      3) stop_all; action_status=$? ;;
      4) restart_all; action_status=$? ;;
      5) check_all; action_status=$? ;;
      6) tail_logs; action_status=$? ;;
      7) attach_session; action_status=$? ;;
      8) open_logs; action_status=$? ;;
      9) doctor; action_status=$? ;;
      10) settings; action_status=$? ;;
      11) connector_url; action_status=$? ;;
      q|Q) exit 0 ;;
      *) echo "Unknown choice: $choice"; action_status=2 ;;
    esac
    set -e
    if [ "$action_status" -ne 0 ]; then
      echo
      echo "Action exited with status $action_status."
    fi
    echo
    printf "Press Enter to continue..."
    read _ || exit 0
  done
}

cmd="${1:-menu}"
case "$cmd" in
  start) start_all ;;
  start-custom|custom-start) start_custom ;;
  stop) stop_all ;;
  restart) restart_all ;;
  status) status ;;
  check) check_all ;;
  doctor) doctor ;;
  settings) settings ;;
  logs) open_logs ;;
  tail) tail_logs ;;
  attach) attach_session ;;
  url) connector_url ;;
  menu) interactive_menu ;;
  -h|--help|help) usage ;;
  *)
    echo "Unknown command: $cmd"
    echo
    usage
    exit 2
    ;;
esac
