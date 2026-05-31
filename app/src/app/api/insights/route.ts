import { NextResponse } from "next/server";

// Server-side Claude proxy for the "Ask about any market" chat. The API key
// stays on the server (never shipped to the browser). When no key is set or the
// upstream call fails, this returns a non-200 so the client falls back to the
// deterministic on-chain market lookup. No conversation state is kept.
export const runtime = "nodejs";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";

const SYSTEM = [
  "You are Meridian's market assistant. Meridian is a non-custodial app for",
  "trading daily binary options on MAG7 stocks: each market asks \"Will TICKER",
  "close above $STRIKE today?\" and the Yes price is the market-implied",
  "probability (Yes + No = $1.00, settles at the 4:00 PM ET close).",
  "Answer the user's question ONLY from the LIVE MARKET DATA provided below.",
  "Be concise (1-3 sentences), concrete, and cite the numbers. If the data",
  "doesn't cover the question, say so briefly. Never invent prices or markets,",
  "and never give financial advice.",
].join(" ");

export async function POST(req: Request) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return NextResponse.json({ error: "no_api_key" }, { status: 503 });
  }

  let body: { question?: string; context?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const question = (body.question ?? "").toString().slice(0, 500);
  const context = (body.context ?? "").toString().slice(0, 4000);
  if (!question.trim()) {
    return NextResponse.json({ error: "empty_question" }, { status: 400 });
  }

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 320,
        system: [
          // Cache the (static) system prompt across requests.
          { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
        ],
        messages: [
          {
            role: "user",
            content: `LIVE MARKET DATA (current):\n${context || "(no active markets right now)"}\n\nQuestion: ${question}`,
          },
        ],
      }),
    });
    if (!r.ok) {
      return NextResponse.json({ error: "upstream", status: r.status }, { status: 502 });
    }
    const data = (await r.json()) as { content?: { type: string; text?: string }[] };
    const answer = (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();
    if (!answer) {
      return NextResponse.json({ error: "empty_answer" }, { status: 502 });
    }
    return NextResponse.json({ answer });
  } catch {
    return NextResponse.json({ error: "request_failed" }, { status: 502 });
  }
}
