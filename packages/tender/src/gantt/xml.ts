/**
 * A small XML reader and writer, enough for MSPDI (MS Project's XML). Written here so the same code runs in the browser and on the server
 * with no dependency. The reader ignores namespaces and attributes, decodes the standard entities, and handles comments, CDATA and the
 * XML declaration. It does not validate.
 */
export interface XmlNode {
  name: string;
  text: string;
  children: XmlNode[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });

export function parseXml(src: string): XmlNode {
  const text = src.replace(/^﻿/, "");
  const root: XmlNode = { name: "#document", text: "", children: [] };
  const stack: XmlNode[] = [root];
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i) stack[stack.length - 1]!.text += decode(text.slice(i, lt));
    if (text.startsWith("<!--", lt)) { const e = text.indexOf("-->", lt + 4); if (e < 0) throw new Error("This XML has an unfinished comment."); i = e + 3; continue; }
    if (text.startsWith("<![CDATA[", lt)) { const e = text.indexOf("]]>", lt + 9); if (e < 0) throw new Error("This XML has an unfinished CDATA section."); stack[stack.length - 1]!.text += text.slice(lt + 9, e); i = e + 3; continue; }
    if (text.startsWith("<?", lt)) { const e = text.indexOf("?>", lt + 2); if (e < 0) throw new Error("This XML has an unfinished declaration."); i = e + 2; continue; }
    if (text.startsWith("<!", lt)) { const e = text.indexOf(">", lt + 2); if (e < 0) throw new Error("This XML has an unfinished declaration."); i = e + 1; continue; }
    // a tag: find its closing '>' outside quotes
    let j = lt + 1;
    let quote = "";
    while (j < text.length) {
      const c = text[j]!;
      if (quote) { if (c === quote) quote = ""; } else if (c === '"' || c === "'") quote = c; else if (c === ">") break;
      j++;
    }
    if (j >= text.length) throw new Error("This XML ends in the middle of a tag.");
    const inner = text.slice(lt + 1, j);
    i = j + 1;
    if (inner.startsWith("/")) {
      const nm = local(inner.slice(1).trim());
      const top = stack.pop();
      if (!top || stack.length === 0 || top.name !== nm) throw new Error(`This XML closes <${nm}> where <${top?.name ?? "?"}> was open.`);
      continue;
    }
    const selfClosing = inner.endsWith("/");
    const nm = local(inner.replace(/\/$/, "").trim().split(/\s/)[0]!);
    const node: XmlNode = { name: nm, text: "", children: [] };
    stack[stack.length - 1]!.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) throw new Error(`This XML is missing the end of <${stack[stack.length - 1]!.name}>.`);
  const top = root.children[0];
  if (!top) throw new Error("This file has no XML in it.");
  return top;
}

const local = (n: string) => (n.includes(":") ? n.slice(n.indexOf(":") + 1) : n);

export const child = (n: XmlNode | undefined, name: string): XmlNode | undefined => n?.children.find((c) => c.name === name);
export const kids = (n: XmlNode | undefined, name: string): XmlNode[] => n?.children.filter((c) => c.name === name) ?? [];
export const textOf = (n: XmlNode | undefined, name: string): string => child(n, name)?.text.trim() ?? "";

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// characters XML 1.0 can't hold are dropped
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "");

/** Builds indented XML text. `el(name, value)` writes a leaf (skipped when the value is undefined); `open`/`close` nest. */
export class XmlWriter {
  private out: string[] = [];
  private depth = 0;
  declaration() { this.out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'); return this; }
  open(name: string, attrs = "") { this.out.push(`${"  ".repeat(this.depth)}<${name}${attrs}>`); this.depth++; return this; }
  close(name: string) { this.depth--; this.out.push(`${"  ".repeat(this.depth)}</${name}>`); return this; }
  el(name: string, value: string | number | boolean | undefined | null) {
    if (value === undefined || value === null) return this;
    const v = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
    this.out.push(`${"  ".repeat(this.depth)}<${name}>${esc(clean(v))}</${name}>`);
    return this;
  }
  toString() { return `${this.out.join("\r\n")}\r\n`; }
}
