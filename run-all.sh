#!/usr/bin/env bash
# Extrahiert alle ASINs aus der .env und transkribiert sie anschliessend.
set -u
export PATH="$HOME/.npm-global/bin:$PATH"
cd "$(dirname "$0")"

echo "=== EXTRAKTION gestartet: $(date '+%F %T') ==="
npx tsx src/extract-kindle-book.ts
extract_rc=$?
echo "=== EXTRAKTION beendet (rc=$extract_rc): $(date '+%F %T') ==="

echo
echo "=== TRANSKRIPTION gestartet: $(date '+%F %T') ==="
npx tsx src/transcribe-book-content.ts
transcribe_rc=$?
echo "=== TRANSKRIPTION beendet (rc=$transcribe_rc): $(date '+%F %T') ==="

echo "FERTIG extract_rc=$extract_rc transcribe_rc=$transcribe_rc"
