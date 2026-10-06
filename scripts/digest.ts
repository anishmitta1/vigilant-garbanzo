// Print the digest Mimir would send now, from DATABASE_URL. Pass --send to push it to BARK_URL, --no-market to skip prices.
import { loadConfig } from "../src/config.js";
import { openStore } from "../src/db.js";
import { composeDigest, deliverDigestBark } from "../src/digest.js";

const config = loadConfig();
const store = await openStore(config.databaseUrl, config.tursoAuthToken);
const hours = Number(process.env.DIGEST_HOURS ?? 24);
const now = new Date();
const since = new Date(now.getTime() - hours * 3600_000).toISOString();
const digest = await composeDigest(store, now, config.digestTimeZone, since, { market: !process.argv.includes("--no-market") });
console.log(`${digest.title}\n${digest.subtitle}\n\n${digest.body}\n\n(${digest.body.length} chars)`);
if (process.argv.includes("--send")) {
  if (!config.barkUrl) throw new Error("BARK_URL is not set");
  await deliverDigestBark(config.barkUrl, digest);
  console.log("sent to Bark");
}
