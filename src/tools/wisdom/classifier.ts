import { join } from "node:path";
import { readAllWisdomFrames, readWisdomFrame } from "./frame";
import { pathsForWisdomOptions, safeDomain } from "./paths";
import type { DomainClassification, WisdomFrame, WisdomToolOptions } from "./types";

const DEFAULT_DOMAIN_KEYWORDS: Record<string, { primary: string[]; secondary: string[] }> = {
  communication: {
    primary: ["discord", "message", "channel", "thread", "notification"],
    secondary: ["team", "update", "post", "announce"],
  },
  development: {
    primary: ["code", "test", "build", "deploy", "feature", "bug", "pr"],
    secondary: ["refactor", "lint", "type", "ci", "review", "structure"],
  },
  deployment: {
    primary: ["wrangler", "cloudflare", "pages", "worker", "dns"],
    secondary: ["domain", "route", "certificate", "deploy"],
  },
  "content-creation": {
    primary: ["write", "article", "blog", "documentation", "slides"],
    secondary: ["draft", "edit", "publish", "media"],
  },
  "system-architecture": {
    primary: ["architecture", "layer", "stack", "migration", "bus"],
    secondary: ["nats", "myelin", "cortex", "surface"],
  },
};

function words(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) ?? [])];
}

function scoreKeywords(textWords: Set<string>, keywords: { primary: string[]; secondary: string[] }): { score: number; matches: string[] } {
  const matches: string[] = [];
  let score = 0;
  for (const keyword of keywords.primary) {
    if (textWords.has(keyword.toLowerCase())) {
      score += 2;
      matches.push(keyword);
    }
  }
  for (const keyword of keywords.secondary) {
    if (textWords.has(keyword.toLowerCase())) {
      score += 1;
      matches.push(keyword);
    }
  }
  return { score, matches };
}

function frameKeywords(frameContent: string): { primary: string[]; secondary: string[] } {
  const ranked = words(frameContent).filter((word) => word.length >= 4 && !["wisdom", "frame", "recorded", "observation", "count", "type"].includes(word));
  return { primary: ranked.slice(0, 12), secondary: ranked.slice(12, 30) };
}

async function keywordMaps(options: WisdomToolOptions): Promise<Record<string, { primary: string[]; secondary: string[]; path: string }>> {
  const maps: Record<string, { primary: string[]; secondary: string[]; path: string }> = {};
  const framesDir = join(pathsForWisdomOptions(options).wisdom(), "FRAMES");
  for (const [domain, keywords] of Object.entries(DEFAULT_DOMAIN_KEYWORDS)) {
    maps[domain] = { ...keywords, path: join(framesDir, `${domain}.md`) };
  }
  for (const frame of await readAllWisdomFrames(options)) {
    const dynamic = frameKeywords(frame.content);
    const existing = maps[frame.domain] as { primary: string[]; secondary: string[]; path: string } | undefined;
    maps[frame.domain] = {
      primary: [...new Set([...(existing?.primary ?? []), ...dynamic.primary])],
      secondary: [...new Set([...(existing?.secondary ?? []), ...dynamic.secondary])],
      path: frame.path,
    };
  }
  return maps;
}

export async function classifyDomains(text: string, options: WisdomToolOptions = {}): Promise<DomainClassification[]> {
  if (!text.trim()) throw new Error("Wisdom classification text is required.");
  const inputWords = new Set(words(text));
  const maps = await keywordMaps(options);
  const results = Object.entries(maps).map(([domain, keywords]) => {
    const scored = scoreKeywords(inputWords, keywords);
    return {
      domain,
      path: keywords.path,
      relevance: Math.min(1, scored.score / (scored.score + 1)),
      matches: scored.matches,
    };
  }).filter((result) => result.relevance > 0);

  return results.sort((a, b) => b.relevance - a.relevance || a.domain.localeCompare(b.domain));
}

export async function loadRelevantFrames(text: string, options: WisdomToolOptions = {}): Promise<WisdomFrame[]> {
  const classifications = await classifyDomains(text, options);
  const frames: WisdomFrame[] = [];
  for (const classification of classifications) {
    const frame = await readWisdomFrame(safeDomain(classification.domain), options);
    if (frame) frames.push(frame);
  }
  return frames;
}
