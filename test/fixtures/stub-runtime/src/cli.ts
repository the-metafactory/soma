// Stub runtime entry (test fixture, node #914). Answers the staging load
// check's `--version` and refuses everything else, so nothing mistakes it for
// the real soma CLI.
if (process.argv.includes("--version")) {
  console.log("soma 0.0.0-stub");
} else {
  console.error("soma stub runtime (test fixture): stage the real source to run soma commands");
  process.exit(1);
}
