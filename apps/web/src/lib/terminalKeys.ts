type TerminalKeyEvent = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "type"> & {
  code?: string;
};

/**
 * Browser/xterm can encode macOS Option+word-navigation chords as CSI modifier
 * arrows (ESC [ 1 ; 3 C/D). Some shells/editors do not bind those sequences and
 * leave the suffix (for example `;3C`) in the prompt. Normalize the common macOS
 * Option word-navigation keys to the Meta-f/Meta-b bytes readline/zsh expect.
 */
export function inputForMacOptionWordKey(event: TerminalKeyEvent): string | null {
  if (event.type !== "keydown" || !event.altKey || event.ctrlKey || event.metaKey) return null;

  switch (event.code) {
    case "KeyF":
      return "\x1bf";
    case "KeyB":
      return "\x1bb";
    default:
      break;
  }

  switch (event.key) {
    case "f":
    case "F":
    case "ƒ":
      return "\x1bf";
    case "b":
    case "B":
    case "∫":
      return "\x1bb";
    case "ArrowRight":
      return "\x1bf";
    case "ArrowLeft":
      return "\x1bb";
    default:
      return null;
  }
}
