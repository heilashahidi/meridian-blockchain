import { redirect } from "next/navigation";

// No market selected → send the user to the dashboard (the browse-and-pick
// surface). The actual trade screen lives at /trade/[market]; clicking a strike
// there links into it.
export default function TradeIndexPage() {
  redirect("/");
}
