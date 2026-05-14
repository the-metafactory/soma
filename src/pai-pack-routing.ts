import type { PaiPackImportFile } from "./types";

export type PaiPackRenderMode = "copy" | "skill" | "manifest" | "archive-manifest";
export type PaiPackRouteRoot = "skill" | "archive";

export interface PaiPackRoute {
  classification: PaiPackImportFile["classification"];
  root: PaiPackRouteRoot;
  relativePath: string;
  renderMode: Extract<PaiPackRenderMode, "copy" | "skill">;
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
    return {
      classification: "portable",
      root: "skill",
      relativePath: stripSrcPrefix(path),
      renderMode: path === "src/SKILL.md" ? "skill" : "copy",
    };
  }

  return {
    classification: "substrate-specific",
    root: "archive",
    relativePath: `source/${path}`,
    renderMode: "copy",
  };
}
