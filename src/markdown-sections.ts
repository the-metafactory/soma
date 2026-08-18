/**
 * The one `## Heading` splitter for principal-authored markdown.
 *
 * Both the behavioral policy and the communication contract open-coded this
 * scan, and both exist because `soma-home.ts`'s `sectionBullets` (which keeps
 * only lines starting with `- `) was too lossy for authored prose. Three copies
 * of section-splitting means a heading-format change has to land in three
 * places, so the scan lives here and each parser keeps only its own fold.
 */

/** One `## Heading` block: the heading text and its raw body lines. */
export interface MarkdownSection {
  /** Heading text with the leading `## ` removed. */
  readonly heading: string;
  /** Raw body lines, verbatim, up to the next `## ` heading. */
  readonly lines: readonly string[];
}

/**
 * Split on `##` headings, in source order.
 *
 * Only `##` delimits: a leading `# Title` closes the current section and opens
 * nothing (a document title is not a section), and a deeper `### ` folds into
 * its parent as a `Heading:` body line rather than starting a sibling — so a
 * nested heading's rules stay attached to the section that owns them.
 *
 * Content before the first `## ` is dropped. In both consumers that region is
 * the title and provenance preamble, never rules.
 */
export function splitMarkdownSections(markdown: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];

  let heading: string | undefined;
  let lines: string[] = [];

  const flush = (): void => {
    if (heading !== undefined) sections.push({ heading, lines });
    heading = undefined;
    lines = [];
  };

  for (const line of markdown.split("\n")) {
    if (!/^#{1,6}\s/.test(line)) {
      if (heading !== undefined) lines.push(line);
      continue;
    }

    const text = line.replace(/^#{1,6}\s+/, "").trim();

    if (/^#\s/.test(line)) {
      flush();
      continue;
    }

    if (/^##\s/.test(line)) {
      flush();
      heading = text;
      continue;
    }

    if (heading !== undefined) lines.push(`${text}:`);
  }

  flush();
  return sections;
}
