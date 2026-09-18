import { expect, test } from "bun:test";
import { WorkGraphError } from "../src/work-graph";
import {
  displayRepo,
  formatQualifiedNodeRef,
  formatRepoRef,
  isQualifiedRef,
  parseBareNodeNumber,
  parseLocatedNodeId,
  parseQualifiedNodeRef,
  parseRemoteUrl,
  parseRepoRef,
  sameStore,
  storeNodeId,
  type RepoRef,
} from "../src/work-graph-ref";

const SOMA: RepoRef = { forge: "github", host: "github.com", path: "the-metafactory/soma" };
const REPORTER: RepoRef = { forge: "gitlab", host: "gitlab-int.switch.ch", path: "csoc/soc-reporter" };

// --- repo refs (#536 D1) ------------------------------------------------------

test("a qualified repo ref names forge, host and path, and prints back the same", () => {
  expect(parseRepoRef("github:github.com/the-metafactory/soma")).toEqual(SOMA);
  expect(parseRepoRef("gitlab:gitlab-int.switch.ch/csoc/soc-reporter")).toEqual(REPORTER);
  expect(parseRepoRef("gitlab:gitlab-int.switch.ch/csoc/team/sub/project").path).toBe("csoc/team/sub/project");
  expect(formatRepoRef(REPORTER)).toBe("gitlab:gitlab-int.switch.ch/csoc/soc-reporter");
  expect(parseRepoRef(formatRepoRef(SOMA))).toEqual(SOMA);
});

test("the host is case-folded, the path is kept as written", () => {
  expect(parseRepoRef("github:GitHub.com/The-Metafactory/soma")).toEqual({
    forge: "github",
    host: "github.com",
    path: "The-Metafactory/soma",
  });
});

test("a ref with no forge word is not qualified, and parseRepoRef refuses it rather than guessing", () => {
  expect(isQualifiedRef("the-metafactory/soma")).toBe(false);
  expect(isQualifiedRef("539")).toBe(false);
  expect(isQualifiedRef("gitlab:gitlab.example.com/a/b")).toBe(true);
  expect(() => parseRepoRef("the-metafactory/soma")).toThrow(WorkGraphError);
  expect(() => parseRepoRef("github.com/the-metafactory/soma")).toThrow(/names no forge/);
  expect(() => parseRepoRef("bitbucket:bitbucket.org/a/b")).toThrow(/names no forge/);
});

test("malformed hosts and paths refuse", () => {
  expect(() => parseRepoRef("github:github.com")).toThrow(/no host\/path/);
  expect(() => parseRepoRef("gitlab:bad_host/a/b")).toThrow(/not a hostname/);
  expect(() => parseRepoRef("gitlab:gitlab.example.com/a//b")).toThrow(/malformed segment/);
  expect(() => parseRepoRef("gitlab:gitlab.example.com/a/../b")).toThrow(/malformed segment/);
  expect(() => parseRepoRef("gitlab:gitlab.example.com/a/./b")).toThrow(/malformed segment/);
  // A leading dot is a real name (`.github`), not traversal.
  expect(parseRepoRef("github:github.com/the-metafactory/.github").path).toBe("the-metafactory/.github");
});

test("a GitHub path is exactly owner/name; a GitLab namespace nests", () => {
  expect(() => parseRepoRef("github:github.com/the-metafactory")).toThrow(/owner\/name/);
  expect(() => parseRepoRef("github:github.com/a/b/c")).toThrow(/owner\/name/);
  expect(parseRepoRef("gitlab:gitlab-int.switch.ch/csoc").path).toBe("csoc");
});

// --- node refs ------------------------------------------------------------------

test("issue, task and epic refs carry their location", () => {
  expect(parseQualifiedNodeRef("github:github.com/the-metafactory/soma#536")).toEqual({ repo: SOMA, sigil: "#", iid: 536 });
  expect(parseQualifiedNodeRef("gitlab:gitlab-int.switch.ch/csoc/soc-reporter#12")).toEqual({
    repo: REPORTER,
    sigil: "#",
    iid: 12,
  });
  const epic = parseQualifiedNodeRef("gitlab:gitlab-int.switch.ch/csoc&5");
  expect(epic).toEqual({ repo: { forge: "gitlab", host: "gitlab-int.switch.ch", path: "csoc" }, sigil: "&", iid: 5 });
  expect(formatQualifiedNodeRef(epic)).toBe("gitlab:gitlab-int.switch.ch/csoc&5");
});

test("only GitLab has epics, and a node ref must end in a positive number", () => {
  expect(() => parseQualifiedNodeRef("github:github.com/the-metafactory/soma&5")).toThrow(/only GitLab has epics/);
  expect(() => parseQualifiedNodeRef("github:github.com/the-metafactory/soma")).toThrow(/ends in #<number>/);
  expect(() => parseQualifiedNodeRef("github:github.com/the-metafactory/soma#0")).toThrow(/ends in #<number>/);
});

test("a GitHub store id stays the bare number; a GitLab id keeps its path, since iids repeat across projects", () => {
  expect(storeNodeId(parseQualifiedNodeRef("github:github.com/the-metafactory/soma#536"))).toBe("536");
  expect(storeNodeId(parseQualifiedNodeRef("gitlab:gitlab-int.switch.ch/csoc/soc-reporter#12"))).toBe("csoc/soc-reporter#12");
  expect(storeNodeId(parseQualifiedNodeRef("gitlab:gitlab-int.switch.ch/csoc&5"))).toBe("csoc&5");
});

test("a GitHub store is one repo; a GitLab store is one host", () => {
  expect(sameStore(SOMA, { ...SOMA, path: "The-Metafactory/Soma" })).toBe(true);
  expect(sameStore(SOMA, { ...SOMA, path: "the-metafactory/arc" })).toBe(false);
  expect(sameStore(REPORTER, { ...REPORTER, path: "csoc" })).toBe(true);
  expect(sameStore(REPORTER, { ...REPORTER, host: "gitlab.com" })).toBe(false);
  // Same host and path on two forges are two stores — the collision #536 is about.
  expect(sameStore({ ...REPORTER, forge: "github", path: "csoc/reporter" }, { ...REPORTER, path: "csoc/reporter" })).toBe(false);
});

test("github.com repos display as owner/name, as before; everything else displays qualified", () => {
  expect(displayRepo(SOMA)).toBe("the-metafactory/soma");
  expect(displayRepo({ ...SOMA, host: "ghe.example.com" })).toBe("github:ghe.example.com/the-metafactory/soma");
  expect(displayRepo(REPORTER)).toBe("gitlab:gitlab-int.switch.ch/csoc/soc-reporter");
});

// --- remotes ----------------------------------------------------------------------

test("every remote shape yields host and full path", () => {
  const soma = { host: "github.com", path: "the-metafactory/soma" };
  expect(parseRemoteUrl("git@github.com:the-metafactory/soma.git")).toEqual(soma);
  expect(parseRemoteUrl("https://github.com/the-metafactory/soma.git")).toEqual(soma);
  expect(parseRemoteUrl("https://github.com/the-metafactory/soma")).toEqual(soma);
  expect(parseRemoteUrl("https://github.com/the-metafactory/soma/\n")).toEqual(soma);

  const reporter = { host: "gitlab-int.switch.ch", path: "csoc/soc-reporter" };
  expect(parseRemoteUrl("git@gitlab-int.switch.ch:csoc/soc-reporter.git")).toEqual(reporter);
  expect(parseRemoteUrl("ssh://git@gitlab-int.switch.ch:2222/csoc/soc-reporter.git")).toEqual(reporter);
  expect(parseRemoteUrl("https://gitlab-int.switch.ch/csoc/team/soc-reporter.git")).toEqual({
    host: "gitlab-int.switch.ch",
    path: "csoc/team/soc-reporter",
  });
});

test("credentials in an https remote never come out", () => {
  const parsed = parseRemoteUrl("https://oauth2:glpat-secret@gitlab.example.com/a/b.git");
  expect(parsed).toEqual({ host: "gitlab.example.com", path: "a/b" });
  expect(JSON.stringify(parsed)).not.toContain("glpat");
});

test("local paths, drives and one-segment paths are not remotes", () => {
  expect(parseRemoteUrl("")).toBeUndefined();
  expect(parseRemoteUrl("/srv/git/soma.git")).toBeUndefined();
  expect(parseRemoteUrl("../soma")).toBeUndefined();
  expect(parseRemoteUrl("C:/repos/soma")).toBeUndefined();
  expect(parseRemoteUrl("file:///srv/git/a/b.git")).toBeUndefined();
  expect(parseRemoteUrl("git@github.com:soma.git")).toBeUndefined();
  expect(parseRemoteUrl("https://github.com/a/../b")).toBeUndefined();
});

test("a malformed %-escape is not a remote — undefined, never a thrown URIError", () => {
  expect(parseRemoteUrl("https://gitlab.example.com/a%zz/b.git")).toBeUndefined();
});

test("one grammar for node numbers: bare and located ids", () => {
  expect(parseBareNodeNumber("12")).toBe(12);
  expect(parseBareNodeNumber(" #12 ")).toBe(12);
  expect(parseBareNodeNumber("012")).toBeUndefined();
  expect(parseBareNodeNumber("root")).toBeUndefined();
  expect(parseLocatedNodeId("csoc/soc-reporter#12")).toEqual({ path: "csoc/soc-reporter", sigil: "#", iid: 12 });
  expect(parseLocatedNodeId("csoc&5")).toEqual({ path: "csoc", sigil: "&", iid: 5 });
  expect(parseLocatedNodeId("#12")).toBeUndefined();
});
