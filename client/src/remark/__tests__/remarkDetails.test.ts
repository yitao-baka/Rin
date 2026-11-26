import { describe, expect, it } from "bun:test";
import { transformDetails } from "../remarkDetails";

type Node = {
  type: string;
  value?: string;
  children?: Node[];
};

const paragraph = (value: string): Node => ({
  type: "paragraph",
  children: [{ type: "text", value }],
});

function run(children: Node[]) {
  const tree: Node = { type: "root", children };
  transformDetails(tree);
  return tree.children ?? [];
}

describe("transformDetails", () => {
  it("turns a details container into a details/summary pair", () => {
    const children = run([
      paragraph(":::details Summary"),
      paragraph("Hidden **markdown** content"),
      paragraph(":::"),
    ]);

    expect(children).toHaveLength(3);
    expect(children[0]).toEqual({
      type: "html",
      value: "<details><summary>Summary</summary>",
    });
    expect(children[1]).toEqual(paragraph("Hidden **markdown** content"));
    expect(children[2]).toEqual({ type: "html", value: "</details>" });
  });

  it("supports the open modifier and a space after the marker", () => {
    const [opening] = run([
      paragraph("::: details[open] More"),
      paragraph("Body"),
      paragraph(":::"),
    ]);

    expect(opening).toEqual({
      type: "html",
      value: "<details open><summary>More</summary>",
    });
  });

  it("escapes html in the summary", () => {
    const [opening] = run([
      paragraph(":::details <script>alert(1)</script>"),
      paragraph("Body"),
      paragraph(":::"),
    ]);

    expect(opening.value).toBe(
      "<details><summary>&lt;script&gt;alert(1)&lt;/script&gt;</summary>",
    );
  });

  it("nests containers", () => {
    const children = run([
      paragraph(":::collapse Outer"),
      paragraph(":::spoiler Inner"),
      paragraph("Content"),
      paragraph(":::"),
      paragraph(":::"),
    ]);

    expect(children.map((node) => node.type)).toEqual([
      "html",
      "html",
      "paragraph",
      "html",
      "html",
    ]);
    expect(children[0].value).toContain("<summary>Outer</summary>");
    expect(children[1].value).toContain("<summary>Inner</summary>");
  });

  it("does not treat inline code as a marker", () => {
    const inlineCode: Node = {
      type: "paragraph",
      children: [{ type: "inlineCode", value: ":::details Summary" }],
    };
    const children = run([
      inlineCode,
      paragraph("Body"),
      paragraph(":::"),
    ]);

    expect(children).toHaveLength(3);
    expect(children[0]).toBe(inlineCode);
  });

  it("leaves unclosed containers untouched", () => {
    const input = [paragraph(":::details Summary"), paragraph("Body")];
    expect(run(input)).toEqual(input);
  });

  it("requires the marker to be on its own line", () => {
    const input = [paragraph(":::details Summary\nBody line"), paragraph(":::")];
    expect(run(input)).toEqual(input);
  });
});
