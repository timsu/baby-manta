import { useRef, useState } from "react";
import { clipboardImageFiles, clipboardImageMarkdown, insertIntoValueAtRange, readAsDataUrl, type PastedImage } from "../lib/images.ts";

const fuzzyPathScore = (path: string, query: string) => {
  const target = path.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return 0;

  let cursor = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  let gaps = 0;
  for (const char of needle) {
    const matchIdx = target.indexOf(char, cursor);
    if (matchIdx === -1) return null;
    if (firstMatch === -1) firstMatch = matchIdx;
    if (lastMatch !== -1) gaps += matchIdx - lastMatch - 1;
    lastMatch = matchIdx;
    cursor = matchIdx + 1;
  }

  const basenameStart = target.lastIndexOf("/") + 1;
  const startsAtWordBoundary = firstMatch === 0 || "/-_ .".includes(target[firstMatch - 1] ?? "");
  return gaps * 10 + firstMatch + (firstMatch >= basenameStart ? 0 : 5) + (startsAtWordBoundary ? 0 : 3) + path.length / 1000;
};

export const mentionFileMatches = (files: string[], query: string, limit = 8) => files
  .map((file, index) => ({ file, index, score: fuzzyPathScore(file, query) }))
  .filter((match): match is { file: string; index: number; score: number } => match.score !== null)
  .sort((a, b) => a.score - b.score || a.index - b.index)
  .slice(0, limit)
  .map((match) => match.file);

export function MentionTextarea({
  value,
  onChange,
  files,
  pastedImages = [],
  onPastedImagesChange,
}: {
  value: string;
  onChange: React.Dispatch<React.SetStateAction<string>>;
  files: string[];
  pastedImages?: PastedImage[];
  onPastedImagesChange?: React.Dispatch<React.SetStateAction<PastedImage[]>>;
}) {
  const [matches, setMatches] = useState<string[]>([]);
  const [selIdx, setSelIdx] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  const getMentionQuery = (text: string, cursor: number) => {
    const before = text.slice(0, cursor);
    const m = before.match(/@([\w./\-]*)$/);
    return m ? (m[1] ?? null) : null;
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
    const query = getMentionQuery(e.target.value, e.target.selectionStart);
    if (query !== null && files.length > 0) {
      setMatches(mentionFileMatches(files, query));
      setSelIdx(0);
    } else {
      setMatches([]);
    }
  };

  const commit = (file: string) => {
    const cursor = ref.current!.selectionStart;
    const atIdx = value.lastIndexOf("@", cursor - 1);
    const newVal = value.slice(0, atIdx) + "@" + file + " " + value.slice(cursor);
    onChange(newVal);
    setMatches([]);
    setTimeout(() => {
      ref.current?.focus();
      const pos = atIdx + file.length + 2;
      ref.current?.setSelectionRange(pos, pos);
    }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setSelIdx((i) => (i + 1) % matches.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelIdx((i) => (i - 1 + matches.length) % matches.length); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); if (matches[selIdx]) commit(matches[selIdx]!); }
    else if (e.key === "Escape") { setMatches([]); }
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = clipboardImageFiles(e);
    if (imageFiles.length > 0 && onPastedImagesChange) {
      e.preventDefault();
      const images = await Promise.all(imageFiles.map(async (file, idx) => ({
        id: `${Date.now()}-${idx}-${file.name || "pasted-image"}`,
        name: file.name || `pasted image ${idx + 1}`,
        dataUrl: await readAsDataUrl(file),
      })));
      onPastedImagesChange((current) => [...current, ...images]);
      setMatches([]);
      return;
    }

    const start = e.currentTarget.selectionStart ?? value.length;
    const end = e.currentTarget.selectionEnd ?? start;
    const markdown = await clipboardImageMarkdown(e);
    if (!markdown) return;
    let cursor = start;
    onChange((current) => {
      const next = insertIntoValueAtRange(current, start, end, markdown);
      cursor = next.cursor;
      return next.value;
    });
    setMatches([]);
    setTimeout(() => ref.current?.setSelectionRange(cursor, cursor), 0);
  };

  return (
    <div style={{ position: "relative" }}>
      <textarea ref={ref} className="prompt" autoFocus value={value} placeholder="What should happen?"
        onChange={handleChange} onKeyDown={handleKeyDown} onPaste={(e) => void handlePaste(e)} />
      {pastedImages.length > 0 && onPastedImagesChange && (
        <div className="pasted-images" aria-label="Pasted images">
          {pastedImages.map((image) => (
            <div key={image.id} className="pasted-image-card">
              <img src={image.dataUrl} alt={image.name} />
              <div className="pasted-image-meta">
                <span title={image.name}>{image.name}</span>
                <button type="button" className="btn ghost" onClick={() => onPastedImagesChange((current) => current.filter((item) => item.id !== image.id))}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {matches.length > 0 && (
        <div className="mention-dropdown">
          {matches.map((f, i) => (
            <div key={f} className={`mention-item${i === selIdx ? " selected" : ""}`}
              onMouseDown={(e) => { e.preventDefault(); commit(f); }}>
              {f}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
