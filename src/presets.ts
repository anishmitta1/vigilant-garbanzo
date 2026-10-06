import type { NewSource, NewTheme } from "./db.js";

export const PRESET_THEMES: NewTheme[] = [
  {
    name: "AI infrastructure",
    description: "Compute, data centers, hyperscaler capex, GPUs, power for AI, frontier model labs.",
    keywords: ["data center", "datacenter", "GPU", "hyperscaler", "capex", "Nvidia", "AI chip", "inference", "OpenAI", "Anthropic", "HBM"],
  },
  {
    name: "Semiconductors",
    description: "Chip design, foundries, equipment, export controls, memory pricing.",
    keywords: ["semiconductor", "chipmaker", "foundry", "TSMC", "ASML", "wafer", "export controls", "lithography", "DRAM", "NAND"],
  },
  {
    name: "Crypto",
    description: "Bitcoin, Ethereum, stablecoins, exchanges, crypto regulation, ETF flows.",
    keywords: ["bitcoin", "ethereum", "stablecoin", "crypto", "Coinbase", "Binance", "spot ETF", "DeFi", "Tether"],
  },
  {
    name: "Rates & liquidity",
    description: "Central bank policy, inflation, Treasury yields, balance sheet, funding stress.",
    keywords: ["Federal Reserve", "FOMC", "interest rate", "inflation", "CPI", "Treasury yields", "quantitative tightening", "repo", "ECB", "Bank of Japan"],
  },
  {
    name: "Energy",
    description: "Oil, gas, OPEC, power grids, nuclear, renewables, energy policy.",
    keywords: ["OPEC", "crude oil", "natural gas", "LNG", "power grid", "nuclear", "uranium", "refinery", "Brent"],
  },
];

export const DEFAULT_SOURCES: NewSource[] = [
  { type: "sec-edgar", name: "SEC EDGAR: latest 8-K", config: { forms: ["8-K"] } },
  { type: "rss", name: "Federal Reserve press releases", config: { url: "https://www.federalreserve.gov/feeds/press_all.xml" }, weight: 1.1 },
  { type: "federal-register", name: "Federal Register: rules", config: { documentTypes: ["RULE", "PRORULE"] } },
  { type: "hackernews", name: "Hacker News (100+ points)", config: { minPoints: 100 }, weight: 0.8 },
  { type: "google-news", name: "Google News: markets", config: { query: "stocks OR markets OR earnings when:1d" } },
  { type: "push", name: "Inbound (POST /ingest)", config: {} },
];
