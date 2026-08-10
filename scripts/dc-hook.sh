#!/usr/bin/env bash
# Don Cheli — universal hook adapter
#
# Reads a hook JSON payload from stdin and forwards it to Don Cheli Studio.
# Compatible with Claude Code, Codex CLI, OpenCode and any tool that pipes
# JSON via stdin into a hook command.
#
# Usage (from a hook config):
#     /path/to/dc-hook.sh <event-name> [provider]
#
# Examples:
#     /path/to/dc-hook.sh PreToolUse claude
#     /path/to/dc-hook.sh PostToolUse codex
#     /path/to/dc-hook.sh UserPromptSubmit opencode
#
# Environment variables:
#     DC_STUDIO_URL   — Base URL of the running Studio (default http://localhost:3847)
#     DC_PROJECT_ID   — Optional project id to scope events
#     DC_SESSION_ID   — Optional session identifier
#
# Behavior:
#     - Always exits 0 so we never block the host tool, even if Studio is offline.
#     - Silent unless DC_HOOK_DEBUG=1 (writes diagnostics to stderr).
#     - Uses curl with a 2s timeout. If curl is missing, exits 0 silently.

set -u

EVENT="${1:-UnknownEvent}"
PROVIDER="${2:-claude}"
STUDIO_URL="${DC_STUDIO_URL:-http://localhost:3847}"
PROJECT_ID="${DC_PROJECT_ID:-}"
SESSION_ID="${DC_SESSION_ID:-}"

# Read stdin (hook payload). Keep raw — could be empty for some events.
PAYLOAD="$(cat)"
if [ -z "$PAYLOAD" ]; then
  PAYLOAD="{}"
fi

# Bail out cleanly if curl is unavailable
if ! command -v curl >/dev/null 2>&1; then
  exit 0
fi

# Build wrapped JSON. We embed the original payload as-is using a here-doc-ish
# approach: write the payload to a temp file and reference it via curl -d @file
# to avoid escaping issues with arbitrary JSON content.
TMP_FILE="$(mktemp -t dc-hook.XXXXXX 2>/dev/null || mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

# Validate that PAYLOAD is JSON-ish; if not, wrap as a string
if [ "${PAYLOAD#\{}" = "$PAYLOAD" ] && [ "${PAYLOAD#\[}" = "$PAYLOAD" ]; then
  # Not starting with { or [ — treat as plain text
  printf '{"provider":"%s","event":"%s","project_id":"%s","session_id":"%s","payload":{"raw":%s}}' \
    "$PROVIDER" "$EVENT" "$PROJECT_ID" "$SESSION_ID" \
    "$(printf '%s' "$PAYLOAD" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "$PAYLOAD")" \
    > "$TMP_FILE"
else
  # Build wrapped JSON envelope using python (always available on macOS) or fallback to manual
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$PROVIDER" "$EVENT" "$PROJECT_ID" "$SESSION_ID" "$PAYLOAD" > "$TMP_FILE" <<'PY'
import json, sys
provider, event, project_id, session_id, raw = sys.argv[1:6]
try:
    payload = json.loads(raw)
except Exception:
    payload = {"raw": raw}
envelope = {
    "provider": provider,
    "event": event,
    "project_id": project_id or None,
    "session_id": session_id or None,
    "payload": payload,
}
json.dump(envelope, sys.stdout)
PY
  else
    # Fallback: hope payload is well-formed JSON
    printf '{"provider":"%s","event":"%s","project_id":"%s","session_id":"%s","payload":%s}' \
      "$PROVIDER" "$EVENT" "$PROJECT_ID" "$SESSION_ID" "$PAYLOAD" \
      > "$TMP_FILE"
  fi
fi

# POST to Studio (fail silently, never block the host tool)
if [ "${DC_HOOK_DEBUG:-0}" = "1" ]; then
  echo "[dc-hook] POST $STUDIO_URL/api/hooks/event ($PROVIDER/$EVENT)" >&2
  curl -sS --max-time 2 -X POST \
    -H "Content-Type: application/json" \
    --data-binary "@$TMP_FILE" \
    "$STUDIO_URL/api/hooks/event" >&2 || true
else
  curl -s --max-time 2 -X POST \
    -H "Content-Type: application/json" \
    --data-binary "@$TMP_FILE" \
    "$STUDIO_URL/api/hooks/event" >/dev/null 2>&1 || true
fi

exit 0
