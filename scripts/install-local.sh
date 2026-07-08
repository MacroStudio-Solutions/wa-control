#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${WA_CONTROL_INSTALL_DIR:-$HOME/.local/bin}"
BIN_NAME="${WA_CONTROL_BIN_NAME:-wa}"
TARGET_PATH="$INSTALL_DIR/$BIN_NAME"
MARKER_BEGIN="# >>> wa-control PATH >>>"
MARKER_END="# <<< wa-control PATH <<<"
PATH_LINE="export PATH=\"$INSTALL_DIR:\$PATH\""

ensure_path_snippet() {
  local rc_file
  rc_file="$1"

  mkdir -p "$(dirname "$rc_file")"
  touch "$rc_file"

  if grep -Fqx "$PATH_LINE" "$rc_file"; then
    return
  fi

  if grep -Fq "$MARKER_BEGIN" "$rc_file"; then
    return
  fi

  {
    printf '\n%s\n' "$MARKER_BEGIN"
    printf '%s\n' "$PATH_LINE"
    printf '%s\n' "$MARKER_END"
  } >> "$rc_file"
}

ensure_bash_path() {
  if [[ -n "${WA_CONTROL_SHELL_RC:-}" ]]; then
    ensure_path_snippet "$WA_CONTROL_SHELL_RC"
    return
  fi

  ensure_path_snippet "$HOME/.bashrc"
  ensure_path_snippet "$HOME/.profile"
}

ensure_zsh_path() {
  if [[ -n "${WA_CONTROL_SHELL_RC:-}" ]]; then
    ensure_path_snippet "$WA_CONTROL_SHELL_RC"
    return
  fi

  ensure_path_snippet "$HOME/.zshrc"
}

if ! command -v bun >/dev/null 2>&1; then
  printf 'Erro: bun nao encontrado no PATH.\n' >&2
  exit 1
fi

cd "$ROOT_DIR"
bun run build

mkdir -p "$INSTALL_DIR"
install -m 755 "$ROOT_DIR/dist/wa" "$TARGET_PATH"

PATH_UPDATED=0
case "${SHELL:-}" in
  */zsh)
    ensure_zsh_path
    ;;
  *)
    ensure_bash_path
    ;;
esac

case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    ;;
  *)
    PATH_UPDATED=1
    ;;
esac

printf 'Binario instalado em %s\n' "$TARGET_PATH"

if [[ -n "${WA_CONTROL_SHELL_RC:-}" ]]; then
  printf 'Arquivo de shell garantido em %s\n' "$WA_CONTROL_SHELL_RC"
elif [[ "${SHELL:-}" == */zsh ]]; then
  printf 'Arquivos de shell garantidos em %s\n' "$HOME/.zshrc"
else
  printf 'Arquivos de shell garantidos em %s e %s\n' "$HOME/.bashrc" "$HOME/.profile"
fi

if [[ "$PATH_UPDATED" -eq 1 ]]; then
  if [[ -n "${WA_CONTROL_SHELL_RC:-}" ]]; then
    printf 'Execute: source "%s"\n' "$WA_CONTROL_SHELL_RC"
  elif [[ "${SHELL:-}" == */zsh ]]; then
    printf 'Execute: source "%s"\n' "$HOME/.zshrc"
  else
    printf 'Execute: source "%s"\n' "$HOME/.bashrc"
  fi
fi

printf 'Teste sugerido: %s help\n' "$BIN_NAME"
