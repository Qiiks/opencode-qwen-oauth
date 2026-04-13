#!/usr/bin/env bash
set -euo pipefail
AUTH_PATH="$(cygpath -u "$USERPROFILE")/.local/share/opencode/auth.json"
ACCESS=$(node -e "const fs=require('fs');const p=process.argv[1];const a=JSON.parse(fs.readFileSync(p,'utf8'))['qwen-code'];process.stdout.write(a&&a.type==='oauth'&&a.access?a.access:'');" "$AUTH_PATH")
RESOURCE=$(node -e "const fs=require('fs');const p=process.argv[1];const a=JSON.parse(fs.readFileSync(p,'utf8'))['qwen-code'];process.stdout.write(a&&a.resourceUrl?a.resourceUrl:'');" "$AUTH_PATH")
if [[ -z "$ACCESS" ]]; then
  echo "missing-access"
  exit 1
fi
BASE="https://dashscope.aliyuncs.com/compatible-mode/v1"
if [[ -n "$RESOURCE" ]]; then
  if [[ "$RESOURCE" == http* ]]; then
    BASE="$RESOURCE"
  else
    BASE="https://$RESOURCE"
  fi
  if [[ "$BASE" != */v1 ]]; then
    BASE="$BASE/v1"
  fi
fi

models=(
  coder-model
  qwen3-coder-plus
  qwen3-coder-flash
  qwen-coder-plus
  qwen-plus
  qwen-max
  qwen3-235b-a22b
)

for m in "${models[@]}"; do
  status=$(curl -sS -m 40 -o /tmp/qwen_probe.json -w "%{http_code}" "$BASE/chat/completions" \
    -H "Authorization: Bearer $ACCESS" \
    -H "Content-Type: application/json" \
    --data "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":8,\"stream\":false}")
  snippet=$(head -c 120 /tmp/qwen_probe.json | tr '\n' ' ')
  echo "$m => $status :: $snippet"
done
