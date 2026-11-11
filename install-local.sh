#!/usr/bin/env bash
# Copies djAddButton.js into Spicetify's Extensions folder, enables it, and applies.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v spicetify >/dev/null || { echo "spicetify not found on PATH" >&2; exit 1; }

EXT_DIR="$(spicetify path userdata)/Extensions"
mkdir -p "$EXT_DIR"
cp "$SCRIPT_DIR/djAddButton.js" "$EXT_DIR/"
echo "Copied djAddButton.js -> $EXT_DIR"

spicetify config extensions djAddButton.js
spicetify apply
