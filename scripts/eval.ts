import { readFileSync } from "node:fs";
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
const scorer = config.llm ? createLlmScorer(config.llm) : heuristicScorer;
const minScore = config.barkMinScore;

let tp = 0;
let fp = 0;
let fn = 0;
const lines: string[] = [];
for (const c of cases) {
  const store = await memoryStore();
  for (const t of PRESET_THEMES) await store.createTheme({ ...t, preset: true });
  for (const t of PRESET_TRADES) await store.createTrade({ ...t, preset: true });
  const weight = DEFAULT_SOURCES.find((s) => s.name === c.source)?.weight ?? 1;
  const source = await store.createSource({ type: "push", name: c.source, config: {}, weight });
  const result = await processItems(deps(store, { scorer, policy: config }), source, [{ externalId: "1", title: c.title }]);
  const push = result.alerts.find((a) => a.reason === "direct" && a.score >= minScore);
  if (push && c.label === "alert") tp++;
  if (push && c.label === "noise") fp++;
  if (!push && c.label === "alert") fn++;
  const mark = push ? (c.label === "alert" ? "TP" : "FP") : c.label === "alert" ? "FN" : "  ";
  if (mark.trim()) lines.push(`${mark} ${push?.score ?? "-"} ${c.synthetic ? "[syn] " : ""}${c.title}`);
}
console.log(lines.join("\n"));
const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
const recall = tp / (tp + fn);
console.log(`\nscorer=${scorer.name} barkMinScore=${minScore} cases=${cases.length}`);
console.log(`bark pushes: ${tp + fp}  precision=${precision.toFixed(2)}  recall=${recall.toFixed(2)}`);
