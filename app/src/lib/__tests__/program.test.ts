import { describe, expect, it } from "vitest";

import { isLocalUrl } from "../program";

describe("isLocalUrl", () => {
  it("is true for local validator URLs", () => {
    expect(isLocalUrl("http://127.0.0.1:8899")).toBe(true);
    expect(isLocalUrl("http://localhost:8899")).toBe(true);
  });
  it("is false for devnet / mainnet URLs", () => {
    expect(isLocalUrl("https://api.devnet.solana.com")).toBe(false);
    expect(isLocalUrl("https://api.mainnet-beta.solana.com")).toBe(false);
  });
});
