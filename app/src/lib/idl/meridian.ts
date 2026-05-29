/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/meridian.json`.
 */
export type Meridian = {
  "address": "6oe2PzNoWyLMrWHqGAj5hirRUX68z35oqBTW9T1E9mWX",
  "metadata": {
    "name": "meridian",
    "version": "0.3.0",
    "spec": "0.1.0",
    "description": "Meridian on-chain CLOB for binary outcome markets — Anchor program wrapping a pure-Rust matching engine."
  },
  "docs": [
    "U3 wired `initialize_config` and `create_strike_market`. U4 adds",
    "`mint_pair` and `burn_pair`. U5 adds `place_limit_order`,",
    "`place_market_order`, `cancel_order`. U6 adds `buy_no` and",
    "`sell_no` — the atomic single-tx Buy-No / Sell-No trade paths.",
    "U7 adds the remaining instructions (settle/redeem)."
  ],
  "instructions": [
    {
      "name": "adminForceExpireOrder",
      "docs": [
        "Admin-only: recover a permanently-stuck order's collateral to the",
        "treasury after the post-settlement recovery grace, provably only when",
        "the order's owner canonical ATA is genuinely un-receivable."
      ],
      "discriminator": [
        71,
        139,
        217,
        62,
        170,
        10,
        244,
        255
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Admin authority. Must equal `config.admin`."
          ],
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.expiry_unix",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "book",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "usdcEscrow",
          "docs": [
            "USDC escrow PDA. Source for recovered bid collateral."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesEscrow",
          "docs": [
            "Yes escrow PDA. Source for recovered ask collateral."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "ownerAta",
          "docs": [
            "mint. Read-only; validated in the handler to be the canonical ATA (the",
            "owner is taken from the book entry, never from here) AND to be currently",
            "un-receivable. Never receives funds."
          ]
        },
        {
          "name": "treasuryAta",
          "docs": [
            "recovered mint. Validated in the handler."
          ],
          "writable": true
        },
        {
          "name": "mintAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "adminForceExpireOrderArgs"
            }
          }
        }
      ]
    },
    {
      "name": "adminSettleMarket",
      "docs": [
        "Admin-only emergency settlement (P1 stuck-oracle deadlock). Stamps",
        "`yes_wins`/!`yes_wins` as the outcome WITHOUT reading Pyth, but only",
        "after `expiry + EMERGENCY_GRACE_SECONDS` (24h) so normal oracle",
        "settlement always gets first claim. Solvent by the $1 invariant."
      ],
      "discriminator": [
        120,
        28,
        6,
        83,
        85,
        98,
        56,
        94
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Admin authority. Must equal `config.admin`."
          ],
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "docs": [
            "Singleton Config — authenticates the admin. Boxed for stack hygiene",
            "(same reason as `settle_market`)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "docs": [
            "Market to force-settle. Mutated."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.expiry_unix",
                "account": "market"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "yesWins",
          "type": "bool"
        }
      ]
    },
    {
      "name": "burnPair",
      "docs": [
        "Burn `amount` Yes + `amount` No from the caller and return `amount`",
        "USDC from the per-market escrow. The symmetric inverse of `mint_pair`."
      ],
      "discriminator": [
        145,
        2,
        176,
        194,
        32,
        205,
        57,
        214
      ],
      "accounts": [
        {
          "name": "user",
          "docs": [
            "Caller — pays Yes + No, receives USDC."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "docs": [
            "Global config — read-only here; we only need the pause flag + the",
            "pinned USDC mint for the user's source/escrow constraints."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "docs": [
            "Market this burn pair belongs to. Yes/No mints and the mint-auth",
            "PDA are validated against fields on this account."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.expiry_unix",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "userUsdc",
          "docs": [
            "User's USDC ATA — receives the returned `amount` USDC."
          ],
          "writable": true
        },
        {
          "name": "usdcEscrow",
          "docs": [
            "USDC escrow PDA owned by the market's mint-authority PDA. Source of",
            "the returned USDC."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "docs": [
            "Yes mint — supply decreases by `amount`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "noMint",
          "docs": [
            "No mint — supply decreases by `amount`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "userYes",
          "docs": [
            "User's Yes ATA. Constraint requires balance ≥ amount — surfaces the",
            "shortfall as a clean Anchor error rather than letting the burn CPI",
            "fail deep in the token program."
          ],
          "writable": true
        },
        {
          "name": "userNo",
          "docs": [
            "User's No ATA. Same balance constraint as `user_yes`."
          ],
          "writable": true
        },
        {
          "name": "mintAuthority",
          "docs": [
            "the USDC escrow → user transfer."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "buyNo",
      "docs": [
        "Atomic \"Buy No\" — mint a Yes/No pair against USDC, then market-sell",
        "the Yes leg in the same tx. User ends holding `amount` No tokens",
        "+ USDC proceeds from the Yes sale. Reverts atomically if the Yes",
        "sell leg can't fill the full `amount` within `min_yes_sell_price`."
      ],
      "discriminator": [
        89,
        240,
        244,
        16,
        196,
        201,
        190,
        163
      ],
      "accounts": [
        {
          "name": "user",
          "docs": [
            "Caller. Pays USDC, ends holding No tokens."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "docs": [
            "Global config — paused flag + canonical USDC mint."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "docs": [
            "Market the trade is against. `has_one` checks pin the Yes / No",
            "mints stored on `Market` to the accounts the user passes."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.expiry_unix",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "book",
          "docs": [
            "Zero-copy `Book` account for the market. Mutated by the market-sell",
            "leg via `place_order_inner`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "usdcEscrow",
          "docs": [
            "USDC escrow PDA — receives the `amount` USDC from `mint_pair_inner`,",
            "sources the per-fill USDC payouts to makers in `place_order_inner`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesEscrow",
          "docs": [
            "Yes escrow PDA — receives the minted Yes from the taker's",
            "up-front lock in `place_order_inner`, sourced out to makers per fill."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "docs": [
            "Yes mint — `mint::authority = mint_authority`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "noMint",
          "docs": [
            "No mint — `mint::authority = mint_authority`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "userUsdc",
          "docs": [
            "User's USDC source ATA — pays the `amount` USDC for `mint_pair`."
          ],
          "writable": true
        },
        {
          "name": "userYes",
          "docs": [
            "User's Yes ATA. Receives the minted Yes (then immediately drained",
            "into the Yes escrow by the market-sell up-front lock)."
          ],
          "writable": true
        },
        {
          "name": "userNo",
          "docs": [
            "User's No ATA. Receives the minted No (the user's keepsake from",
            "this whole flow)."
          ],
          "writable": true
        },
        {
          "name": "mintAuthority",
          "docs": [
            "in both the mint_pair leg and the place_order leg."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "buyNoArgs"
            }
          }
        }
      ]
    },
    {
      "name": "cancelOrder",
      "docs": [
        "Cancel a resting order by its stable [`matching::OrderKey`] `(price,",
        "seq)`. Owner-only; refunds the escrowed collateral to the owner's",
        "ATA."
      ],
      "discriminator": [
        95,
        129,
        237,
        240,
        8,
        49,
        223,
        132
      ],
      "accounts": [
        {
          "name": "user",
          "docs": [
            "Order owner. Must equal the resting order's `owner` field."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.expiry_unix",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "book",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "usdcEscrow",
          "docs": [
            "USDC escrow PDA. Refunds Buy-side cancels."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesEscrow",
          "docs": [
            "Yes escrow PDA. Refunds Sell-side cancels."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "userUsdc",
          "docs": [
            "Owner's USDC ATA. Receives the refund on Buy-side cancels."
          ],
          "writable": true
        },
        {
          "name": "userYes",
          "docs": [
            "Owner's Yes ATA. Receives the refund on Sell-side cancels."
          ],
          "writable": true
        },
        {
          "name": "mintAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "cancelOrderArgs"
            }
          }
        }
      ]
    },
    {
      "name": "createStrikeMarket",
      "docs": [
        "Admin-only: create a strike market (Market + Book + Yes/No mints",
        "+ USDC/Yes escrows) for a `(ticker, strike, expiry)` triple."
      ],
      "discriminator": [
        21,
        162,
        50,
        119,
        68,
        218,
        221,
        35
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Admin signer. Must equal `config.admin`."
          ],
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "docs": [
            "Global config — used only to authenticate the admin. Boxed so the",
            "Config struct doesn't sit inline on the SBPF function frame",
            "alongside the SPL accounts below; growing Config (e.g. adding",
            "`pyth_receiver`) otherwise pushes try_accounts past the 4 KB cap."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "docs": [
            "Market PDA. Seed = `(ticker, strike, expiry)` so a second call for",
            "the same triple fails the PDA derivation."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "args.ticker"
              },
              {
                "kind": "arg",
                "path": "args.strike_price"
              },
              {
                "kind": "arg",
                "path": "args.expiry_unix"
              }
            ]
          }
        },
        {
          "name": "book",
          "docs": [
            "Order book PDA. Zero-copy because it carries `BookSide<32>`s.",
            "`space` is the `Book` data size plus Anchor's 8-byte discriminator."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "docs": [
            "Yes-token mint. Mint authority is the per-market PDA; freeze",
            "authority is unset (mints can't be frozen — keeps the design",
            "simple at the cost of an option we don't need for the demo)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "noMint",
          "docs": [
            "No-token mint. Same authority pattern as `yes_mint`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "mintAuthority",
          "docs": [
            "and the owner of the escrow token accounts below. No account data",
            "stored at this address — the seed + bump pair *is* the identity."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "usdcEscrow",
          "docs": [
            "USDC escrow — receives buy-side resting collateral and any",
            "mint_pair / settlement deposits. Owned by `mint_authority` PDA."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesEscrow",
          "docs": [
            "Yes-token escrow — receives sell-side resting Yes inventory.",
            "Owned by the same `mint_authority` PDA."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "docs": [
            "USDC mint — must match the one pinned in `config`."
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "createStrikeMarketArgs"
            }
          }
        }
      ]
    },
    {
      "name": "initializeConfig",
      "docs": [
        "Bootstrap the singleton Config PDA. First caller becomes admin.",
        "",
        "`pyth_receiver` is the on-chain Pyth Receiver program ID that",
        "`settle_market` will validate against — operator-set so the same",
        "`.so` works on devnet (Pyth's real receiver), mainnet (same), and",
        "LiteSVM tests (`MERIDIAN_PROGRAM_ID`, since fixtures mint",
        "meridian-owned `PriceUpdateV2` accounts)."
      ],
      "discriminator": [
        208,
        127,
        21,
        1,
        194,
        190,
        196,
        70
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Fee payer + new admin. The first signer wins: there is no prior",
            "Config to authenticate against, so any caller can take the slot.",
            "Operators deploy this with a controlled keypair at bootstrap."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "docs": [
            "Singleton Config PDA. `init` enforces idempotency: a second call",
            "fails the address-derivation check inside Anchor's account-init",
            "machinery."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "docs": [
            "USDC mint pinned at bootstrap. Mint validation (decimals, freeze",
            "authority, supply policy) is the operator's responsibility; we",
            "only record the pubkey here."
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "feeAuthority",
          "type": "pubkey"
        },
        {
          "name": "pythReceiver",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "mintPair",
      "docs": [
        "Deposit `amount` USDC into the per-market escrow and mint `amount`",
        "Yes + `amount` No tokens to the caller. Preserves the $1.00",
        "invariant `yes_supply == no_supply == usdc_escrow`."
      ],
      "discriminator": [
        19,
        149,
        94,
        110,
        181,
        186,
        33,
        107
      ],
      "accounts": [
        {
          "name": "user",
          "docs": [
            "Caller — pays USDC, receives Yes + No."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "docs": [
            "Global config — read-only here; we only need the pause flag."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "docs": [
            "Market this mint pair belongs to. The Yes/No mints and the",
            "mint-authority PDA are validated against the fields on this account."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.expiry_unix",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "userUsdc",
          "docs": [
            "User's USDC source ATA — must hold ≥ `amount` USDC. Mint check",
            "happens via the `token::mint = config.usdc_mint` constraint."
          ],
          "writable": true
        },
        {
          "name": "usdcEscrow",
          "docs": [
            "USDC escrow PDA owned by the market's mint-authority PDA. Receives",
            "the `amount` USDC the user deposits."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "docs": [
            "Yes mint — `mint::authority = mint_authority` PDA."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "noMint",
          "docs": [
            "No mint — `mint::authority = mint_authority` PDA."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "userYes",
          "docs": [
            "User's Yes-token ATA. Receives newly-minted Yes tokens."
          ],
          "writable": true
        },
        {
          "name": "userNo",
          "docs": [
            "User's No-token ATA. Receives newly-minted No tokens."
          ],
          "writable": true
        },
        {
          "name": "mintAuthority",
          "docs": [
            "bump pair below; signs the two `mint_to` CPIs."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "placeLimitOrder",
      "docs": [
        "Place a price-time-priority limit order on the book. Partial fills",
        "settle inline against opposing makers (up to",
        "[`instructions::place_limit_order::MAX_FILLS_PER_TX`]); any residual",
        "posts to the caller's side with the engine's next sequence number.",
        "",
        "Maker ATAs (USDC + Yes per fill) must be supplied as",
        "`remaining_accounts` in fill order — see the module docs for the",
        "layout."
      ],
      "discriminator": [
        108,
        176,
        33,
        186,
        146,
        229,
        1,
        197
      ],
      "accounts": [
        {
          "name": "user",
          "docs": [
            "Taker. Pays collateral up front; receives counter-asset on fill."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "docs": [
            "Global config — read-only; we only need the pause flag and USDC mint."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "docs": [
            "Market the book belongs to. Yes mint and settled-flag are read here."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.expiry_unix",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "book",
          "docs": [
            "Zero-copy `Book` PDA. Loaded mutably for the match + insert.",
            "",
            "We use the plain `AccountLoader<Book>` rather than Anchor 1.0's",
            "`LazyAccount<Book>` because every code path in this instruction",
            "touches both sides (`bids` and `asks`) — the deferred-deserialize",
            "win of `LazyAccount` is marginal when the whole book is read each",
            "step. The plan §U5 §3 explicitly endorses this choice."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "usdcEscrow",
          "docs": [
            "USDC escrow PDA owned by the per-market `mint_authority`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesEscrow",
          "docs": [
            "Yes-token escrow PDA owned by the same `mint_authority`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "docs": [
            "Yes mint — only used to validate the escrow and maker ATAs."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "userUsdc",
          "docs": [
            "User's USDC ATA. Source for Buy bids, destination for Sell-taker",
            "proceeds + price-improvement refunds."
          ],
          "writable": true
        },
        {
          "name": "userYes",
          "docs": [
            "User's Yes ATA. Source for Sell asks, destination for Buy-taker",
            "fills."
          ],
          "writable": true
        },
        {
          "name": "mintAuthority",
          "docs": [
            "seed+bump pair below; signs every PDA-side transfer this instruction",
            "emits."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "placeLimitOrderArgs"
            }
          }
        }
      ]
    },
    {
      "name": "placeMarketOrder",
      "docs": [
        "Place a market order — same matching flow as `place_limit_order`",
        "but any unfilled residual is refunded to the taker rather than",
        "posted. `slippage_bound` caps the worst price the taker accepts."
      ],
      "discriminator": [
        90,
        118,
        192,
        252,
        192,
        99,
        39,
        145
      ],
      "accounts": [
        {
          "name": "user",
          "docs": [
            "Taker. Pays collateral up front; receives counter-asset on fill."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.expiry_unix",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "book",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "usdcEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "userUsdc",
          "writable": true
        },
        {
          "name": "userYes",
          "writable": true
        },
        {
          "name": "mintAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "placeMarketOrderArgs"
            }
          }
        }
      ]
    },
    {
      "name": "redeem",
      "docs": [
        "Burn `amount` of the **winning** token from the caller's ATA and",
        "PDA-signed transfer `amount` USDC from escrow back to the caller.",
        "Requires `market.settled` + `outcome.is_some()`. Caller-supplied",
        "`winning_mint` must match the outcome (`WrongRedeemMint` otherwise)."
      ],
      "discriminator": [
        184,
        12,
        86,
        149,
        70,
        196,
        97,
        225
      ],
      "accounts": [
        {
          "name": "user",
          "docs": [
            "Caller — pays winning tokens, receives USDC."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.expiry_unix",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "winningMint",
          "docs": [
            "The **winning** mint. We don't constrain via seeds here because the",
            "\"which side wins\" is read off the market's outcome at handler time;",
            "the handler verifies `winning_mint.key()` matches `market.{yes,no}_mint`",
            "based on outcome. Passing the losing mint trips `WrongRedeemMint`."
          ],
          "writable": true
        },
        {
          "name": "userWinning",
          "docs": [
            "User's ATA for the winning token. Source of the burn."
          ],
          "writable": true
        },
        {
          "name": "userUsdc",
          "docs": [
            "User's USDC ATA. Destination of the $1-per-token payout."
          ],
          "writable": true
        },
        {
          "name": "usdcEscrow",
          "docs": [
            "USDC escrow PDA. Source of the payout."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "mintAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "sellNo",
      "docs": [
        "Atomic \"Sell No\" — market-buy `amount` Yes, then burn the freshly",
        "bought Yes + a matching `amount` of the caller's existing No to",
        "reclaim `amount` USDC. Reverts atomically if the Yes buy leg can't",
        "fill the full `amount` within `max_yes_buy_price`. User's net USDC",
        "delta is `amount - sum(fill_price * fill_qty)`."
      ],
      "discriminator": [
        189,
        194,
        132,
        42,
        80,
        249,
        154,
        103
      ],
      "accounts": [
        {
          "name": "user",
          "docs": [
            "Caller. Holds `amount` No upfront, ends with USDC delta + 0 Yes."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.expiry_unix",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "book",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "usdcEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "noMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "userUsdc",
          "docs": [
            "User's USDC ATA. Sources the up-front lock for the market-buy and",
            "receives the burn_pair USDC at the end."
          ],
          "writable": true
        },
        {
          "name": "userYes",
          "docs": [
            "User's Yes ATA. Starts at any balance — the market-buy leg deposits",
            "the bought Yes here, then burn_pair burns `amount` from it. Net",
            "change: 0 (started 0, market-buy ended with `amount`, burn cleared)."
          ],
          "writable": true
        },
        {
          "name": "userNo",
          "docs": [
            "User's No ATA. Must hold ≥ `args.amount` before the call — the",
            "burn_pair leg drains `amount` from it. Validated via Anchor",
            "constraint so the failure surfaces before any state mutation.",
            "",
            "Note: we reference the instruction args via `#[instruction(args:",
            "SellNoArgs)]` so the constraint can read `args.amount` at account",
            "validation time. Anchor 1.0 wires this through cleanly."
          ],
          "writable": true
        },
        {
          "name": "mintAuthority",
          "docs": [
            "refund and the per-fill USDC payouts."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "sellNoArgs"
            }
          }
        }
      ]
    },
    {
      "name": "setPaused",
      "docs": [
        "Admin-only: flip the global `config.paused` kill switch. `true`",
        "pauses every user-facing instruction; `false` resumes. The only",
        "way to toggle the flag that `initialize_config` sets to `false`."
      ],
      "discriminator": [
        91,
        60,
        125,
        192,
        176,
        225,
        166,
        218
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Admin authority. Must equal `config.admin`."
          ],
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "docs": [
            "Singleton Config. Seeds + bump pin it to the canonical PDA; the",
            "`has_one` ties the signer to the recorded admin."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setRequireFullVerification",
      "docs": [
        "Admin-only: toggle whether `settle_market` requires a fully",
        "Wormhole-verified (`VerificationLevel::Full`) Pyth price. Defaults to",
        "`true` at `initialize_config`; relax on devnet if only `Partial`",
        "updates are available."
      ],
      "discriminator": [
        188,
        226,
        166,
        153,
        98,
        79,
        206,
        73
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Admin authority. Must equal `config.admin`."
          ],
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "docs": [
            "Singleton Config. Seeds + bump pin it to the canonical PDA; the",
            "`has_one` ties the signer to the recorded admin."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "requireFull",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setTreasury",
      "docs": [
        "Admin-only: rotate the treasury authority that receives collateral",
        "recovered from permanently-stuck orders via `admin_force_expire_order`."
      ],
      "discriminator": [
        57,
        97,
        196,
        95,
        195,
        206,
        106,
        136
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Admin authority. Must equal `config.admin`."
          ],
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "docs": [
            "Singleton Config. Seeds + bump pin it to the canonical PDA; the",
            "`has_one` ties the signer to the recorded admin."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newTreasury",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "settleMarket",
      "docs": [
        "Read the Pyth `PriceUpdateV2` account and stamp the market's",
        "outcome (R15a). Public — anyone can call once the expiry is past",
        "and the oracle is fresh enough. Atomically sets",
        "`settled = true` + `outcome = Some(_)` so any subsequent reader",
        "sees the invariant `settled → outcome.is_some()`."
      ],
      "discriminator": [
        193,
        153,
        95,
        216,
        166,
        6,
        144,
        217
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Caller. Pays no SOL — `Market` is already initialized and we don't",
            "open new accounts here. Doesn't need to be admin (the oracle + the",
            "expiry timestamp are the actual gate)."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "docs": [
            "Global config — read for the operator-set `pyth_receiver` pubkey",
            "that the price-update account must be owned by. Boxed for stack",
            "hygiene (Config is ~130 bytes; inline copies inflate try_accounts)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "docs": [
            "Market to settle. Mutated."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.expiry_unix",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "priceUpdate",
          "docs": [
            "Pyth `PriceUpdateV2` account. Validated manually in the handler:",
            "",
            "1. `owner == config.pyth_receiver` — operator-pinned per cluster",
            "(Pyth's real receiver on devnet/mainnet; this program's ID in",
            "LiteSVM fixtures).",
            "2. First 8 bytes match the vendored `PriceUpdateV2` discriminator",
            "(Anchor `try_deserialize` enforces this).",
            "3. The Borsh-decoded `PriceFeedMessage` survives the freshness +",
            "feed-id + confidence checks below.",
            "",
            "`UncheckedAccount` is required because Anchor's `Account<T>` for",
            "types declared with `#[account]` pins the owner check to",
            "`crate::ID`, which would reject real Pyth-owned accounts. We",
            "reproduce the discriminator check ourselves via `try_deserialize`",
            "after the manual owner check below.",
            ""
          ]
        }
      ],
      "args": []
    },
    {
      "name": "settleSweep",
      "docs": [
        "Iteratively drain resting orders on a settled market and refund",
        "their escrowed collateral to the owners (R15b). Public crank;",
        "reentrant-safe across multiple calls. `max_orders = 0` is a no-op,",
        "as is calling on an already-empty book."
      ],
      "discriminator": [
        79,
        194,
        152,
        131,
        151,
        36,
        101,
        95
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Caller — anyone. Doesn't have to be admin or order owner; the",
            "instruction is a public crank that just refunds escrowed collateral",
            "to the resting orders' owners."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.expiry_unix",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "book",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "usdcEscrow",
          "docs": [
            "USDC escrow PDA. Refunds bid cancellations."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesEscrow",
          "docs": [
            "Yes escrow PDA. Refunds ask cancellations."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "docs": [
            "Yes mint — used to validate per-fill recipient ATAs."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "mintAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "settleSweepArgs"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "book",
      "discriminator": [
        121,
        34,
        121,
        35,
        91,
        62,
        85,
        222
      ]
    },
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "market",
      "discriminator": [
        219,
        190,
        213,
        55,
        0,
        227,
        198,
        154
      ]
    }
  ],
  "events": [
    {
      "name": "stuckOrderRecovered",
      "discriminator": [
        248,
        186,
        5,
        13,
        74,
        47,
        252,
        11
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Signer is not authorized for this instruction."
    },
    {
      "code": 6001,
      "name": "alreadyInitialized",
      "msg": "Config is already initialized."
    },
    {
      "code": 6002,
      "name": "programPaused",
      "msg": "Program is paused."
    },
    {
      "code": 6003,
      "name": "invalidAmount",
      "msg": "Invalid amount or price (must be > 0 and within range)."
    },
    {
      "code": 6004,
      "name": "marketSettled",
      "msg": "Market is already settled; orders cannot be placed."
    },
    {
      "code": 6005,
      "name": "marketNotSettled",
      "msg": "Market is not settled yet."
    },
    {
      "code": 6006,
      "name": "marketNotExpired",
      "msg": "Market is not yet expired; cannot settle."
    },
    {
      "code": 6007,
      "name": "oracleStale",
      "msg": "Oracle price update is too stale."
    },
    {
      "code": 6008,
      "name": "oracleConfidenceTooWide",
      "msg": "Oracle confidence interval is too wide."
    },
    {
      "code": 6009,
      "name": "bookFull",
      "msg": "Order book side is full."
    },
    {
      "code": 6010,
      "name": "orderNotFound",
      "msg": "Order not found on the book."
    },
    {
      "code": 6011,
      "name": "oracleFeedIdMismatch",
      "msg": "Oracle account feed id does not match the market's pinned feed id."
    },
    {
      "code": 6012,
      "name": "wrongRedeemSide",
      "msg": "Redeem called with the losing side; only the winning token is redeemable."
    },
    {
      "code": 6013,
      "name": "wrongRedeemMint",
      "msg": "Redeem-side mint does not match the market's recorded outcome."
    },
    {
      "code": 6014,
      "name": "invalidOraclePrice",
      "msg": "Oracle returned a non-positive price; refusing to settle."
    },
    {
      "code": 6015,
      "name": "slippageNotMet",
      "msg": "Order could not fully fill within slippage bound; revise and retry."
    },
    {
      "code": 6016,
      "name": "invariantBroken",
      "msg": "Internal invariant violated. This is a bug — please report."
    },
    {
      "code": 6017,
      "name": "invalidOracleOwner",
      "msg": "Oracle account is not owned by the operator-pinned Pyth receiver program."
    },
    {
      "code": 6018,
      "name": "emergencyGraceNotElapsed",
      "msg": "Admin emergency-settle grace period has not elapsed yet."
    },
    {
      "code": 6019,
      "name": "oracleVerificationInsufficient",
      "msg": "Oracle price update is not fully verified; refusing to settle."
    },
    {
      "code": 6020,
      "name": "marketExpired",
      "msg": "Market has reached expiry; trading is closed."
    },
    {
      "code": 6021,
      "name": "badMakerAccount",
      "msg": "Maker payout account is not the maker's canonical associated token account."
    },
    {
      "code": 6022,
      "name": "recoveryGraceNotElapsed",
      "msg": "Recovery grace period has not elapsed; cannot force-expire this order yet."
    },
    {
      "code": 6023,
      "name": "orderNotStuck",
      "msg": "Order is not stuck (canonical ATA is receivable); use settle_sweep instead."
    },
    {
      "code": 6024,
      "name": "invalidTreasuryAccount",
      "msg": "Recovery destination is not the treasury's canonical associated token account."
    },
    {
      "code": 6025,
      "name": "treasuryNotConfigured",
      "msg": "Treasury is not configured (still equals admin); call set_treasury first."
    },
    {
      "code": 6026,
      "name": "treasuryAtaNotReceivable",
      "msg": "Treasury associated token account is not receivable; create or unfreeze it first."
    }
  ],
  "types": [
    {
      "name": "adminForceExpireOrderArgs",
      "docs": [
        "`admin_force_expire_order` arguments. `(side, price, seq)` identify the",
        "specific stuck order, same convention as `cancel_order`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "side",
            "docs": [
              "0 = Bid, 1 = Ask."
            ],
            "type": "u8"
          },
          {
            "name": "price",
            "docs": [
              "Price half of the order's `OrderKey`."
            ],
            "type": "u64"
          },
          {
            "name": "seq",
            "docs": [
              "Sequence half of the order's `OrderKey`."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "book",
      "docs": [
        "Order book for a single market.",
        "",
        "Zero-copy via Anchor's `#[account(zero_copy)]` — `Book` is `Pod` (the",
        "hand-written impls live on `BookSide` and `OrderEntry` in the matching",
        "module). The two sides are read/written via `AccountLoader<Book>` and",
        "`load_mut()` at instruction time."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "docs": [
              "The Market PDA this book belongs to. Used as a cross-check when",
              "instructions take both Market and Book accounts."
            ],
            "type": "pubkey"
          },
          {
            "name": "bids",
            "docs": [
              "Bid side — best (highest price) first, FIFO within a price."
            ],
            "type": {
              "defined": {
                "name": "meridian::matching::book_side::BookSide<32>",
                "generics": [
                  {
                    "kind": "const",
                    "value": "32"
                  }
                ]
              }
            }
          },
          {
            "name": "asks",
            "docs": [
              "Ask side — best (lowest price) first, FIFO within a price."
            ],
            "type": {
              "defined": {
                "name": "meridian::matching::book_side::BookSide<32>",
                "generics": [
                  {
                    "kind": "const",
                    "value": "32"
                  }
                ]
              }
            }
          },
          {
            "name": "nextSeq",
            "docs": [
              "Monotonically-increasing sequence number, shared across both sides.",
              "The program bumps this on every place so resting orders within a",
              "price level keep FIFO order across cancels and partial fills."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "buyNoArgs",
      "docs": [
        "`buy_no` arguments.",
        "",
        "`min_yes_sell_price` is the worst (lowest) price-per-Yes the taker",
        "will accept on the sell leg. See module docs for the naming rationale.",
        "Pass `1` for \"no floor\" (`0` is rejected — collides with the OrderKey",
        "invalid sentinel)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount",
            "docs": [
              "Quantity of No tokens the user wants to end up holding."
            ],
            "type": "u64"
          },
          {
            "name": "minYesSellPrice",
            "docs": [
              "Slippage floor for the Yes sell leg (microunits per Yes token)."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "cancelOrderArgs",
      "docs": [
        "`cancel_order` arguments.",
        "",
        "`side` matches `place_limit_order`'s convention: 0 = Bid, 1 = Ask.",
        "`(price, seq)` is the full `OrderKey` the place instruction returned",
        "(via `msg!` log) when the order was placed."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "side",
            "docs": [
              "0 = Bid, 1 = Ask."
            ],
            "type": "u8"
          },
          {
            "name": "price",
            "docs": [
              "Price half of the order's `OrderKey`."
            ],
            "type": "u64"
          },
          {
            "name": "seq",
            "docs": [
              "Sequence half of the order's `OrderKey`."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "docs": [
              "PDA bump for `[b\"config\"]`."
            ],
            "type": "u8"
          },
          {
            "name": "paused",
            "docs": [
              "Global pause flag — user-facing instructions refuse when set."
            ],
            "type": "bool"
          },
          {
            "name": "admin",
            "docs": [
              "Admin authority — currently the only privileged role",
              "(`create_strike_market`, `pause`/`unpause`, settle override)."
            ],
            "type": "pubkey"
          },
          {
            "name": "feeAuthority",
            "docs": [
              "Fee authority — receives any fee accruals once fees are wired",
              "(deferred to follow-up work; field exists for forward compatibility)."
            ],
            "type": "pubkey"
          },
          {
            "name": "usdcMint",
            "docs": [
              "USDC mint used for all collateral on this deployment. Pinned at",
              "`initialize_config` time; markets reference it indirectly via the",
              "program's escrow PDAs."
            ],
            "type": "pubkey"
          },
          {
            "name": "pythReceiver",
            "docs": [
              "Pyth Receiver program ID — the expected owner for every",
              "`PriceUpdateV2` account `settle_market` accepts. Operator sets this",
              "at `initialize_config` time:",
              "",
              "* Devnet / mainnet: Pyth's on-chain Receiver program",
              "(`rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` as of 2026).",
              "* LiteSVM / test fixtures: this program's own ID",
              "(`MERIDIAN_PROGRAM_ID`), because test code mints owner-meridian",
              "accounts via `set_account`.",
              "",
              "Pinning this in Config (rather than hardcoding the Pyth Receiver",
              "pubkey in code) lets the same `.so` work in both environments",
              "without a feature flag."
            ],
            "type": "pubkey"
          },
          {
            "name": "requireFullVerification",
            "docs": [
              "When `true`, `settle_market` requires the Pyth price update to carry",
              "`VerificationLevel::Full` (two-thirds of the Wormhole guardian set",
              "signed). Secure-by-default: `initialize_config` sets this `true`, so a",
              "fresh deployment is mainnet-correct without anyone flipping a switch.",
              "An operator can relax it (e.g. on devnet where only `Partial` updates",
              "are posted) via `set_require_full_verification`."
            ],
            "type": "bool"
          },
          {
            "name": "treasury",
            "docs": [
              "Treasury authority — custodian for collateral recovered from",
              "permanently-stuck orders via `admin_force_expire_order`. Kept distinct",
              "from `fee_authority` so custodial user funds (which an owner may later",
              "reclaim off-chain) stay accounting-separate from protocol revenue.",
              "Defaults to `admin` at `initialize_config`; operators MUST rotate it via",
              "`set_treasury` to a dedicated custody account before any recovery",
              "(the recovery instruction rejects `treasury == admin`). Appended at the",
              "struct end so prior field offsets stay stable."
            ],
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "createStrikeMarketArgs",
      "docs": [
        "Arguments to `create_strike_market`.",
        "",
        "Bundled into a single struct so the PDA-seed derivation in the",
        "`#[instruction(...)]` macro stays readable."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ticker",
            "docs": [
              "8-byte right-padded ASCII ticker (e.g. `b\"META\\0\\0\\0\\0\"`)."
            ],
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "strikePrice",
            "docs": [
              "Strike price in USDC microunits."
            ],
            "type": "u64"
          },
          {
            "name": "expiryUnix",
            "docs": [
              "Expiry as a unix timestamp (seconds since epoch)."
            ],
            "type": "i64"
          },
          {
            "name": "pythFeedId",
            "docs": [
              "Pyth `PriceUpdateV2` feed id for the underlying."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "market",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "docs": [
              "PDA bump for the seed `[b\"market\", ticker, strike_le, expiry_le]`."
            ],
            "type": "u8"
          },
          {
            "name": "mintAuthorityBump",
            "docs": [
              "Bump for the Yes/No mint authority PDA at",
              "`[b\"mint_auth\", market.key().as_ref()]`. Cached so the mint-path",
              "instructions (`mint_pair`, redeem) can sign without recomputing."
            ],
            "type": "u8"
          },
          {
            "name": "settled",
            "docs": [
              "`true` once `settle_market` has recorded an outcome."
            ],
            "type": "bool"
          },
          {
            "name": "ticker",
            "docs": [
              "8-byte right-padded ASCII ticker (e.g. `b\"META\\0\\0\\0\\0\"`). Fixed",
              "width so the PDA seed is stable."
            ],
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "strikePrice",
            "docs": [
              "Strike price in USDC microunits (USDC has 6 decimals; $680.00 →",
              "680_000_000). Pyth feeds are normalized to the same unit at",
              "settle time."
            ],
            "type": "u64"
          },
          {
            "name": "expiryUnix",
            "docs": [
              "Expiry as a unix timestamp (seconds since epoch). The plan called",
              "this `expiry_slot`; renamed to `expiry_unix` because Pyth +",
              "`Clock::unix_timestamp` work in unix seconds, not Solana slots."
            ],
            "type": "i64"
          },
          {
            "name": "yesMint",
            "docs": [
              "Yes-token mint pubkey. Owned by the mint-authority PDA above."
            ],
            "type": "pubkey"
          },
          {
            "name": "noMint",
            "docs": [
              "No-token mint pubkey. Owned by the mint-authority PDA above."
            ],
            "type": "pubkey"
          },
          {
            "name": "sweepCursor",
            "docs": [
              "Cursor into the open-order list for the iterative settle sweep",
              "(R15b). Resumable across multiple `settle_sweep` calls so a market",
              "with more open orders than fit in a single transaction's CU budget",
              "can still be drained."
            ],
            "type": "u32"
          },
          {
            "name": "outcome",
            "docs": [
              "Settled outcome, populated by `settle_market`. `None` until then."
            ],
            "type": {
              "option": {
                "defined": {
                  "name": "outcome"
                }
              }
            }
          },
          {
            "name": "pythFeedId",
            "docs": [
              "Pyth `PriceUpdateV2` feed id (32-byte) for the underlying.",
              "Pinned at market creation so settle can verify it."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "settledAt",
            "docs": [
              "Unix timestamp (seconds) at which the market was settled, stamped by",
              "`settle_market` / `admin_settle_market`. `0` while unsettled. Used as",
              "the precise base for the post-settlement recovery grace window in",
              "`admin_force_expire_order` (a stuck order can only be force-expired",
              "after `settled_at + RECOVERY_GRACE_SECONDS`)."
            ],
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "outcome",
      "docs": [
        "Binary outcome of a settled market.",
        "",
        "Stored as `Option<Outcome>` on [`Market`] so the pre-settle state is",
        "unambiguous (`None`). Borsh-serializable for normal-account use."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "yesWins"
          },
          {
            "name": "noWins"
          }
        ]
      }
    },
    {
      "name": "placeLimitOrderArgs",
      "docs": [
        "`place_limit_order` arguments.",
        "",
        "`side` is encoded as `u8` (0 = Bid, 1 = Ask) because matching's `Side`",
        "enum isn't `AnchorSerialize`. The handler maps the byte to [`Side`]."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "side",
            "docs": [
              "0 = Bid (Buy Yes), 1 = Ask (Sell Yes). Any other value rejected."
            ],
            "type": "u8"
          },
          {
            "name": "price",
            "docs": [
              "Limit price in USDC microunits per Yes token."
            ],
            "type": "u64"
          },
          {
            "name": "qty",
            "docs": [
              "Quantity in Yes-token base units."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "placeMarketOrderArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "side",
            "docs": [
              "0 = Bid (Buy Yes), 1 = Ask (Sell Yes)."
            ],
            "type": "u8"
          },
          {
            "name": "qty",
            "docs": [
              "Quantity in Yes-token base units."
            ],
            "type": "u64"
          },
          {
            "name": "slippageBound",
            "docs": [
              "Slippage bound (worst acceptable price per Yes token). For a Bid",
              "taker this is the max it will pay; for an Ask taker the min it",
              "will accept. `0` is rejected — pass `1` for \"no floor\" Ask or",
              "`u64::MAX` for \"no ceiling\" Bid."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "sellNoArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount",
            "docs": [
              "Quantity of No tokens the user wants to liquidate."
            ],
            "type": "u64"
          },
          {
            "name": "maxYesBuyPrice",
            "docs": [
              "Slippage cap for the Yes buy leg (microunits per Yes token)."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "settleSweepArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "maxOrders",
            "docs": [
              "Number of resting orders to drain this call. Capped at",
              "[`MAX_SWEEP_PER_TX`]; 0 is a no-op success."
            ],
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "stuckOrderRecovered",
      "docs": [
        "Emitted when an admin recovers a stuck order's collateral to the treasury.",
        "The off-chain custody ledger consumes this to track what an owner may later",
        "reclaim."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "docs": [
              "The recovered collateral's mint (USDC for a Bid, the market's Yes mint",
              "for an Ask) — so an off-chain custody ledger needn't re-derive it."
            ],
            "type": "pubkey"
          },
          {
            "name": "side",
            "docs": [
              "0 = Bid (USDC recovered), 1 = Ask (Yes recovered)."
            ],
            "type": "u8"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "qty",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
