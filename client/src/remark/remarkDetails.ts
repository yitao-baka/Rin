/**
 * Remark plugin that turns `:::details` container blocks into collapsible
 * `<details>` elements while keeping the inner content as regular markdown.
 *
 * ```md
 * :::details[open] Summary
 *
 * Hidden **markdown** content.
 *
 * :::
 * ```
 *
 * `[open]` expands the block by default. `details`, `collapse` and `spoiler`
 * are accepted as markers.
 */

type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
  [key: string]: unknown;
};

export type RemarkDetailsOptions = {
  /** Container markers accepted in addition to `details`. */
  markers?: string[];
  /** Summary shown when the block has no title. */
  defaultTitle?: string;
};

const DEFAULT_MARKERS = ["details", "collapse", "spoiler"];
const OPENER_PATTERN = /^:::\s*([a-z][\w-]*)\b(.*)$/i;
const CLOSER_PATTERN = /^:::\s*$/;

function nodeText(node: MdastNode): string {
  if (typeof node.value === "string") {
    return node.value;
  }
  if (!node.children) {
    return "";
  }
  return node.children.map(nodeText).join("");
}

/**
 * Returns the text of a single-line paragraph, or `null` when the paragraph
 * spans multiple lines. Markers must sit on their own line, which also keeps
 * inline code such as `` `:::details` `` from being mistaken for a marker and
 * prevents content from being dropped when the blank lines are missing.
 */
function paragraphLine(node: MdastNode) {
  if (node.type !== "paragraph") {
    return null;
  }
  const first = node.children?.[0];
  if (!first || first.type !== "text" || typeof first.value !== "string") {
    return null;
  }

  let line = "";
  for (const child of node.children ?? []) {
    if (child.type === "break") {
      return null;
    }
    const text = nodeText(child);
    const newlineIndex = text.indexOf("\n");
    if (newlineIndex !== -1) {
      return null;
    }
    line += text;
  }

  return line.trim();
}

type Opener = {
  open: boolean;
  title: string;
};

function parseOpener(node: MdastNode, markers: string[]): Opener | null {
  const line = paragraphLine(node);
  if (!line) {
    return null;
  }

  const match = OPENER_PATTERN.exec(line);
  if (!match) {
    return null;
  }

  const marker = match[1].toLowerCase();
  if (!markers.includes(marker)) {
    return null;
  }

  let rest = match[2].trim();
  let open = false;
  const openMatch = /^\[(open|closed)\]\s*/i.exec(rest);
  if (openMatch) {
    open = openMatch[1].toLowerCase() === "open";
    rest = rest.slice(openMatch[0].length).trim();
  }

  return { open, title: rest };
}

function isCloser(node: MdastNode) {
  const line = paragraphLine(node);
  return line !== null && CLOSER_PATTERN.test(line);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function walk(parent: MdastNode, markers: string[], defaultTitle: string) {
  const children = parent.children;
  if (!children) {
    return;
  }

  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    const opener = parseOpener(child, markers);

    if (opener) {
      let depth = 1;
      let closeIndex = -1;

      for (let cursor = index + 1; cursor < children.length; cursor++) {
        const sibling = children[cursor];
        if (isCloser(sibling)) {
          depth -= 1;
          if (depth === 0) {
            closeIndex = cursor;
            break;
          }
        } else if (parseOpener(sibling, markers)) {
          depth += 1;
        }
      }

      if (closeIndex !== -1) {
        const inner = children.slice(index + 1, closeIndex);
        walk({ type: "fragment", children: inner }, markers, defaultTitle);

        const title = opener.title || defaultTitle;
        const openAttribute = opener.open ? " open" : "";
        children.splice(
          index,
          closeIndex - index + 1,
          {
            type: "html",
            value: `<details${openAttribute}><summary>${escapeHtml(title)}</summary>`,
          },
          ...inner,
          { type: "html", value: "</details>" },
        );

        index += inner.length + 1;
        continue;
      }
    }

    walk(child, markers, defaultTitle);
  }
}

export function transformDetails(tree: MdastNode, options: RemarkDetailsOptions = {}) {
  const markers = (options.markers ?? DEFAULT_MARKERS).map((marker) => marker.toLowerCase());
  walk(tree, markers, options.defaultTitle ?? "Details");
}

export default function remarkDetails(options: RemarkDetailsOptions = {}) {
  return (tree: MdastNode) => {
    transformDetails(tree, options);
  };
}
