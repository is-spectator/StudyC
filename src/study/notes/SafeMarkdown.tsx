import { createElement } from "react";
/** Supported Markdown is rendered only as text children. HTML, links and images stay literal. */
export default function SafeMarkdown({ body }: { body: string }) {
  const lines = body.replace(/\r\n?/g, "\n").split("\n"),
    out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      out.push(
        createElement(`h${heading[1].length + 1}`, { key: i }, heading[2]),
      );
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const start = i,
        ordered = /^\s*\d+\.\s+/.test(line),
        pattern = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/,
        items = [];
      while (i < lines.length && pattern.test(lines[i])) {
        items.push(
          createElement("li", { key: i }, lines[i].replace(pattern, "")),
        );
        i++;
      }
      out.push(createElement(ordered ? "ol" : "ul", { key: start }, items));
      continue;
    }
    if (/^>\s?/.test(line)) {
      const start = i,
        parts = [];
      while (i < lines.length && /^>\s?/.test(lines[i]))
        parts.push(lines[i++].replace(/^>\s?/, ""));
      out.push(createElement("blockquote", { key: start }, parts.join("\n")));
      continue;
    }
    const start = i,
      parts = [lines[i++]];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,3}\s|>\s?|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i])
    )
      parts.push(lines[i++]);
    out.push(createElement("p", { key: start }, parts.join("\n")));
  }
  return <div className="note-markdown">{out}</div>;
}
