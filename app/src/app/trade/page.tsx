import Link from "next/link";

export default function TradeIndexPage() {
  return (
    <main style={{ maxWidth: 1040, margin: "0 auto", padding: "32px 16px" }}>
      <h1 style={{ fontSize: 24, margin: "0 0 8px" }}>Trade</h1>
      <p className="muted">
        Pick a market to trade. The full trade screen is coming soon (U8). For
        now, browse the <Link href="/markets">markets</Link>.
      </p>
    </main>
  );
}
