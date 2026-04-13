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

STATUS=$(curl -sS -m 45 -o /tmp/qwen_models.json -w "%{http_code}" "$BASE/models" \
  -H "Authorization: Bearer $ACCESS" \
  -H "Accept: application/json")
echo "status=$STATUS"
head -c 2000 /tmp/qwen_models.json | cat
