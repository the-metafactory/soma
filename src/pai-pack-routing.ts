import type { PaiPackImportFile } from "./types";

export type PaiPackRenderMode = "copy" | "skill" | "skill-body" | "manifest" | "archive-manifest";
export type PaiPackRouteRoot = "skill" | "archive";

export interface PaiPackRoute {
  classification: PaiPackImportFile["classification"];
  root: PaiPackRouteRoot;
  relativePath: string;
  renderMode: Extract<PaiPackRenderMode, "copy" | "skill" | "skill-body">;
}

const SOURCE_DOC_TARGETS: Record<string, string> = {
  "README.md": "PAI-PACK-README.md",
  "INSTALL.md": "PAI-PACK-INSTALL.md",
  "VERIFY.md": "PAI-PACK-VERIFY.md",
};

const TEMPLATE_PREFIXES = ["src/DashboardTemplate/", "src/ReportTemplate/"];
const PORTABLE_PREFIXES = ["src/Workflows/", "src/Tools/"];

function stripSrcPrefix(path: string): string {
  return path.slice("src/".length);
}

export function routePaiPackSourceFile(path: string): PaiPackRoute {
  const sourceDocTarget = SOURCE_DOC_TARGETS[path];
  if (sourceDocTarget) {
    return {
      classification: "source-doc",
      root: "skill",
      relativePath: `references/${sourceDocTarget}`,
      renderMode: "copy",
    };
  }

  if (TEMPLATE_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return {
      classification: "template",
      root: "skill",
      relativePath: stripSrcPrefix(path),
      renderMode: "copy",
    };
  }

  if (path === "src/SKILL.md" || PORTABLE_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    let renderMode: Extract<PaiPackRenderMode, "copy" | "skill" | "skill-body">;
    if (path === "src/SKILL.md") {
      // Entry file: normalize body AND rewrite frontmatter to Soma skill identity.
      renderMode = "skill";
    } else if (path.endsWith(".md")) {
      // Workflows/Tools markdown: normalize body ONLY. Preserve original
      // frontmatter — it isn't the skill entrypoint so it shouldn't
      // receive the root skill's name/description.
      renderMode = "skill-body";
    } else {
      renderMode = "copy";
    }
    return {
      classification: "portable",
      root: "skill",
      relativePath: stripSrcPrefix(path),
      renderMode,
    };
  }

  return {
    classification: "substrate-specific",
    root: "archive",
    relativePath: `source/${path}`,
    renderMode: "copy",
  };
}
