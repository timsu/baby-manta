import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";

function readDraft(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Ignore storage failures (private mode, quota, etc.). Draft persistence is best-effort.
  }
}

export function useDebouncedLocalStorageDraft(key: string, delayMs = 300) {
  const [value, setValue] = useState(() => readDraft(key));
  const latestValueRef = useRef(value);

  const setDraft = useCallback((next: SetStateAction<string>) => {
    setValue((current) => {
      const resolved = typeof next === "function" ? (next as (current: string) => string)(current) : next;
      latestValueRef.current = resolved;
      return resolved;
    });
  }, []);

  useEffect(() => {
    const stored = readDraft(key);
    latestValueRef.current = stored;
    setValue(stored);
  }, [key]);

  useEffect(() => {
    const timeout = window.setTimeout(() => writeDraft(key, value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, key, value]);

  useEffect(() => {
    const storageKey = key;
    return () => writeDraft(storageKey, latestValueRef.current);
  }, [key]);

  const clear = useCallback(() => {
    latestValueRef.current = "";
    setValue("");
    writeDraft(key, "");
  }, [key]);

  return [value, setDraft, clear] as const;
}
