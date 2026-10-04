// CI check: the committed generated API types must equal a fresh generation from contracts/openapi.json.
import { readFileSync, rmSync } from "node:fs";
const [committed, fresh] = process.argv.slice(2);
const same = readFileSync(committed, "utf8") === readFileSync(fresh, "utf8");
rmSync(fresh);
if (!same) {
  console.error(`${committed} is stale: run npm run gen:api`);
  process.exit(1);
}
console.log("API types in sync with contracts/openapi.json");
