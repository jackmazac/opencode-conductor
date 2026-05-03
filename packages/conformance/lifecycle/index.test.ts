import { describe, expect, test } from "bun:test";
import {
  blockDecisionFixture,
  concordCollisionFixture,
  concordGuidanceFixture,
  allowDecisionFixture,
  staleBlockDecisionInput,
  warnDecisionFixture,
} from "./index.ts";
import { lifecycleDecisionSchema } from "../../lifecycle-contracts/src/decisions.ts";
import { renderLifecycleDecisionMessage } from "../../lifecycle-contracts/src/messages.ts";

describe("lifecycle conformance fixtures", () => {
  test("allow, warn, and block fixtures are fresh current decisions", () => {
    for (const fixture of [allowDecisionFixture, warnDecisionFixture, blockDecisionFixture]) {
      expect(lifecycleDecisionSchema.parse(fixture).freshness.status).toBe("fresh");
    }
  });

  test("stale decisions are rejected by the current-decision schema", () => {
    expect(lifecycleDecisionSchema.safeParse(staleBlockDecisionInput).success).toBe(false);
  });

  test("block decisions render to structured agent messages", () => {
    const message = renderLifecycleDecisionMessage(blockDecisionFixture);
    expect(message.severity).toBe("block");
    expect(message.violated_rule).toBe("origin.no-direct-generated-edit");
    expect(message.remediation.commands).toContain("bun run generate:api");
  });

  test("Concord collisions are external evidence, not lifecycle decisions", () => {
    expect(concordCollisionFixture.source).toBe("concord");
    expect(concordCollisionFixture.file_path).toBe("src/generated/client.ts");
    expect(concordGuidanceFixture.format).toBe("concord_conflict_xml");
  });
});
