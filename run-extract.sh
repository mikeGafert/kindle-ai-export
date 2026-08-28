#!/usr/bin/env bash
# Nur die Extraktion — die Transkription wird bewusst getrennt gestartet.
set -u
export PATH="$HOME/.npm-global/bin:$PATH"
cd "$(dirname "$0")"
echo "=== EXTRAKTION gestartet: $(date '+%F %T') ==="
npx tsx src/extract-kindle-book.ts
echo "=== EXTRAKTION beendet (rc=$?): $(date '+%F %T') ==="
