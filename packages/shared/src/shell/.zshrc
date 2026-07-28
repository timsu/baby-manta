# Manta terminal shell config — loaded via ZDOTDIR.
# Restore ZDOTDIR so nested zsh processes use the user's real config.
ZDOTDIR="$HOME"
[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"

# Override prompt last, after all user hooks, so themes can't clobber it.
# Show paths relative to the task worktree: ">" at the root, "apps/web>" inside it.
# Keep the prompt deliberately small and fully zsh-width-aware: readline/zle uses
# its prompt width when redrawing completions, so any untracked color bytes (for
# example from a sourced user theme/RPROMPT) make the browser cursor drift onto
# the prompt and tab completion repaint over the command being edited.
_manta_prompt() {
  local label root cwd
  root="${MANTA_WORKTREE_ROOT:A}"
  cwd="${PWD:A}"

  if [[ -n "$root" && "$cwd" == "$root" ]]; then
    label=""
  elif [[ -n "$root" && "$cwd" == "$root"/* ]]; then
    label="${cwd#$root/}"
    label="${label//\%/%%}"
  else
    label="%1~"
  fi

  setopt prompt_percent
  unsetopt prompt_subst
  PROMPT=$'%{\e[36m%}'"${label}"$'%{\e[0m\e[38;5;240m%}>%{\e[0m%} '
  RPROMPT=""
  RPS1=""
}
precmd_functions+=(_manta_prompt)
