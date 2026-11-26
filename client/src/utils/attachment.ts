export const DEFAULT_ATTACHMENT_MAX_FILE_SIZE = 20 * 1024 * 1024;

/**
 * Append a `download` query parameter that carries the original file name.
 * The blob endpoint turns this parameter into a `Content-Disposition: attachment`
 * header, so clicking the link downloads the file instead of opening it inline.
 */
export function buildAttachmentDownloadUrl(url: string, fileName: string) {
  const [baseUrl, fragment = ""] = url.split("#", 2);
  const separator = baseUrl.includes("?") ? "&" : "?";
  const downloadUrl = `${baseUrl}${separator}download=${encodeURIComponent(fileName)}`;
  return fragment ? `${downloadUrl}#${fragment}` : downloadUrl;
}

function escapeMarkdownLabel(label: string) {
  return label.replace(/[[\]]/g, "").trim() || "file";
}

export function buildMarkdownAttachment(fileName: string, url: string) {
  return `[${escapeMarkdownLabel(fileName)}](${buildAttachmentDownloadUrl(url, fileName)})`;
}

/**
 * Returns the file name encoded in a download link, or `null` when the link
 * is not an attachment link.
 */
export function parseAttachmentDownloadName(href?: string | null) {
  if (!href) {
    return null;
  }

  const queryIndex = href.indexOf("?");
  if (queryIndex === -1) {
    return null;
  }

  const hashIndex = href.indexOf("#", queryIndex);
  const query = href.slice(queryIndex + 1, hashIndex === -1 ? undefined : hashIndex);
  const name = new URLSearchParams(query).get("download");

  return name && name.trim() ? name : null;
}

/**
 * Detects a Worker blob URL stored under the protected attachment folder and
 * falls back to the key's file name when no `download` parameter is present.
 */
export function parseAttachmentBlobName(href?: string | null) {
  if (!href) {
    return null;
  }

  try {
    const url = new URL(href, "https://rin.local");
    if (!url.pathname.includes("/api/blob/")) {
      return null;
    }

    const segments = url.pathname.split("/");
    const folderIndex = segments.lastIndexOf("attachments");
    if (folderIndex === -1 || folderIndex >= segments.length - 1) {
      return null;
    }

    const name = decodeURIComponent(segments[segments.length - 1]);
    return name || null;
  } catch {
    return null;
  }
}

export function resolveAttachmentName(href?: string | null) {
  return parseAttachmentDownloadName(href) ?? parseAttachmentBlobName(href);
}
