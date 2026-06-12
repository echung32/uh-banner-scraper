#!/usr/bin/env bash
# Bulk historical backfill sweep — sections only, newest -> oldest.
# Stops on the first throttle signal (sync status != "ok", or a per-term timeout/hang).
# Progress is appended as JSONL to $PROGRESS so it can be transcribed live.
set -u

cd "$(dirname "$0")/.."          # web/
set -a; . ./.env; set +a
export D1_MODE=remote

PROGRESS=/tmp/backfill_progress.jsonl
CODES=/tmp/backfill_codes.txt
: > "$PROGRESS"

# Resolve the work list: every not-yet-backfilled term, newest first.
curl -s -X POST \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json" \
  --data '{"sql":"SELECT code FROM term WHERE last_synced_at IS NULL ORDER BY code DESC"}' \
  | python3 -c "import sys,json;[print(r['code']) for r in json.load(sys.stdin)['result'][0]['results']]" > "$CODES"

echo "sweep: $(wc -l < "$CODES") terms to process"

while read -r code; do
  [ -z "$code" ] && continue
  echo ">>> $code sync starting"
  out=$(timeout 1800 yarn ingest sync --term "$code" --delayMs 200 --subjectsPerSession 40 2>/tmp/sweep_err.log)
  rc=$?
  if [ $rc -ne 0 ]; then
    echo "{\"code\":\"$code\",\"status\":\"halt\",\"reason\":\"exit $rc (timeout/hang -> likely IP throttle)\"}" >> "$PROGRESS"
    echo "!!! $code halted (exit $rc) — stopping sweep"
    exit 2
  fi
  # Extract the trailing pretty-printed JSON (yarn ingest logs per-subject lines
  # before it). The top-level '{' is unindented; nested ones are indented.
  line=$(printf '%s' "$out" | python3 -c "
import sys,json
lines=sys.stdin.read().splitlines()
starts=[i for i,l in enumerate(lines) if l=='{']
d=json.loads('\n'.join(lines[starts[-1]:]))
r=d['results'][0]
print(json.dumps({'code':r['term'],'subjects':r['subjects'],'sections':r['sections'],'status':r['status']}))
" 2>/dev/null)
  if [ -z "$line" ]; then
    echo "{\"code\":\"$code\",\"status\":\"halt\",\"reason\":\"unparseable output\"}" >> "$PROGRESS"
    echo "!!! $code unparseable — stopping sweep"; exit 3
  fi
  echo "$line" >> "$PROGRESS"
  st=$(printf '%s' "$line" | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])")
  echo "    $line"
  if [ "$st" != "ok" ]; then
    echo "!!! $code status=$st (throttle) — stopping sweep"; exit 4
  fi
  sleep 3
done < "$CODES"

echo "=== sweep complete: all terms processed ==="
