import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  shouldCheckSomaPolicyTarget,
  somaPolicyActionForToolAction,
} from "../src/policy-targets";
import { extractCodexPolicyTargets } from "../src/adapters/codex/policy-targets";
import { extractToolCallPolicyTargets } from "../src/adapters/pi-dev/extensions/policy-targets";

const privateHome = "/home/me/." + "soma";
const privateTilde = "~/" + ".soma";

test("extractToolCallPolicyTargets normalizes pi.dev write events", () => {
  const extraction = extractToolCallPolicyTargets(
    {
      toolName: "write",
      input: {
        file_path: "public.md",
        source_path: `${privateTilde}/profile/private.md`,
        content: "summary",
      },
    },
    { cwd: "/workspace", maxTargets: 16 },
  );

  expect(extraction.blockReason).toBeUndefined();
  expect(extraction.action).toBe("write");
  expect(somaPolicyActionForToolAction(extraction.action)).toBe("write");
  expect(extraction.targets).toEqual([
    {
      filePath: "public.md",
      sourcePath: `${privateTilde}/profile/private.md`,
      content: "summary",
    },
  ]);
});

test("extractToolCallPolicyTargets allows read-only shell calls without targets", () => {
  const extraction = extractToolCallPolicyTargets(
    {
      toolName: "bash",
      input: { command: "git status --short" },
    },
    { cwd: "/workspace", maxTargets: 16 },
  );

  expect(extraction.action).toBe("read");
  expect(extraction.targets).toEqual([]);
  expect(extraction.blockReason).toBeUndefined();
});

test("extractToolCallPolicyTargets blocks mutating tool calls without destinations", () => {
  const extraction = extractToolCallPolicyTargets(
    {
      toolName: "write",
      input: { content: "missing destination" },
    },
    { cwd: "/workspace", maxTargets: 16 },
  );

  expect(extraction.action).toBe("write");
  expect(extraction.targets).toEqual([]);
  expect(extraction.blockReason).toContain("without a parseable destination");
});

test("extractToolCallPolicyTargets extracts shell destructive targets", () => {
  const extraction = extractToolCallPolicyTargets(
    {
      toolName: "bash",
      input: { command: `rm -rf ${privateTilde}/profile` },
    },
    { cwd: "/workspace", maxTargets: 16 },
  );

  expect(extraction.action).toBe("delete");
  expect(extraction.targets).toEqual([
    {
      filePath: join(process.env.HOME ?? "", ".soma/profile"),
      sourcePath: undefined,
      content: `rm -rf ${privateTilde}/profile`,
    },
  ]);
});

test("extractCodexPolicyTargets preserves Codex private shell transfer detection", () => {
  const config = {
    somaHome: privateHome,
    policyMarkers: [`${privateHome}/profile`, `${privateTilde}/profile`],
  };

  const targets = extractCodexPolicyTargets(config, {
    tool_name: "Bash",
    cwd: "/repo",
    tool_input: {
      command: `cat ${privateTilde}/profile/private.md > public.md`,
    },
  });

  expect(targets).toEqual([
    {
      action: "write",
      filePath: "/repo/public.md",
      sourcePath: `${privateHome}/profile/private.md`,
    },
  ]);
  expect(shouldCheckSomaPolicyTarget(config, targets[0])).toBe(true);
});

test("extractCodexPolicyTargets flags protected mv sources", () => {
  const config = {
    somaHome: privateHome,
    policyMarkers: [`${privateHome}/profile`, ".codex/memories/soma"],
  };

  const targets = extractCodexPolicyTargets(config, {
    tool_name: "Bash",
    cwd: "/repo",
    tool_input: {
      command: "mv .codex/memories/soma/private.md public.md",
    },
  });

  expect(targets).toEqual([
    {
      action: "modify",
      filePath: "/repo/.codex/memories/soma/private.md",
    },
    {
      action: "modify",
      filePath: "/repo/public.md",
      sourcePath: "/repo/.codex/memories/soma/private.md",
    },
  ]);
  expect(targets.map((target) => shouldCheckSomaPolicyTarget(config, target))).toEqual([true, true]);
});

test("extractCodexPolicyTargets flags direct protected find-delete roots", () => {
  const config = {
    somaHome: privateHome,
    policyMarkers: [`${privateHome}/profile`, `${privateTilde}/profile`],
  };

  const targets = extractCodexPolicyTargets(config, {
    tool_name: "Bash",
    cwd: "/repo",
    tool_input: {
      command: `find ${privateTilde}/profile -delete`,
    },
  });

  expect(targets).toEqual([
    {
      action: "delete",
      filePath: `${privateHome}/profile`,
    },
  ]);
  expect(shouldCheckSomaPolicyTarget(config, targets[0])).toBe(true);
});

test("extractCodexPolicyTargets carries private sources through pipelines", () => {
  const config = {
    somaHome: privateHome,
    policyMarkers: [`${privateHome}/profile`, `${privateTilde}/profile`],
  };

  const targets = extractCodexPolicyTargets(config, {
    tool_name: "Bash",
    cwd: "/repo",
    tool_input: {
      command: `cat ${privateTilde}/profile/private.md | grep token | tee public.md`,
    },
  });

  expect(targets).toEqual([
    {
      action: "write",
      filePath: "/repo/public.md",
      sourcePath: `${privateHome}/profile/private.md`,
    },
  ]);
  expect(shouldCheckSomaPolicyTarget(config, targets[0])).toBe(true);
});

test("extractCodexPolicyTargets extracts apply_patch deletes and private marker additions", () => {
  const config = {
    somaHome: privateHome,
    policyMarkers: [`${privateHome}/memory`, `${privateTilde}/memory`],
  };

  const privateMemoryPath = `${privateHome}/memory/private.md`;
  const targets = extractCodexPolicyTargets(config, {
    tool_name: "apply_patch",
    cwd: "/repo",
    tool_input: {
      patch: [
        "*** Begin Patch",
        "*** Delete File: old.md",
        "*** Add File: notes.md",
        `+Source: ${privateMemoryPath}`,
        "*** End Patch",
      ].join("\n"),
    },
  });

  expect(targets).toEqual([
    {
      action: "delete",
      filePath: "/repo/old.md",
      sourcePath: undefined,
      content: "",
    },
    {
      action: "write",
      filePath: "/repo/notes.md",
      sourcePath: undefined,
      content: `Source: ${privateMemoryPath}`,
    },
  ]);
  expect(targets.map((target) => shouldCheckSomaPolicyTarget(config, target))).toEqual([true, true]);
});
