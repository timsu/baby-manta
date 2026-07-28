import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMessageImageAttachments } from "./imageAttachments.ts";

describe("resolveMessageImageAttachments", () => {
  it("downloads uploaded image URLs to local files for Pi", async () => {
    const imageDir = join(process.cwd(), ".tmp", "brain-image-test", String(Date.now()));
    await mkdir(imageDir, { recursive: true });
    const bytes = Buffer.from("fake png bytes");

    const message = "please inspect ![screen](/api/images/imgabc123)";
    const resolved = await resolveMessageImageAttachments(message, {
      workspaceId: "ws1",
      imageDir,
      getImage: async (id) => {
        expect(id).toBe("imgabc123");
        return { mimeType: "image/png", data: bytes.toString("base64") };
      },
    });

    const expectedPath = join(imageDir, "imgabc123.png");
    expect(resolved).toBe(`please inspect ![screen](${expectedPath})`);
    expect(await readFile(expectedPath)).toEqual(bytes);
  });

  it("leaves unknown uploaded image URLs unchanged", async () => {
    const imageDir = join(process.cwd(), ".tmp", "brain-image-test", `missing-${Date.now()}`);
    const message = "![screen](https://manta.example/api/images/missing123)";

    await expect(resolveMessageImageAttachments(message, {
      workspaceId: "ws1",
      imageDir,
      getImage: async () => null,
    })).resolves.toBe(message);
  });
});
