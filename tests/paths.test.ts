import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAgentRoot } from "../src/paths.js";

describe("agent root path resolution", () => {
  it("prefers PI_CODING_AGENT_DIR over the default ~/.omp/agent root", () => {
    const root = resolveAgentRoot({ PI_CODING_AGENT_DIR: "/tmp/omp-agent-dir" });

    assert.strictEqual(root, path.resolve("/tmp/omp-agent-dir"));
  });

  it("falls back to ~/.omp/agent when PI_CODING_AGENT_DIR is unset or blank", () => {
    const expected = path.join(os.homedir(), ".omp", "agent");

    assert.strictEqual(resolveAgentRoot({}), expected);
    assert.strictEqual(resolveAgentRoot({ PI_CODING_AGENT_DIR: "  " }), expected);
  });

  it("honors PI_CONFIG_DIR for the config dir name when PI_CODING_AGENT_DIR is unset", () => {
    const root = resolveAgentRoot({ PI_CONFIG_DIR: ".omp-test" });

    assert.strictEqual(root, path.join(os.homedir(), ".omp-test", "agent"));
  });

  it("PI_CODING_AGENT_DIR wins over PI_CONFIG_DIR", () => {
    const root = resolveAgentRoot({
      PI_CODING_AGENT_DIR: "/tmp/omp-agent-dir",
      PI_CONFIG_DIR: ".omp-test",
    });

    assert.strictEqual(root, path.resolve("/tmp/omp-agent-dir"));
  });

  it("expands home-relative PI_CODING_AGENT_DIR values", () => {
    const root = resolveAgentRoot({ PI_CODING_AGENT_DIR: "~/custom-omp-agent" });

    assert.strictEqual(root, path.join(os.homedir(), "custom-omp-agent"));
  });
});
