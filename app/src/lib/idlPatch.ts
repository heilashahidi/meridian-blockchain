import rawIdl from "./idl/meridian.json";
import type { Meridian } from "./idl/meridian";

/**
 * The Meridian program deliberately keeps its matching-engine types
 * (`OrderKey`, `OrderEntry`, `BookSide`) out of the generated IDL — they
 * implement `IdlBuild` as empty stubs ("internal plumbing"). But the `Book`
 * account references `BookSide<32>`, so Anchor's `new Program(idl)` throws
 * `Type not found: bids` and can't construct at all — which would break every
 * read, not just the book.
 *
 * We patch the IDL **in memory** here (the committed `meridian.json` stays
 * pristine, so re-copying it from `target/idl/` after a program change is
 * safe): add the three missing types with their exact `#[repr(C)]` layout and
 * flatten the `Book` account's generic `BookSide<32>` fields to a concrete
 * `BookSide32` type Anchor can decode.
 *
 * Layout (must match `programs/meridian/src/matching/{book_side,order_key}.rs`):
 *   OrderKey  = { price: u64, seq: u64 }                       // 16 bytes
 *   OrderEntry= { key: OrderKey, owner: [u8;32], qty: u64 }    // 56 bytes
 *   BookSide32= { len: u64, entries: [OrderEntry; 32] }        // 1800 bytes
 */
function patchIdl(src: typeof rawIdl): typeof rawIdl {
  const idl = JSON.parse(JSON.stringify(src));
  const has = (n: string) => idl.types.some((t: { name: string }) => t.name === n);

  if (!has("OrderKey")) {
    idl.types.push({
      name: "OrderKey",
      type: {
        kind: "struct",
        fields: [
          { name: "price", type: "u64" },
          { name: "seq", type: "u64" },
        ],
      },
    });
  }
  if (!has("OrderEntry")) {
    idl.types.push({
      name: "OrderEntry",
      type: {
        kind: "struct",
        fields: [
          { name: "key", type: { defined: { name: "OrderKey" } } },
          { name: "owner", type: { array: ["u8", 32] } },
          { name: "qty", type: "u64" },
        ],
      },
    });
  }
  if (!has("BookSide32")) {
    idl.types.push({
      name: "BookSide32",
      type: {
        kind: "struct",
        fields: [
          { name: "len", type: "u64" },
          {
            name: "entries",
            type: { array: [{ defined: { name: "OrderEntry" } }, 32] },
          },
        ],
      },
    });
  }

  const book = idl.types.find((t: { name: string }) => t.name === "Book");
  if (book) {
    for (const f of book.type.fields) {
      if (f.name === "bids" || f.name === "asks") {
        f.type = { defined: { name: "BookSide32" } };
      }
    }
  }
  return idl;
}

/** Patched IDL used for the runtime Anchor client. */
export const meridianIdl = patchIdl(rawIdl) as Meridian;
