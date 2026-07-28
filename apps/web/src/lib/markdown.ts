import { useEffect } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

const renderer = new marked.Renderer();
const renderLink = renderer.link.bind(renderer);
renderer.link = (token) => renderLink(token).replace(/^<a /, '<a target="_blank" rel="noopener noreferrer" ');

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { renderer }) as string, {
    ADD_ATTR: ["rel", "target"],
    ADD_DATA_URI_TAGS: ["img"],
  });
}

export function shouldOpenOutsideManta(anchor: HTMLAnchorElement): boolean {
  const href = anchor.getAttribute("href");
  if (!href || href.startsWith("#") || anchor.hasAttribute("download")) return false;
  try {
    const url = new URL(href, window.location.href);
    if (url.origin === window.location.origin) return false;
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" || url.protocol === "tel:";
  } catch {
    return false;
  }
}

export function useOpenExternalLinksOutsideManta() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(target instanceof HTMLAnchorElement) || !shouldOpenOutsideManta(target)) return;
      e.preventDefault();
      window.open(target.href, "_blank", "noopener,noreferrer");
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
}
