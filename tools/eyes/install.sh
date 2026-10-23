#!/bin/bash
# Installs companion/build/LumenEyes.tpk (built and signed by tools/eyes/build.ps1) on the TV with the WSL SDK sdb:
#   wsl bash /mnt/c/Users/pranj/source/lumen-remote/tools/eyes/install.sh
# Shares the sdb connection with the CineHD pipelines like tools/agent/install.sh (LUMEN_SDB_FORCE=1 skips the
# busy check; LUMEN_TV=<host>:26101 overrides the target).
set -u

B=/home/pv/cinehd-emulator-tests/linux55-20261008-offline-a
export LD_LIBRARY_PATH=$B/sdk/compatlib
SDB="$B/sdk/tools/sdb"
T=${LUMEN_TV:-192.168.1.2:26101}
APP=org.lumen.eyes
REPO=$(cd "$(dirname "$0")/../.." && pwd)
PKG="$REPO/companion/build/LumenEyes.tpk"
REMOTE=/home/owner/share/tmp/sdk_tools/tmp/LumenEyes.tpk

[ -x "$SDB" ] || { echo "sdb not found at $SDB"; exit 1; }
[ -f "$PKG" ] || { echo "missing $PKG: run tools/eyes/build.ps1 first"; exit 1; }

OTHERS=$(pgrep -af 'sdb -s' | grep -v pgrep)
if [ -n "$OTHERS" ] && [ "${LUMEN_SDB_FORCE:-0}" != "1" ]; then
  echo "$OTHERS"
  echo "another sdb client is active; wait for it to finish (or set LUMEN_SDB_FORCE=1)"
  exit 2
fi

timeout 20 "$SDB" devices | grep -q "^$T" || timeout 20 "$SDB" connect "$T"
timeout 120 "$SDB" -s "$T" push "$PKG" "$REMOTE" || { echo "push failed"; exit 1; }
OUT=$(timeout 120 "$SDB" -s "$T" shell 0 vd_appinstall "$APP" "$REMOTE" 2>&1)
echo "$OUT" | tail -3
echo "$OUT" | grep -qF "app_id[$APP] install completed" || { echo "install did not complete"; exit 1; }
