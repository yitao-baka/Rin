import { describe, expect, it } from "bun:test";
import {
  buildAttachmentDownloadUrl,
  buildMarkdownAttachment,
  parseAttachmentBlobName,
  parseAttachmentDownloadName,
  resolveAttachmentName,
} from "../attachment";

describe("attachment helpers", () => {
  it("adds a download query parameter with the original file name", () => {
    expect(buildAttachmentDownloadUrl("https://example.com/api/blob/abc.pdf", "手册.pdf")).toBe(
      "https://example.com/api/blob/abc.pdf?download=%E6%89%8B%E5%86%8C.pdf",
    );
  });

  it("keeps existing query strings and fragments", () => {
    expect(buildAttachmentDownloadUrl("/api/blob/abc.zip?x=1#y", "a b.zip")).toBe(
      "/api/blob/abc.zip?x=1&download=a%20b.zip#y",
    );
  });

  it("builds a markdown link without brackets in the label", () => {
    expect(buildMarkdownAttachment("[draft].pdf", "/api/blob/abc.pdf")).toBe(
      "[draft.pdf](/api/blob/abc.pdf?download=%5Bdraft%5D.pdf)",
    );
  });

  it("parses the download file name from a link", () => {
    expect(parseAttachmentDownloadName("/api/blob/abc.pdf?download=%E6%89%8B%E5%86%8C.pdf")).toBe(
      "手册.pdf",
    );
  });

  it("returns null for ordinary links", () => {
    expect(parseAttachmentDownloadName("https://example.com")).toBeNull();
    expect(parseAttachmentDownloadName("/api/blob/abc.pdf")).toBeNull();
    expect(parseAttachmentDownloadName(undefined)).toBeNull();
  });

  it("detects attachment blob paths without a download parameter", () => {
    expect(parseAttachmentBlobName("/api/blob/images/attachments/abc.pdf")).toBe("abc.pdf");
    expect(parseAttachmentBlobName("https://api.example.com/api/blob/images/attachments/a%20b.zip")).toBe(
      "a b.zip",
    );
    expect(parseAttachmentBlobName("/api/blob/images/photo.png")).toBeNull();
    expect(parseAttachmentBlobName("https://example.com/files/attachments/abc.pdf")).toBeNull();
  });

  it("prefers the download parameter when resolving a name", () => {
    expect(resolveAttachmentName("/api/blob/images/attachments/abc.pdf?download=manual.pdf")).toBe(
      "manual.pdf",
    );
    expect(resolveAttachmentName("/api/blob/images/attachments/abc.pdf")).toBe("abc.pdf");
    expect(resolveAttachmentName("https://example.com")).toBeNull();
  });
});
