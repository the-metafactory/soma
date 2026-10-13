/**
 * Test preload (bunfig.toml `[test] preload`): no test inherits the run
 * ledger's bus environment from the developer's shell. With these unset the
 * funnel in src/run-ledger.ts builds and publishes nothing, so a test that
 * completes a run cannot reach the real bus (node #820). Tests that need the
 * ledger on inject their own env.
 */
const RUN_LEDGER_ENV_VARS = [
  "SOMA_PRINCIPAL",
  "SOMA_STACK",
  "SOMA_NATS_URL",
  "SOMA_NATS_CREDS",
  "MF_CORRELATION_ID",
  "MF_SERVES_GOAL",
  "MF_SERVES_NODE",
] as const;

for (const name of RUN_LEDGER_ENV_VARS) {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the names are a fixed list
  delete process.env[name];
}

export {};
