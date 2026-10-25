#!/bin/bash
# Runs the test files 3 at a time (a full run at once starves this PC), each batch capped at 300 s, and
# prints one line per batch plus its failures:
#   bash tools/test-batches.sh [first file index, 0-based] [batch size]
# It leaves nothing behind. Stopped (Ctrl-C, kill) or orphaned (whatever started it went away), it ends
# the running batch's whole process tree, node test runners and their headless Edge instances
# included: on 25 Oct a run whose starter was killed kept going on its own, beside the next one. After
# every batch it also closes any test Edge that batch left running (tools/kill-test-edge.ps1).
cd "$(dirname "$0")/.." || exit 1
start=${1:-0}
size=${2:-3}
parent=$PPID
child=
out=$(mktemp)

# The batch's headless Edge instances: their launcher exits at once, so no process tree reaches them.
close_test_edge() {
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/kill-test-edge.ps1 -Since "$1" 2>/dev/null | sed 's/^/  /'
}

stop_child() {
  [ -n "$child" ] || return 0
  local wp
  wp=$(cat "/proc/$child/winpid" 2>/dev/null)
  if [ -n "$wp" ]; then taskkill //PID "$wp" //T //F >/dev/null 2>&1; else kill "$child" 2>/dev/null; fi
  child=
  close_test_edge "$since"
}
finish() { stop_child; rm -f "$out"; exit "${1:-130}"; }
trap 'finish 130' TERM INT HUP

files=(test/*.test.js)
for ((i = start; i < ${#files[@]}; i += size)); do
  batch="${files[@]:i:size}"
  began=$(date +%s)
  since=$(date '+%Y-%m-%dT%H:%M:%S')
  timeout 300 node --test --test-concurrency="$size" $batch > "$out" 2>&1 &
  child=$!
  # Waits for the batch, and stops everything as soon as the starter is gone.
  while kill -0 "$child" 2>/dev/null; do
    if ! kill -0 "$parent" 2>/dev/null; then echo "the starter went away: stopping"; finish 1; fi
    sleep 2
  done
  wait "$child"
  rc=$?
  child=
  close_test_edge "$since" # a test that died or timed out left its browser behind
  echo "[$((i / size + 1))] rc=$rc $(( $(date +%s) - began ))s $(grep -E '^# (pass|fail)' "$out" | tr '\n' ' ') $batch"
  grep -E "^not ok|^    not ok" "$out" | head -5
done
rm -f "$out"
echo DONE
