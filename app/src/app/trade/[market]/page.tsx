export default function TradeMarketPage({
  params,
}: {
  params: { market: string };
}) {
  return (
    <main style={{ maxWidth: 1040, margin: "0 auto", padding: "32px 16px" }}>
      <h1 style={{ fontSize: 24, margin: "0 0 8px" }}>Trade</h1>
      <p className="muted">
        The trade screen for market{" "}
        <span className="mono">{params.market}</span> is coming soon (U8).
      </p>
    </main>
  );
}
