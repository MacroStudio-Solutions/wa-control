#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist/release"
TARGET="${1:-all}"

if ! command -v bun >/dev/null 2>&1; then
  printf 'Erro: bun nao encontrado no PATH.\n' >&2
  exit 1
fi

VERSION="$(bun -e 'import pkg from "./package.json" with { type: "json" }; console.log(pkg.version)')"

build_linux_x64() {
  local slug="wa-control-v${VERSION}-linux-x64"
  local target_dir="$DIST_DIR/$slug"

  rm -rf "$target_dir" "$DIST_DIR/$slug.tar.gz"
  mkdir -p "$target_dir"

  bun build "$ROOT_DIR/src/main.ts" \
    --compile \
    --target=bun-linux-x64-baseline \
    --minify \
    --bytecode \
    --outfile="$target_dir/wa"

  tar -C "$DIST_DIR" -czf "$DIST_DIR/$slug.tar.gz" "$slug"
  printf 'Linux x64 gerado em %s e %s\n' "$target_dir/wa" "$DIST_DIR/$slug.tar.gz"
}

build_windows_x64() {
  local slug="wa-control-v${VERSION}-windows-x64"
  local target_dir="$DIST_DIR/$slug"

  rm -rf "$target_dir" "$DIST_DIR/$slug.zip"
  mkdir -p "$target_dir"

  bun build "$ROOT_DIR/src/main.ts" \
    --compile \
    --target=bun-windows-x64-baseline \
    --minify \
    --bytecode \
    --outfile="$target_dir/wa.exe"

  (
    cd "$DIST_DIR"
    python3 -m zipfile -c "$slug.zip" "$slug/wa.exe"
  )
  printf 'Windows x64 gerado em %s e %s\n' "$target_dir/wa.exe" "$DIST_DIR/$slug.zip"
}

mkdir -p "$DIST_DIR"

case "$TARGET" in
  linux-x64)
    build_linux_x64
    ;;
  windows-x64)
    build_windows_x64
    ;;
  all)
    build_linux_x64
    build_windows_x64
    ;;
  *)
    printf 'Uso: %s [linux-x64|windows-x64|all]\n' "${BASH_SOURCE[0]}" >&2
    exit 1
    ;;
esac
