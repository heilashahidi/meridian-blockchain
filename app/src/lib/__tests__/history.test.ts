import { describe, expect, it } from "vitest";

import {
  base58ToBytes,
  parseHistoryEntry,
  parseInstruction,
  type RawProgramIx,
} from "@/lib/history";
import { PROGRAM_ID } from "@/lib/program";

const PID = PROGRAM_ID.toBase58();

// Local base58 encoder (inverse of the module's `base58ToBytes`) so the test
// needs no extra dependency and exercises the real decoder on its own output.
const B58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58encode(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let k = 0; k < bytes.length && bytes[k] === 0; k++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out;
}
const bs58 = { encode: b58encode };

// Anchor 8-byte discriminators (must match src/lib/idl/meridian.json).
const DISC = {
  mint_pair: [19, 149, 94, 110, 181, 186, 33, 107],
  burn_pair: [145, 2, 176, 194, 32, 205, 57, 214],
  place_limit_order: [108, 176, 33, 186, 146, 229, 1, 197],
  place_market_order: [90, 118, 192, 252, 192, 99, 39, 145],
  buy_no: [89, 240, 244, 16, 196, 201, 190, 163],
  sell_no: [189, 194, 132, 42, 80, 249, 154, 103],
  cancel_order: [95, 129, 237, 240, 8, 49, 223, 132],
  redeem: [184, 12, 86, 149, 70, 196, 97, 225],
  settle_market: [193, 153, 95, 216, 166, 6, 144, 217],
} as const;

/** Build base58 instruction data: discriminator + (optional) trailing arg bytes. */
function ixData(disc: readonly number[], trailing: number[] = []): string {
  return bs58.encode(Uint8Array.from([...disc, ...trailing]));
}

describe("base58ToBytes", () => {
  it("round-trips against bs58.encode", () => {
    const bytes = Uint8Array.from([0, 0, 1, 255, 13, 200, 7]);
    expect([...base58ToBytes(bs58.encode(bytes))]).toEqual([...bytes]);
  });

  it("returns empty for a non-base58 string", () => {
    expect(base58ToBytes("0OIl")).toHaveLength(0); // 0,O,I,l not in alphabet
  });
});

describe("parseInstruction", () => {
  it("classifies each known discriminator", () => {
    expect(parseInstruction(Uint8Array.from(DISC.mint_pair))).toEqual({
      name: "mint_pair",
      action: "mint",
    });
    expect(parseInstruction(Uint8Array.from(DISC.place_limit_order))).toEqual({
      name: "place_limit_order",
      action: "trade",
    });
    expect(parseInstruction(Uint8Array.from(DISC.burn_pair))).toEqual({
      name: "burn_pair",
      action: "burn",
    });
    expect(parseInstruction(Uint8Array.from(DISC.place_market_order))).toEqual({
      name: "place_market_order",
      action: "trade",
    });
    expect(parseInstruction(Uint8Array.from(DISC.buy_no))?.action).toBe(
      "trade",
    );
    expect(parseInstruction(Uint8Array.from(DISC.sell_no))?.action).toBe(
      "trade",
    );
    expect(parseInstruction(Uint8Array.from(DISC.cancel_order))?.action).toBe(
      "cancel",
    );
    expect(parseInstruction(Uint8Array.from(DISC.redeem))?.action).toBe(
      "redeem",
    );
    expect(parseInstruction(Uint8Array.from(DISC.settle_market))?.action).toBe(
      "settle",
    );
  });

  it("ignores trailing argument bytes after the discriminator", () => {
    const withArgs = Uint8Array.from([...DISC.redeem, 1, 2, 3, 4, 5]);
    expect(parseInstruction(withArgs)?.name).toBe("redeem");
  });

  it("returns null for an unknown discriminator or short data", () => {
    expect(parseInstruction(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(parseInstruction(Uint8Array.from([1, 2, 3]))).toBeNull();
  });
});

describe("parseHistoryEntry", () => {
  const base = { signature: "sigABC", blockTime: 1_700_000_000, failed: false };

  it("parses a place_limit_order tx into a trade entry", () => {
    const instructions: RawProgramIx[] = [
      { programId: "SomeOtherProgram111111111111111111111111111" }, // e.g. compute budget
      { programId: PID, data: ixData(DISC.place_limit_order, [0, 1, 2]) },
    ];
    const entry = parseHistoryEntry({ ...base, instructions, programId: PID });
    expect(entry).not.toBeNull();
    expect(entry!.action).toBe("trade");
    expect(entry!.instruction).toBe("place_limit_order");
    expect(entry!.signature).toBe("sigABC");
    expect(entry!.failed).toBe(false);
  });

  it("parses mint / cancel / redeem", () => {
    const mk = (disc: readonly number[]) =>
      parseHistoryEntry({
        ...base,
        instructions: [{ programId: PID, data: ixData(disc) }],
        programId: PID,
      });
    expect(mk(DISC.mint_pair)!.action).toBe("mint");
    expect(mk(DISC.cancel_order)!.action).toBe("cancel");
    expect(mk(DISC.redeem)!.action).toBe("redeem");
  });

  it("returns null when no instruction targets the program", () => {
    const entry = parseHistoryEntry({
      ...base,
      instructions: [{ programId: "OtherProg1111111111111111111111111111111111" }],
      programId: PID,
    });
    expect(entry).toBeNull();
  });

  it("flags a failed tx", () => {
    const entry = parseHistoryEntry({
      ...base,
      failed: true,
      instructions: [{ programId: PID, data: ixData(DISC.buy_no) }],
      programId: PID,
    });
    expect(entry!.failed).toBe(true);
    expect(entry!.action).toBe("trade");
  });

  it("classifies a Meridian instruction with no data field as unknown", () => {
    const entry = parseHistoryEntry({
      ...base,
      instructions: [{ programId: PID }], // a Meridian ix, but no decodable data
      programId: PID,
    });
    expect(entry).not.toBeNull();
    expect(entry!.action).toBe("unknown");
    expect(entry!.instruction).toBe("unknown");
  });

  it("classifies an unrecognized Meridian discriminator as unknown", () => {
    const entry = parseHistoryEntry({
      ...base,
      instructions: [{ programId: PID, data: ixData([9, 9, 9, 9, 9, 9, 9, 9]) }],
      programId: PID,
    });
    expect(entry!.action).toBe("unknown");
    expect(entry!.instruction).toBe("unknown");
  });
});
