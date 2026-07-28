import { useCallback, useEffect, useRef, useState } from "react";
import { Chat } from "./Chat.tsx";

const WINDOW_MARGIN = 12;

type Position = { left: number; top: number };

export function clampFloatingChatPosition(
  position: Position,
  windowSize: { width: number; height: number },
  viewport: { width: number; height: number },
): Position {
  return {
    left: Math.min(Math.max(WINDOW_MARGIN, position.left), Math.max(WINDOW_MARGIN, viewport.width - windowSize.width - WINDOW_MARGIN)),
    top: Math.min(Math.max(WINDOW_MARGIN, position.top), Math.max(WINDOW_MARGIN, viewport.height - windowSize.height - WINDOW_MARGIN)),
  };
}

export function FloatingChat({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const windowRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(open);
  const dragRef = useRef<null | { pointerId: number; offsetX: number; offsetY: number }>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (open) {
      windowRef.current?.querySelector<HTMLTextAreaElement>("textarea:not(:disabled)")?.focus();
    } else if (wasOpenRef.current) {
      launcherRef.current?.focus();
    }
    wasOpenRef.current = open;
  }, [open]);

  const keepInViewport = useCallback(() => {
    const element = windowRef.current;
    if (!element || expanded) return;
    const rect = element.getBoundingClientRect();
    setPosition((current) => current
      ? clampFloatingChatPosition(current, rect, { width: window.innerWidth, height: window.innerHeight })
      : current);
  }, [expanded]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      const element = windowRef.current;
      if (!drag || drag.pointerId !== event.pointerId || !element) return;
      const rect = element.getBoundingClientRect();
      setPosition(clampFloatingChatPosition(
        { left: event.clientX - drag.offsetX, top: event.clientY - drag.offsetY },
        rect,
        { width: window.innerWidth, height: window.innerHeight },
      ));
    };
    const onPointerUp = (event: PointerEvent) => {
      if (dragRef.current?.pointerId !== event.pointerId) return;
      dragRef.current = null;
      document.body.classList.remove("dragging-floating-chat");
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("resize", keepInViewport);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("resize", keepInViewport);
      document.body.classList.remove("dragging-floating-chat");
    };
  }, [keepInViewport]);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (expanded || event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const rect = windowRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    setPosition({ left: rect.left, top: rect.top });
    document.body.classList.add("dragging-floating-chat");
    event.preventDefault();
  };

  if (!open) {
    return (
      <button ref={launcherRef} className="chat-fab" aria-label="Open Manta chat" title="Chat with Manta" onClick={() => onOpenChange(true)}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M5.5 18.5 3.8 21l.6-4A8 8 0 1 1 7 19.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8 11.5h8M8 8.5h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span>Chat</span>
      </button>
    );
  }

  return (
    <div
      ref={windowRef}
      className={`floating-chat-window ${expanded ? "expanded" : ""}`}
      style={position && !expanded ? { left: position.left, top: position.top, right: "auto", bottom: "auto" } : undefined}
      role="dialog"
      aria-label="Manta chat"
    >
      <div className="floating-chat-titlebar" onPointerDown={startDrag}>
        <div>
          <strong>Manta chat</strong>
          <span>Brain &amp; repo</span>
        </div>
        <div className="floating-chat-actions">
          <button
            className="btn ghost icon-btn"
            aria-label={expanded ? "Restore chat window" : "Expand chat window"}
            title={expanded ? "Restore" : "Expand"}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "↙" : "↗"}
          </button>
          <button className="btn ghost icon-btn" aria-label="Close chat" title="Close" onClick={() => onOpenChange(false)}>×</button>
        </div>
      </div>
      <Chat />
    </div>
  );
}
