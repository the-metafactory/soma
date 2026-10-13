/**
 * The run ledger's bus environment (node #820): the one list of variable
 * names. `src/run-ledger.ts` reads them, and the test preload clears them.
 * Side-effect free, so importing it never changes `process.env`.
 */
export const RUN_LEDGER_ENV = {
  principal: "SOMA_PRINCIPAL",
  stack: "SOMA_STACK",
  natsUrl: "SOMA_NATS_URL",
  natsCreds: "SOMA_NATS_CREDS",
  correlationId: "MF_CORRELATION_ID",
  servesGoal: "MF_SERVES_GOAL",
  servesNode: "MF_SERVES_NODE",
} as const;

export const RUN_LEDGER_ENV_VARS: readonly string[] = Object.values(RUN_LEDGER_ENV);
