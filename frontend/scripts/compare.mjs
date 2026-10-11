// CI check: the committed generated API types must equal a fresh generation from contracts/openapi.json.
import { readFileSync, rmSync } from "node:fs";
const [committed, fresh] = process.argv.slice(2);
// Git can check out CRLF on Windows while the generator writes LF. Compare content, not checkout line endings.
const readNormalized = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const same = readNormalized(committed) === readNormalized(fresh);
rmSync(fresh);
if (!same) {
  console.error(`${committed} is stale: run npm run gen:api`);
  process.exit(1);
}
console.log("API types in sync with contracts/openapi.json");
