import type { NewSource, NewTheme, NewTrade } from "./db.js";

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

export const PRESET_TRADES: NewTrade[] = [
  {
    name: "AI infra buildout",
    thesis:
      "Hyperscaler and AI-lab capex keeps compounding; bottlenecks in GPUs, HBM, networking, power and data-center capacity accrue value to suppliers.",
    keywords: ["data center", "datacenter", "hyperscaler", "AI capex", "capex", "GPU", "GPUs", "HBM", "AI chip", "AI chips", "AI infrastructure", "Stargate", "Nvidia", "Broadcom", "TSMC", "CoreWeave", "OpenAI", "Anthropic"],
    tickers: ["NVDA", "AVGO", "TSM", "AMD", "MU", "SMCI", "VRT", "ANET", "CRWV", "ORCL", "MSFT", "META", "GOOGL", "AMZN"],
    strengthens: ["raises capex", "capex increase", "higher capex", "record capex", "boosts spending", "data center deal", "compute deal", "sold out", "supply constrained", "GPU shortage", "HBM shortage", "beats estimates", "raises guidance", "record revenue", "export license"],
    weakens: ["cuts capex", "capex cut", "lowers capex", "reduces spending", "cancels data center", "data center cancellation", "pauses data center", "put on hold", "data center ban", "GPU glut", "oversupply", "export ban", "export restrictions", "misses estimates", "lowers guidance", "order cancellation"],
  },
  {
    name: "Crypto clarity",
    thesis:
      "US regulatory clarity (market-structure bill, stablecoin law, friendlier SEC/CFTC) unlocks institutional adoption and flows into crypto and crypto equities.",
    keywords: ["crypto", "cryptocurrency", "bitcoin", "ethereum", "stablecoin", "stablecoins", "digital asset", "digital assets", "CLARITY Act", "GENIUS Act", "market structure bill", "crypto ETF", "spot ETF", "tokenization", "Coinbase", "Circle", "Tether"],
    tickers: ["COIN", "HOOD", "MSTR", "CRCL", "IBIT"],
    strengthens: ["Senate passes", "House passes", "passes Senate", "passes House", "signed into law", "signs into law", "clears committee", "ETF approved", "approves ETF", "SEC approves", "CFTC approves", "SEC dismisses", "drops case", "drops lawsuit", "ends investigation", "no-action letter", "trust charter", "record inflows"],
    weakens: ["bill stalls", "Act stalls", "bill fails", "Act fails", "vote delayed", "delays vote", "rejects ETF", "ETF rejected", "SEC sues", "SEC charges", "enforcement action", "crackdown", "exchange hack", "hacked", "depeg", "record outflows"],
  },
  {
    name: "Yield curve unwinding",
    thesis:
      "The curve keeps re-steepening: the Fed eases the front end while term premium, deficits and Treasury issuance keep long-end yields elevated.",
    keywords: ["yield curve", "steepener", "steepening", "2s10s", "Treasury yields", "Treasury yield", "10-year yield", "30-year yield", "long-end", "term premium", "Treasury issuance", "Treasury auction", "refunding", "Federal Reserve", "FOMC", "bond market", "deficit"],
    tickers: ["TLT", "IEF", "SHY", "TBT"],
    strengthens: ["rate cut", "cuts rates", "dovish", "steepens", "long yields rise", "yields jump", "term premium rises", "larger auctions", "increases issuance", "weak auction", "tail", "deficit widens", "Fed independence", "inflation expectations rise"],
    weakens: ["rate hike", "hikes rates", "hawkish", "flattens", "inversion", "inverts", "yields fall", "buybacks", "cuts issuance", "strong auction", "recession", "flight to safety", "yield curve control"],
  },
  {
    name: "Power & nuclear demand",
    thesis:
      "AI and electrification drive the first sustained US power-demand growth in decades; utilities, IPPs, gas turbines, grid equipment and nuclear benefit.",
    keywords: ["power demand", "electricity demand", "power grid", "utility", "utilities", "nuclear", "SMR", "small modular reactor", "uranium", "gas turbine", "gas turbines", "transmission", "interconnection", "PJM", "ERCOT", "capacity auction", "power purchase agreement"],
    tickers: ["VST", "CEG", "TLN", "NRG", "GEV", "OKLO", "SMR", "CCJ", "NNE", "BWXT"],
    strengthens: ["power purchase agreement", "PPA", "nuclear deal", "reactor restart", "approves restart", "license approved", "NRC approves", "record demand", "record prices", "raises load forecast", "new reactor", "uprate", "turbine orders", "record backlog"],
    weakens: ["FERC delay", "FERC rejects", "license denied", "cancels reactor", "cancels plant", "project cancelled", "forecast cut", "lower load growth", "price cap", "cost overrun"],
  },
  {
    name: "Tariffs & reshoring",
    thesis:
      "Tariffs and industrial policy pull manufacturing back to the US, favouring domestic industrials, automation and construction while pressuring importers' margins.",
    keywords: ["tariff", "tariffs", "reshoring", "onshoring", "nearshoring", "trade deal", "trade war", "Section 232", "Section 301", "CHIPS Act", "import duties", "customs duties", "industrial policy", "US manufacturing", "de minimis"],
    tickers: ["CAT", "ETN", "ROK", "NUE", "STLD", "PH", "EMR"],
    strengthens: ["new tariffs", "raises tariffs", "tariff increase", "imposes tariffs", "new factory", "new plant", "US plant", "manufacturing investment", "invest in U.S.", "invest in US", "CHIPS grant"],
    weakens: ["tariff cut", "lifts tariffs", "lowers tariffs", "tariff exemption", "tariff pause", "pauses tariffs", "strikes down tariffs", "trade truce", "suspends tariffs", "plant closure", "cancels plant"],
  },
  {
    name: "Gold & de-dollarization",
    thesis:
      "Central-bank buying, fiscal worries and sanctions risk push reserves from the dollar into gold, supporting gold, miners and hard assets.",
    keywords: ["gold", "gold price", "bullion", "gold reserves", "de-dollarization", "dedollarization", "dollar index", "reserve currency", "BRICS", "gold ETF", "precious metals"],
    tickers: ["GLD", "IAU", "GDX", "NEM", "AEM"],
    strengthens: ["record high", "all-time high", "central bank buying", "adds gold", "gold purchases", "dollar weakens", "dollar falls", "sanctions", "inflows", "downgrade", "fiscal concerns"],
    weakens: ["dollar strengthens", "dollar rallies", "sells gold", "central bank selling", "outflows", "gold falls", "real yields rise"],
  },
];

const news = (name: string, query: string): NewSource => ({
  type: "google-news",
  name: `Google News: ${name}`,
  config: { query: `${query} when:1d` },
  // Aggregated, repetitive coverage: weigh below primary sources.
  weight: 0.7,
});

export const DEFAULT_SOURCES: NewSource[] = [
  { type: "sec-edgar", name: "SEC EDGAR: latest 8-K", config: { forms: ["8-K"] } },
  { type: "rss", name: "Federal Reserve press releases", config: { url: "https://www.federalreserve.gov/feeds/press_all.xml" }, weight: 1.1 },
  { type: "federal-register", name: "Federal Register: rules", config: { documentTypes: ["RULE", "PRORULE"] } },
  { type: "hackernews", name: "Hacker News (100+ points)", config: { minPoints: 100 }, weight: 0.8 },
  { type: "google-news", name: "Google News: markets", config: { query: "stocks OR markets OR earnings when:1d" } },
  { type: "push", name: "Inbound (POST /ingest)", config: {} },
  // Primary sources behind the preset trades.
  { type: "rss", name: "SEC press releases", config: { url: "https://www.sec.gov/news/pressreleases.rss" }, weight: 1.1 },
  { type: "rss", name: "CFTC press releases", config: { url: "https://www.cftc.gov/RSS/RSSGP/rssgp.xml" }, weight: 1.1 },
  { type: "rss", name: "White House presidential actions", config: { url: "https://www.whitehouse.gov/presidential-actions/feed/" }, weight: 1.1 },
  { type: "rss", name: "White House news", config: { url: "https://www.whitehouse.gov/news/feed/" } },
  {
    type: "rss",
    name: "Federal Register: Commerce BIS (export controls)",
    config: { url: "https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bagencies%5D%5B%5D=industry-and-security-bureau" },
    weight: 1.1,
  },
  { type: "rss", name: "NRC news releases", config: { url: "https://www.nrc.gov/public-involve/rss?feed=news" } },
  { type: "rss", name: "EIA Today in Energy", config: { url: "https://www.eia.gov/rss/todayinenergy.xml" }, weight: 0.9 },
  news("AI infra", '("data center" OR hyperscaler OR "AI capex" OR Nvidia OR HBM)'),
  news("crypto policy", '(stablecoin OR "CLARITY Act" OR "crypto bill" OR "SEC crypto" OR "bitcoin ETF")'),
  news("rates & curve", '("Treasury yields" OR "yield curve" OR "term premium" OR "Treasury auction" OR "Fed rate cut")'),
  news("power & nuclear", '("power demand" OR "nuclear power" OR "power purchase agreement" OR uranium OR "small modular reactor")'),
  news("tariffs & reshoring", '(tariffs OR reshoring OR "trade deal" OR "Section 232")'),
  news("gold & dollar", '("gold price" OR "central bank gold" OR "de-dollarization" OR "dollar index")'),
];
