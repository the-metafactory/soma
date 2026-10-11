/** Select H2 sections, ignoring headings inside fenced code; preserve source order. */
export function selectMarkdownSections(body: string, names: readonly string[]): {
  sections: { name: string; markdown: string }[]; missing: string[];
} {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const sections: { name: string; markdown: string }[] = [];
  let current: { name: string; lines: string[] } | undefined;
  let fence: { char: string; length: number } | undefined;
  const flush = (): void => {
    if (current && wanted.has(current.name.toLowerCase())) {
      sections.push({ name: current.name, markdown: current.lines.join("\n").trimEnd() });
    }
    current = undefined;
  };
  for (const line of body.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      current?.lines.push(line);
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) {
      fence = { char: marker[1][0], length: marker[1].length };
      current?.lines.push(line);
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,2})[ \t]+(.+?)\s*$/);
    if (heading) {
      flush();
      if (heading[1] === "##") current = { name: heading[2].replace(/\s+#+\s*$/, ""), lines: [line] };
    } else current?.lines.push(line);
  }
  flush();
  return { sections, missing: names.filter((name) => !sections.some((section) => section.name.toLowerCase() === name.toLowerCase())) };
}
