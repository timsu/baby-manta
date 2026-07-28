import { describe, expect, it, vi, afterEach } from "vitest";
import { appendTaskTranscriptLink, taskTranscriptUrl } from "./conversationLinks.ts";

describe("task transcript links", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds standalone transcript URLs from the configured web app URL", () => {
    vi.stubEnv("WEB_APP_URL", "https://manta.example.com/");
    expect(taskTranscriptUrl("w 1", "c/2")).toBe("https://manta.example.com/transcripts/w%201/c%2F2");
  });

  it("appends the transcript permalink to PR body text", () => {
    vi.stubEnv("WEB_APP_URL", "https://manta.example.com");
    expect(appendTaskTranscriptLink("Summary", "w1", "c1")).toBe(
      "Summary\n\n---\nManta conversation: https://manta.example.com/transcripts/w1/c1",
    );
  });

  it("does not duplicate an existing transcript permalink", () => {
    vi.stubEnv("WEB_APP_URL", "https://manta.example.com");
    const body = "Manta conversation: https://manta.example.com/transcripts/w1/c1";
    expect(appendTaskTranscriptLink(body, "w1", "c1")).toBe(body);
  });
});
