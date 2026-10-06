import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { processItems } from "../src/pipeline.js";
import { DEFAULT_SOURCES, PRESET_THEMES, PRESET_TRADES } from "../src/presets.js";
import { heuristicScorer } from "../src/scoring/heuristic.js";
import { createLlmScorer } from "../src/scoring/llm.js";
import { deps, memoryStore } from "../test/helpers.js";

interface Case {
  source: string;
  title: string;
  label: "alert" | "noise";
  synthetic?: boolean;
}

const cases = JSON.parse(readFileSync(new URL("../test/fixtures/eval.json", import.meta.url), "utf8")) as Case[];
const config = loadConfig();
const tokens = { calls: 0, prompt: 0, completion: 0 };
const countingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const res = await fetch(input, init);
  const body = (await res.clone().json().catch(() => ({}))) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
  tokens.calls++;
  tokens.prompt += body.usage?.prompt_tokens ?? 0;
  tokens.completion += body.usage?.completion_tokens ?? 0;
  return res;
}) as typeof fetch;
const scorer = config.llm ? createLlmScorer(config.llm, countingFetch) : heuristicScorer;
const minScore = config.barkMinScore;

let tp = 0;
let fp = 0;
let fn = 0;
const lines: string[] = [];
const dump: Record<string, unknown>[] = [];
for (const c of cases) {
  const store = await memoryStore();
  for (const t of PRESET_THEMES) await store.createTheme({ ...t, preset: true });
  for (const t of PRESET_TRADES) await store.createTrade({ ...t, preset: true });
  const weight = DEFAULT_SOURCES.find((s) => s.name === c.source)?.weight ?? 1;
  const source = await store.createSource({ type: "push", name: c.source, config: {}, weight });
  let pushed = false;
  const fakeBark = (async () => {
    pushed = true;
    return new Response("{}");
  }) as unknown as typeof fetch;
  const d = deps(store, {
    scorer,
    policy: config,
    barkUrl: "https://bark.invalid/eval",
    barkMinScore: minScore,
    barkRequiresMaterial: Boolean(config.llm),
    fetch: fakeBark,
  });
  const result = await processItems(d, source, [{ externalId: "1", title: c.title }]);
  const push = pushed ? result.alerts[0] : undefined;
  if (push && c.label === "alert") tp++;
  if (push && c.label === "noise") fp++;
  if (!push && c.label === "alert") fn++;
  const mark = push ? (c.label === "alert" ? "TP" : "FP") : c.label === "alert" ? "FN" : "  ";
  const [obs] = await store.listObservations(1);
  const j = obs?.judgment;
  const detail = process.env.EVAL_VERBOSE && j ? `\n     material=${j.material} consequence=${j.consequence.toFixed(2)} source_weight=${weight} :: ${j.rationale}` : "";
  dump.push({ title: c.title, label: c.label, synthetic: Boolean(c.synthetic), weight, pushed, material: j?.material, consequence: j?.consequence, rationale: j?.rationale });
  if (mark.trim()) lines.push(`${mark} ${push?.score ?? "-"} ${c.synthetic ? "[syn] " : ""}${c.title}${detail}`);
}
console.log(lines.join("\n"));
if (process.env.EVAL_DUMP) writeFileSync(process.env.EVAL_DUMP, JSON.stringify(dump, null, 1));
const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
const recall = tp / (tp + fn);
console.log(`\nscorer=${scorer.name} barkMinScore=${minScore} cases=${cases.length}`);
if (config.llm) console.log(`llm calls=${tokens.calls} prompt_tokens=${tokens.prompt} completion_tokens=${tokens.completion}`);
console.log(`bark pushes: ${tp + fp}  precision=${precision.toFixed(2)}  recall=${recall.toFixed(2)}`);
