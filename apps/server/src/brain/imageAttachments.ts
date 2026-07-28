import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const IMAGE_URL_RE = /!\[([^\]]*)\]\(((?:https?:\/\/[^/]+)?\/api\/images\/([a-z0-9]+))\)/g;

export interface BrainImageAttachment {
  mimeType: string;
  data: string;
}

export interface ResolveMessageImageAttachmentsOptions {
  workspaceId: string;
  getImage: (id: string) => Promise<BrainImageAttachment | null>;
  imageDir?: string;
}

function imageExtension(mimeType: string): string {
  return mimeType.split("/")[1]?.split(";")[0]?.replace("+xml", "") || "png";
}

/**
 * Replace uploaded Manta image URLs with local files before prompting Pi. The
 * worker daemon already does this for card turns; brain turns run in-process on
 * the server and otherwise hand Pi opaque `/api/images/<id>` markdown that it
 * cannot inspect as an image attachment.
 */
export async function resolveMessageImageAttachments(
  message: string,
  opts: ResolveMessageImageAttachmentsOptions,
): Promise<string> {
  const matches = [...message.matchAll(IMAGE_URL_RE)];
  if (matches.length === 0) return message;

  const imageDir = opts.imageDir ?? join(tmpdir(), "manta-brain-images", opts.workspaceId);
  await mkdir(imageDir, { recursive: true });

  let result = message;
  for (const [full, alt, , id] of matches) {
    if (!id) continue;
    const image = await opts.getImage(id);
    if (!image) continue;
    const dest = join(imageDir, `${id}.${imageExtension(image.mimeType)}`);
    await writeFile(dest, Buffer.from(image.data, "base64"));
    result = result.replaceAll(full, `![${alt ?? ""}](${dest})`);
  }
  return result;
}
