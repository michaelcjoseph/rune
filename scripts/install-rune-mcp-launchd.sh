#!/usr/bin/env bash
set -euo pipefail

LABEL="com.jarvis.rune-mcp"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_PLIST="${REPO_DIR}/launchd/com.jarvis.rune-mcp.plist"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
INSTALLED_PLIST="${LAUNCH_AGENTS_DIR}/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs/rune"
USER_ID="$(id -u)"

usage() {
  printf 'Usage: %s [install|restart|uninstall|lint]\n' "$(basename "$0")"
}

check_env_expectations() {
  local env_file="${REPO_DIR}/.env.local"

  printf 'MCP daemon env is loaded by npm run mcp:start via .env.local when present.\n'
  printf 'Expected keys: RUNE_MCP_SECRET, RUNE_MCP_ISSUER_URL, RUNE_MCP_OAUTH_STORE_FILE, RUNE_MCP_HOST, RUNE_MCP_PORT.\n'

  if [[ ! -f "${env_file}" ]]; then
    printf 'Note: %s does not exist; defaults apply where supported, but OAuth requires RUNE_MCP_SECRET for live use.\n' "${env_file}" >&2
    return
  fi

  local key
  for key in RUNE_MCP_SECRET RUNE_MCP_ISSUER_URL RUNE_MCP_OAUTH_STORE_FILE RUNE_MCP_HOST RUNE_MCP_PORT; do
    if ! grep -Eq "^${key}=" "${env_file}"; then
      printf 'Note: %s is not declared in .env.local; confirm this is intentional before live bootstrap.\n' "${key}" >&2
    fi
  done
}

lint_plist() {
  plutil -lint "${SOURCE_PLIST}"
}

install_service() {
  lint_plist
  check_env_expectations
  mkdir -p "${LAUNCH_AGENTS_DIR}" "${LOG_DIR}"
  cp "${SOURCE_PLIST}" "${INSTALLED_PLIST}"
  plutil -lint "${INSTALLED_PLIST}"

  launchctl bootout gui/${USER_ID}/com.jarvis.rune-mcp 2>/dev/null || true
  launchctl bootstrap gui/${USER_ID} "${INSTALLED_PLIST}"
  launchctl kickstart -k gui/${USER_ID}/com.jarvis.rune-mcp
}

restart_service() {
  launchctl kickstart -k gui/${USER_ID}/com.jarvis.rune-mcp
}

uninstall_service() {
  launchctl bootout gui/${USER_ID}/com.jarvis.rune-mcp 2>/dev/null || true
  rm -f "${INSTALLED_PLIST}"
}

case "${1:-install}" in
  install)
    install_service
    ;;
  restart)
    restart_service
    ;;
  uninstall|bootout)
    uninstall_service
    ;;
  lint)
    lint_plist
    check_env_expectations
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
