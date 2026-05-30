import { redirect } from "next/navigation";

// No market selected → send the user to the browse-and-pick screen. The actual
// trade screen lives at /trade/[market]; picking a market there links into it.
export default function TradeIndexPage() {
  redirect("/markets");
}
