import { describe, expect, it } from "vitest";

import { parseArgs } from "../src/index.js";

describe("cli: parseArgs", () => {
  it("recognizes both subcommands", () => {
    expect(parseArgs(["node", "index", "create-strikes"]).command).toBe(
      "create-strikes",
    );
    expect(parseArgs(["node", "index", "settle"]).command).toBe("settle");
  });

  it("recognizes the help flag", () => {
    expect(parseArgs(["node", "index", "--help"]).help).toBe(true);
    expect(parseArgs(["node", "index", "-h"]).help).toBe(true);
  });

  it("flags an unknown command", () => {
    const r = parseArgs(["node", "index", "frobnicate"]);
    expect(r.command).toBeNull();
    expect(r.unknown).toBe("frobnicate");
  });

  it("ignores job-specific flags after a command", () => {
    const r = parseArgs(["node", "index", "create-strikes", "--dry-run"]);
    expect(r.command).toBe("create-strikes");
  });
});
