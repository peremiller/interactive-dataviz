#!/usr/bin/env bash
# Auto-bump the service-worker cache version, commit, and push to GitHub Pages.
# Usage: npm run deploy ["commit message"]
set -euo pipefail
cd "$(dirname "$0")"

MSG="${1:-Update site}"

# Bump data-explorer-vN -> data-explorer-v(N+1) in sw.js
OLD=$(grep -oE 'data-explorer-v[0-9]+' sw.js | head -1)
if [ -z "$OLD" ]; then
  echo "✗ Could not find cache version (data-explorer-vN) in sw.js"; exit 1
fi
N=${OLD##*-v}
NEW="data-explorer-v$((N + 1))"
# Portable in-place sed (works on macOS and Linux)
sed -i.bak "s/$OLD/$NEW/" sw.js && rm -f sw.js.bak
echo "↻ Cache version: $OLD → $NEW"

if git diff --quiet && git diff --cached --quiet; then
  echo "✗ No changes to deploy"; exit 0
fi

git add -A
git commit -qm "$MSG (cache $NEW)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push -q origin master

URL="https://peremiller.github.io/interactive-dataviz/"
echo "⬆ Pushed. GitHub Pages will rebuild in ~1 min."
echo "📱 $URL"

# Poll until the new cache version is live
printf "⏳ Waiting for live deploy"
for i in $(seq 1 25); do
  if curl -s "${URL}sw.js" | grep -q "$NEW"; then echo " — ✅ live ($NEW)"; exit 0; fi
  printf "."; sleep 12
done
echo " — still building; check $URL shortly."
