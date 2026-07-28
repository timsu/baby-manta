import { useStore } from "@nanostores/react";
import { $mantaHidden, $toasts } from "../stores.ts";

export function Toasts() {
  const toasts = useStore($toasts);
  const mantaHidden = useStore($mantaHidden);
  if (!toasts.length || !mantaHidden) return null;
  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          <span>{t.msg}</span>
          {t.action && (
            <button className="toast-action" onClick={t.action.onClick}>{t.action.label}</button>
          )}
        </div>
      ))}
    </div>
  );
}
