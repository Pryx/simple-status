#!/usr/bin/env node
// Converts a Server Status v2 mysqldump into SQL for simple-status.
//
//   node scripts/import-v2.mjs v2-dump.sql > import.sql
//
// The report goes to stderr. Try the result locally first:
//   npx wrangler d1 execute DB --local --file=import.sql
// then import it into the (empty) production database:
//   npx wrangler d1 execute DB --remote --file=import.sql
// Don't commit the dump or the result: they hold your users' data.

import { readFileSync } from "node:fs";
import { convert, parseDump } from "./v2/import.ts";

const [path] = process.argv.slice(2);
if (!path) {
  console.error("Usage: node scripts/import-v2.mjs <mysqldump.sql> > import.sql");
  process.exit(1);
}

const tables = parseDump(readFileSync(path, "utf8"));
const result = await convert(tables, Math.floor(Date.now() / 1000));
process.stdout.write(result.sql);

const { services, incidents, updates } = result.counts;
console.error(`Converted ${services} services, ${incidents} incidents and ${updates} updates.`);
for (const line of result.report) console.error(`- ${line}`);
