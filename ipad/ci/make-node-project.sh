#!/bin/sh
# Assembles the files Node runs inside the iPad app: server/, web/, package.json and only the
# packages the server loads there (ws, zod, the Anthropic SDK), with a stand-in for the agent SDK.
#
#   sh ipad/ci/make-node-project.sh <destination folder>
#
# Run from the repository root. Used by .github/workflows/ipad.yml; also handy for trying the same
# files on a desktop Node 18 (ipad/README.md).
set -eu

DEST="${1:?usage: sh ipad/ci/make-node-project.sh <destination folder>}"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R server web package.json package-lock.json "$DEST/"

# The agent SDK and everything only it needs stay out; the lock file keeps the other versions.
node -e '
const fs = require("fs");
const file = process.argv[1] + "/package.json";
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
delete pkg.dependencies["@anthropic-ai/claude-agent-sdk"];
delete pkg.scripts;
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' "$DEST"
(cd "$DEST" && npm install --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --loglevel=error)
rm -f "$DEST/package-lock.json"

mkdir -p "$DEST/node_modules/@anthropic-ai/claude-agent-sdk"
cp ipad/node-stubs/claude-agent-sdk/package.json ipad/node-stubs/claude-agent-sdk/index.mjs "$DEST/node_modules/@anthropic-ai/claude-agent-sdk/"

# Not needed at run time; links would also stop the app from being signed.
find "$DEST/node_modules" -name .bin -type d -prune -exec rm -rf {} +
find "$DEST/node_modules" -type f \( -name "*.map" -o -name "*.d.ts" -o -name "*.d.mts" -o -name "*.d.cts" \) -delete
find "$DEST" -type l -delete

du -sh "$DEST"
