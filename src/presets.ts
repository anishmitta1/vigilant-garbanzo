import type { NewSource, NewTheme, NewTrade, Store } from "./db.js";

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

/** Entities and pillars (axioms) for each preset trade, keyed by trade name. */
export const PRESET_PILLARS: Record<string, Pick<NewTrade, "entities" | "pillars">> = {
  "AI infra buildout": {
    entities: [
      { name: "Nvidia", aliases: ["NVDA"] },
      { name: "Broadcom", aliases: ["AVGO"] },
      { name: "TSMC", aliases: ["TSM", "Taiwan Semiconductor"] },
      { name: "AMD", aliases: ["Advanced Micro Devices"] },
      { name: "Micron", aliases: ["MU"] },
      { name: "Microsoft", aliases: ["MSFT", "Azure"] },
      { name: "Meta", aliases: ["META", "Facebook"] },
      { name: "Alphabet", aliases: ["Google", "GOOGL"] },
      { name: "Amazon", aliases: ["AWS", "AMZN"] },
      { name: "Oracle", aliases: ["ORCL"] },
      { name: "CoreWeave", aliases: ["CRWV"] },
      { name: "OpenAI", aliases: [] },
      { name: "Anthropic", aliases: [] },
      { name: "xAI", aliases: [] },
      { name: "Commerce Department", aliases: ["BIS", "Bureau of Industry and Security"] },
    ],
    pillars: [
      {
        statement: "AI capex compounds.",
        signals: [
          { description: "A top-4 hyperscaler raises capex guidance, or an AI lab announces a multi-$10B compute commitment", effect: "majorly_supports" },
          { description: "A large new data-center or compute deal (at least $1B)", effect: "slightly_supports" },
          { description: "Capex guided flat, or a data-center project paused or delayed", effect: "slightly_falsifies" },
          { description: "A top-4 hyperscaler cuts capex guidance, or a major lab cancels or cuts compute commitments", effect: "majorly_falsifies" },
        ],
      },
      {
        statement: "Compute is scarce.",
        signals: [
          { description: "A supplier says it is sold out or supply-constrained into next year", effect: "majorly_supports" },
          { description: "Price cuts, inventory build-up, or glut/oversupply commentary from Nvidia, TSMC or memory makers", effect: "majorly_falsifies" },
        ],
      },
      {
        statement: "Suppliers capture the spend.",
        signals: [
          { description: "Nvidia, TSMC, Broadcom or Micron beat and raise", effect: "majorly_supports" },
          { description: "A major supplier guides down on AI demand", effect: "majorly_falsifies" },
        ],
      },
      {
        statement: "The biggest markets stay open.",
        signals: [
          { description: "Export licenses granted or restrictions eased", effect: "slightly_supports" },
          { description: "New export bans or restrictions on AI chips to major buyers", effect: "majorly_falsifies" },
        ],
      },
    ],
  },
  "Crypto clarity": {
    entities: [
      { name: "SEC", aliases: ["Securities and Exchange Commission"] },
      { name: "CFTC", aliases: ["Commodity Futures Trading Commission"] },
      { name: "Congress", aliases: ["Senate Banking Committee", "House Financial Services Committee"] },
      { name: "Coinbase", aliases: ["COIN"] },
      { name: "Robinhood", aliases: ["HOOD"] },
      { name: "Strategy", aliases: ["MicroStrategy", "MSTR"] },
      { name: "Circle", aliases: ["CRCL", "USDC"] },
      { name: "Tether", aliases: ["USDT"] },
      { name: "BlackRock", aliases: ["IBIT"] },
    ],
    pillars: [
      {
        statement: "Crypto law gets written.",
        signals: [
          { description: "A market-structure or stablecoin bill passes a chamber or is signed into law", effect: "majorly_supports" },
          { description: "A crypto bill clears committee", effect: "slightly_supports" },
          { description: "A crypto bill fails or stalls indefinitely", effect: "majorly_falsifies" },
        ],
      },
      {
        statement: "Regulators accommodate crypto.",
        signals: [
          { description: "ETF approvals, enforcement cases dropped, or charters granted", effect: "majorly_supports" },
          { description: "A new major enforcement action or crackdown", effect: "majorly_falsifies" },
        ],
      },
      {
        statement: "Institutions keep buying.",
        signals: [
          { description: "Record ETF inflows, or a major institution launches crypto products", effect: "slightly_supports" },
          { description: "A major exchange hack, a stablecoin depeg, or record outflows", effect: "majorly_falsifies" },
        ],
      },
    ],
  },
  "Yield curve unwinding": {
    entities: [
      { name: "Federal Reserve", aliases: ["Fed", "FOMC"] },
      { name: "US Treasury", aliases: ["Treasury Department"] },
      { name: "Congressional Budget Office", aliases: ["CBO"] },
    ],
    pillars: [
      {
        statement: "The Fed eases the front end.",
        signals: [
          { description: "A larger-than-expected rate cut, or a dovish shift in guidance", effect: "majorly_supports" },
          { description: "A rate hike, or the Fed signals the end of cuts or hikes ahead", effect: "majorly_falsifies" },
        ],
      },
      {
        statement: "Long-end supply outruns demand.",
        signals: [
          { description: "A larger refunding or coupon issuance, or a notably weak long-end auction", effect: "majorly_supports" },
          { description: "Issuance cut or shifted to bills, buybacks expanded, or a strong long-end auction", effect: "majorly_falsifies" },
        ],
      },
      {
        statement: "Deficits stay large.",
        signals: [
          { description: "A deficit-widening bill passes, or a CBO upward revision", effect: "slightly_supports" },
          { description: "A credible deficit-reduction deal", effect: "slightly_falsifies" },
        ],
      },
      {
        statement: "The long end is left to the market.",
        signals: [
          { description: "A recession signal or flight to safety pulls long yields sharply down", effect: "slightly_falsifies" },
          { description: "Yield-curve control or explicit long-end suppression", effect: "majorly_falsifies" },
        ],
      },
    ],
  },
  "Power & nuclear demand": {
    entities: [
      { name: "Constellation Energy", aliases: ["CEG", "Constellation"] },
      { name: "Vistra", aliases: ["VST"] },
      { name: "Talen Energy", aliases: ["TLN"] },
      { name: "NRG", aliases: [] },
      { name: "GE Vernova", aliases: ["GEV"] },
      { name: "Oklo", aliases: ["OKLO"] },
      { name: "NuScale", aliases: ["SMR"] },
      { name: "Cameco", aliases: ["CCJ"] },
      { name: "BWXT", aliases: ["BWX Technologies"] },
      { name: "NRC", aliases: ["Nuclear Regulatory Commission"] },
      { name: "FERC", aliases: ["Federal Energy Regulatory Commission"] },
      { name: "Department of Energy", aliases: ["DOE"] },
      { name: "PJM", aliases: [] },
      { name: "ERCOT", aliases: [] },
      { name: "Alphabet", aliases: ["Google", "GOOGL"] },
      { name: "Microsoft", aliases: ["MSFT"] },
      { name: "Amazon", aliases: ["AWS", "AMZN"] },
      { name: "Meta", aliases: ["META"] },
    ],
    pillars: [
      {
        statement: "Power demand grows structurally.",
        signals: [
          { description: "A grid operator or major utility raises its load forecast materially, or capacity auction prices hit a record", effect: "majorly_supports" },
          { description: "Load forecasts cut, or big data-center loads withdrawn", effect: "majorly_falsifies" },
        ],
      },
      {
        statement: "Big buyers pay for firm power.",
        signals: [
          { description: "A hyperscaler signs a multi-year PPA or nuclear deal (restart, uprate, SMR)", effect: "majorly_supports" },
          { description: "A major PPA cancelled or renegotiated down, or hyperscalers move to self-supply that bypasses IPPs", effect: "majorly_falsifies" },
        ],
      },
      {
        statement: "New generation gets built.",
        signals: [
          { description: "NRC approves a license or restart, or DOE funds nuclear", effect: "majorly_supports" },
          { description: "FERC rejects co-location deals, a license is denied, or capacity prices are capped", effect: "majorly_falsifies" },
        ],
      },
      {
        statement: "Equipment makers set the price.",
        signals: [
          { description: "Record turbine or grid-equipment orders or backlog", effect: "slightly_supports" },
          { description: "Order cancellations or margin pressure at equipment makers", effect: "slightly_falsifies" },
        ],
      },
    ],
  },
  "Tariffs & reshoring": {
    entities: [
      { name: "White House", aliases: ["President Trump", "Trump administration"] },
      { name: "USTR", aliases: ["US Trade Representative"] },
      { name: "Commerce Department", aliases: [] },
      { name: "Supreme Court", aliases: ["Court of International Trade", "CIT"] },
      { name: "Caterpillar", aliases: ["CAT"] },
      { name: "Eaton", aliases: ["ETN"] },
      { name: "Rockwell Automation", aliases: ["ROK"] },
      { name: "Nucor", aliases: ["NUE"] },
      { name: "Steel Dynamics", aliases: ["STLD"] },
      { name: "Parker-Hannifin", aliases: ["PH"] },
      { name: "Emerson", aliases: ["EMR"] },
    ],
    pillars: [
      {
        statement: "Tariffs persist.",
        signals: [
          { description: "New or higher tariffs imposed (Section 232/301 etc.)", effect: "majorly_supports" },
          { description: "Tariffs struck down by courts, broadly paused, or cut in a trade deal", effect: "majorly_falsifies" },
        ],
      },
      {
        statement: "Capacity comes home.",
        signals: [
          { description: "A large (at least $1B) US factory investment announced", effect: "majorly_supports" },
          { description: "A US plant cancelled or delayed", effect: "slightly_falsifies" },
        ],
      },
      {
        statement: "Industrial policy keeps paying.",
        signals: [
          { description: "CHIPS- or IRA-style grants awarded", effect: "slightly_supports" },
          { description: "Industrial-policy programs repealed or funding clawed back", effect: "majorly_falsifies" },
        ],
      },
    ],
  },
  "Gold & de-dollarization": {
    entities: [
      { name: "People's Bank of China", aliases: ["PBoC"] },
      { name: "Reserve Bank of India", aliases: ["RBI"] },
      { name: "World Gold Council", aliases: ["WGC"] },
      { name: "BRICS", aliases: [] },
      { name: "US Treasury", aliases: [] },
      { name: "Federal Reserve", aliases: ["Fed"] },
    ],
    pillars: [
      {
        statement: "Central banks accumulate gold.",
        signals: [
          { description: "A central bank announces large purchases, or WGC reports record official buying", effect: "majorly_supports" },
          { description: "A major central bank sells gold reserves", effect: "majorly_falsifies" },
        ],
      },
      {
        statement: "The dollar's reserve role erodes.",
        signals: [
          { description: "Sanctions expand, the US is downgraded, or a fiscal-crisis headline", effect: "slightly_supports" },
          { description: "A major non-dollar settlement initiative is abandoned, or a strong safe-haven dollar rally", effect: "majorly_falsifies" },
        ],
      },
      {
        statement: "Real yields stay contained.",
        signals: [
          { description: "Real yields rise sharply", effect: "slightly_falsifies" },
        ],
      },
    ],
  },
};

/** Give preset trades created before pillars existed their default pillars and entities, once. */
export async function addPresetPillars(store: Store): Promise<void> {
  for (const t of await store.listTrades()) {
    const defaults = t.preset ? PRESET_PILLARS[t.name] : undefined;
    if (!defaults || t.pillars.length > 0) continue;
    for (const p of defaults.pillars ?? []) await store.addPillar(t.id, p);
    if (t.entities.length === 0) await store.setTradeEntities(t.id, defaults.entities ?? []);
  }
}

const news = (name: string, query: string): NewSource => ({
  type: "google-news",
  name: `Google News: ${name}`,
  config: { query: `${query} when:1d` },
  // Aggregated, repetitive coverage: weigh below primary sources.
  weight: 0.7,
});

const wire = (name: string, url: string): NewSource => ({
  type: "rss",
  name: `${name}: all releases`,
  config: { url, triage: true },
  pollIntervalSeconds: 60,
});

/** Former defaults that seeding disables on existing databases. */
export const RETIRED_SOURCES = [
  // Market-wide 8-Ks: every filer's filing went to the model; replaced by the watched-company feed.
  "SEC EDGAR: latest 8-K",
  // Wires filtered to watched names missed releases from unwatched companies; replaced by triaged "all releases" feeds.
  "PR Newswire: watched companies",
  "GlobeNewswire: watched companies",
  "Business Wire earnings: watched companies",
];

export const DEFAULT_SOURCES: NewSource[] = [
  // First disclosures, polled every minute. 8-K titles carry only the filer name, so they're filtered to watched companies;
  // wire releases are screened by one batched triage call per poll.
  { type: "sec-edgar", name: "SEC EDGAR: watched-company 8-K", config: { forms: ["8-K"], count: 100, watchedOnly: true }, pollIntervalSeconds: 60 },
  wire("PR Newswire", "https://www.prnewswire.com/rss/news-releases-list.rss"),
  wire("GlobeNewswire", "https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies"),
  wire("Business Wire earnings", "https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJeEF9YXA=="),
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
