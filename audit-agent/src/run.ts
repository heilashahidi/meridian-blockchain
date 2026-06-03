/**
 * CLI entry for the auditor.
 *
 *   npm run audit          # full LangGraph run (needs ANTHROPIC_API_KEY)
 *   npm run dry            # no-LLM smoke test: exercises the tools + wiring
 *
 * --dry proves the closed loop (readSource + runProbe against the real program)
 * without spending tokens — useful in CI and for first-run sanity.
 */
import { ENABLE_TRIDENT, MODEL } from "./config.js";
import { readSource, runProbe } from "./tools.js";

async function dry() {
  console.log("● dry run — no LLM, exercising the toolchain wiring\n");

  // 1) readSource is scoped to the program tree.
  const head = readSource("src/instructions/admin.rs", "pub fn|has_one|Signer");
  console.log("readSource(admin.rs ~signer lines):");
  console.log(
    head.split("\n").slice(0, 6).map((l) => "    " + l).join("\n") || "    (none)",
  );

  // 2) a grep probe — the fast closed-loop verification primitive.
  const grep = runProbe({
    kind: "grep",
    pattern: "has_one = admin",
    confirmIf: "admin instructions bind the signer to config.admin",
  });
  console.log(`\ngrep probe \`has_one = admin\` → exit=${grep.exitCode}, ran=${grep.ran}`);
  console.log(grep.output.split("\n").slice(0, 5).map((l) => "    " + l).join("\n"));

  console.log(`\n● ok. model=${MODEL}, trident=${ENABLE_TRIDENT ? "on" : "off"}`);
  console.log("  run a full audit with: ANTHROPIC_API_KEY=... npm run audit");
}

async function full() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set. Use `npm run dry` for a no-LLM smoke test.");
    process.exit(1);
  }
  const { buildAuditor } = await import("./graph.js");
  const auditor = buildAuditor();
  console.log(`● auditing the Meridian program with ${MODEL}…\n`);
  const result = await auditor.invoke(
    {},
    { recursionLimit: 200 },
  );
  console.log(`\n● done — ${result.findings.length} confirmed finding(s).`);
  for (const l of result.log) console.log("  " + l);
}

const isDry = process.argv.includes("--dry");
(isDry ? dry() : full()).catch((e) => {
  console.error("audit failed:", e?.message ?? e);
  process.exit(1);
});
