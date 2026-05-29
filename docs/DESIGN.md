# Meridian — Design System

The source of truth for Meridian's UI. Direction: **approachable prediction-market** —
the clarity of Polymarket/Kalshi (binary Yes/No, implied probability as the hero
number, plain-language questions) with the polish and trust of Coinbase/Phantom
(clean cards, calm palette, generous spacing). Grounded in the PRD's thesis:
*simple, intuitive, eliminates complexity for retail participants.*

## Principles
1. **The question is the hero.** "Will META close above $680 today?" leads every surface.
2. **Price is probability.** A Yes price of $0.62 = a 62% implied chance. Show it as a probability, always.
3. **Known max gain, known max loss.** Surface payoff/return and risk at the point of every trade (PRD §26).
4. **Hide the plumbing.** Users see Buy/Sell Yes/No intents, never "mint-and-sell-Yes" (PRD §131-138).
5. **Calm, not frantic.** Approachable for retail; the order book is present for credibility, not a dense terminal.

## Color
| Token | Value | Use |
|---|---|---|
| `--bg` | `#0a0c11` | app background (soft deep slate, not pure black) |
| `--surface` | `#161a24` | cards / panels |
| `--surface-2` | `#1c212d` | nested / hover surfaces |
| `--border` | `#262c3a` | hairlines |
| `--text` | `#eef1f6` | primary text |
| `--text-dim` | `#aab2c5` | secondary text |
| `--muted` | `#6c7488` | tertiary / labels |
| `--accent` | `#6d6afe` | brand / interactive (indigo→violet) |
| `--yes` | `#2bd47d` | Yes / bullish / bids |
| `--no` | `#ff5c79` | No / bearish / asks |
| `--warn` | `#ffb547` | countdown urgency / caution |

Yes is always green, No is always red — consistent across book, buttons, probability, P&L.

## Type
- **Inter** (variable, via `next/font`) for all UI.
- **Tabular mono** (`.mono`, `font-variant-numeric: tabular-nums`) for all prices, sizes, countdowns — numbers must not jitter.
- Scale: 12 (label) · 14 (body) · 16 (emphasis) · 20/24 (section) · 32/40 (hero).

## Shape & depth
- Radius: `--radius-sm` 10 · `--radius` 14 · `--radius-lg` 20.
- One soft shadow (`--shadow`) for elevated cards; flat hairline borders otherwise.
- Focus ring: `--ring` (accent glow) on every interactive element.

## Motion
- 120–160ms ease on hover/active/color transitions.
- Prices flash `--yes`/`--no` briefly on change. Countdown pulses `--warn` in the final minutes.
- Respect `prefers-reduced-motion`.

## Components
`.panel` card · `.btn` / `.btn-yes` / `.btn-no` / `.btn-ghost` · `.input` · `.pill` / `.badge`
· `.prob-bar` (Yes/No split) · `.depth-row` (order-book level with depth fill) · `.stat` (label+value).
