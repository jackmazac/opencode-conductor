import { runPluginContractTests } from "@jackmazac/opencode-host-adapter/contract-test";

runPluginContractTests({
  pluginPath: new URL("./index.ts", import.meta.url).href,
  pluginName: "conductor",
  stubInput: () => ({
    client: {},
    directory: "/tmp/opencode-conductor-contract-test",
  }),
  expectedTools: [
    "explore_fast",
    "conflict_context",
    "lifecycle_concord_ingest",
    "persist_final_plan",
    "read_final_plan",
    "discard_final_plan",
    "progress_update",
    "progress_read",
    "progress_done",
    "run_init",
    "run_update",
    "run_finish",
  ],
});
