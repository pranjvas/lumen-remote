#!/bin/bash
# Installs companion/build/LumenAgent.wgt (built and signed by tools/agent/build.ps1) on the TV with the WSL SDK sdb.
# The Windows sdb can hang on a stale relay, so this runs inside WSL:
#   wsl bash /mnt/c/Users/pranj/source/lumen-remote/tools/agent/install.sh
# The sdb connection is shared with the CineHD pipelines: the script stops if another sdb client is busy
# (set LUMEN_SDB_FORCE=1 to skip that check). Override the target with LUMEN_TV=<host>:26101.
set -u

B=/home/pv/cinehd-emulator-tests/linux55-20261008-offline-a
export LD_LIBRARY_PATH=$B/sdk/compatlib
SDB="$B/sdk/tools/sdb"
T=${LUMEN_TV:-192.168.1.2:26101}
APP=lumenrmt01.LumenAgent
REPO=$(cd "$(dirname "$0")/../.." && pwd)
WGT="$REPO/companion/build/LumenAgent.wgt"
REMOTE=/home/owner/share/tmp/sdk_tools/tmp/LumenAgent.wgt
VERSION=$(sed -n 's/.*<widget[^>]* version="\([^"]*\)".*/\1/p' "$REPO/companion/agent/config.xml")

[ -x "$SDB" ] || { echo "sdb not found at $SDB"; exit 1; }
[ -f "$WGT" ] || { echo "missing $WGT: run tools/agent/build.ps1 first"; exit 1; }

echo "== other sdb clients:"
OTHERS=$(pgrep -af 'sdb -s' | grep -v pgrep)
if [ -n "$OTHERS" ]; then
  echo "$OTHERS"
  if [ "${LUMEN_SDB_FORCE:-0}" != "1" ]; then
    echo "another sdb client is active; wait for it to finish (or set LUMEN_SDB_FORCE=1)"
    exit 2
  fi
else
  echo none
fi

if ! timeout 20 "$SDB" devices | grep -q "^$T"; then
  timeout 20 "$SDB" connect "$T"
fi
timeout 20 "$SDB" devices

echo "== push $(stat -c %s "$WGT") bytes"
timeout 120 "$SDB" -s "$T" push "$WGT" "$REMOTE" || { echo "push failed"; exit 1; }

echo "== install"
OUT=$(timeout 120 "$SDB" -s "$T" shell 0 vd_appinstall "$APP" "$REMOTE" 2>&1)
echo "$OUT"
if ! echo "$OUT" | grep -qF "app_id[$APP] install completed"; then
  echo "install did not complete"
  exit 1
fi

echo "== applist (expecting version $VERSION):"
LIST=$(timeout 20 "$SDB" -s "$T" shell 0 vd_applist 2>&1 | grep -iE -B2 -A6 'lumen' | head -30)
echo "$LIST"
echo "$LIST" | grep -qF "$VERSION" || { echo "installed version $VERSION not confirmed in vd_applist"; exit 1; }
