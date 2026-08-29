#!/usr/bin/env bash
# Transkribiert alle ASINs aus der .env mit Mistral OCR (Batch).
set -u
export PATH="$HOME/.npm-global/bin:$PATH"
cd "$(dirname "$0")"
echo "=== OCR gestartet: $(date '+%F %T') ==="
MISTRAL_MODE=batch npx tsx src/transcribe-book-content.ts
echo "=== OCR beendet (rc=$?): $(date '+%F %T') ==="
