import { api } from "../api.ts";

export type PastedImage = { id: string; name: string; dataUrl: string };

export function pastedImageMarkdown(image: Pick<PastedImage, "name" | "dataUrl">): string {
  const safeName = (image.name || "pasted image").replace(/[\]\n\r]/g, " ").trim() || "pasted image";
  return `![${safeName}](${image.dataUrl})`;
}

export function imagePasteMarkdown(file: File, dataUrl: string): string {
  return pastedImageMarkdown({ name: file.name, dataUrl });
}

export async function readAsDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image"));
    reader.readAsDataURL(file);
  });
}

export function clipboardImageFiles(e: React.ClipboardEvent): File[] {
  const itemFiles = Array.from(e.clipboardData.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file);
  const fileListFiles = Array.from(e.clipboardData.files).filter((file) => file.type.startsWith("image/"));
  return itemFiles.length > 0 ? itemFiles : fileListFiles;
}

export async function clipboardImageMarkdown(e: React.ClipboardEvent): Promise<string | null> {
  const files = clipboardImageFiles(e);
  if (files.length === 0) return null;
  e.preventDefault();
  const parts = await Promise.all(files.map(async (file) => imagePasteMarkdown(file, await readAsDataUrl(file))));
  return parts.join("\n");
}

function safeAltText(name: string | undefined, fallback: string): string {
  return (name || fallback).replace(/[\]\n\r]/g, " ").trim() || fallback;
}

async function uploadDataUrl(workspaceId: string, dataUrl: string, mimeType: string): Promise<string> {
  const comma = dataUrl.indexOf(",");
  const data = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
  const { url } = await api.uploadImage(workspaceId, mimeType, data);
  return url;
}

/** Upload a PastedImage (dataUrl) to the server and return `![name](url)` markdown. */
export async function uploadPastedImageMarkdown(workspaceId: string, name: string, dataUrl: string): Promise<string> {
  const semi = dataUrl.indexOf(";");
  const mimeType = semi === -1 ? "image/png" : dataUrl.slice(5, semi);
  const url = await uploadDataUrl(workspaceId, dataUrl, mimeType);
  return `![${safeAltText(name, "image")}](${url})`;
}

/** Upload a File to the server and return `![name](url)` markdown. */
export async function uploadImageMarkdown(workspaceId: string, file: File): Promise<string> {
  const dataUrl = await readAsDataUrl(file);
  const url = await uploadDataUrl(workspaceId, dataUrl, file.type || "image/png");
  return `![${safeAltText(file.name, "image")}](${url})`;
}

/** Upload all images pasted from a clipboard event and return combined markdown, or null if no images. */
export async function clipboardUploadedImageMarkdown(
  workspaceId: string,
  e: React.ClipboardEvent,
): Promise<string | null> {
  const files = clipboardImageFiles(e);
  if (files.length === 0) return null;
  e.preventDefault();
  const parts = await Promise.all(files.map((file) => uploadImageMarkdown(workspaceId, file)));
  return parts.join("\n");
}

export function insertIntoValueAtRange(value: string, start: number, end: number, text: string): { value: string; cursor: number } {
  const boundedStart = Math.max(0, Math.min(start, value.length));
  const boundedEnd = Math.max(boundedStart, Math.min(end, value.length));
  const before = value.slice(0, boundedStart);
  const after = value.slice(boundedEnd);
  const spacerBefore = before && !before.endsWith("\n") ? "\n" : "";
  const spacerAfter = after && !after.startsWith("\n") ? "\n" : "";
  const insert = `${spacerBefore}${text}${spacerAfter}`;
  return { value: before + insert + after, cursor: before.length + insert.length };
}
