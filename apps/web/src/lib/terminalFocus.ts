function isInsideTerminal(element: EventTarget | null): boolean {
  return typeof (element as Element | null)?.closest === "function"
    && Boolean((element as Element).closest(".xterm"));
}

/** Whether a keyboard event belongs to the focused xterm instance. */
export function isTerminalFocused(target: EventTarget | null, activeElement: EventTarget | null): boolean {
  return isInsideTerminal(target) || isInsideTerminal(activeElement);
}

/** Forward Escape explicitly because preventing its browser behavior also prevents xterm from emitting it. */
export function forwardTerminalEscape(
  event: KeyboardEvent,
  activeElement: EventTarget | null,
  sendInput: (data: string) => void,
  refocus?: () => void,
): boolean {
  if (event.type !== "keydown" || event.key !== "Escape" || !isTerminalFocused(event.target, activeElement)) return false;
  event.preventDefault();
  event.stopPropagation();
  sendInput("\x1b");
  refocus?.();
  return true;
}
