import type { SomaContextInput } from "../src/index";

export const portableContextInput: SomaContextInput = {
  profile: {
    assistant: {
      name: "soma",
      displayName: "Soma",
      traits: {
        concise: true,
      },
    },
    principal: {
      name: "principal",
      preferredName: "JC",
      profile: {
        timezone: "Europe/Zurich",
      },
    },
    telos: {
      mission: "Keep personal assistant context portable across substrates.",
      goals: ["Prove context generation across substrates"],
      principles: ["Substrate adapters translate; they do not own core concepts"],
      commitments: ["Keep memory filesystem-native"],
    },
    memory: {
      root: "MEMORY",
      work: "MEMORY/WORK",
      knowledge: "MEMORY/KNOWLEDGE",
      learning: "MEMORY/LEARNING",
      relationship: "MEMORY/RELATIONSHIP",
      state: "MEMORY/STATE",
    },
    skills: [
      {
        name: "Ledger Update",
        path: "skills/ledger-update",
        description: "Update a project ledger from verified work.",
        triggers: ["ledger", "status update"],
      },
    ],
  },
  activeIsa: {
    slug: "portable-context",
    phase: "build",
    goal: "Build substrate context projections from one Soma input.",
    criteria: [
      {
        id: "ISC-PORTABLE-1",
        text: "Adapters receive assistant identity, telos, memory, skills, and ISA.",
        status: "open",
        verification: "bun test",
      },
    ],
  },
};
