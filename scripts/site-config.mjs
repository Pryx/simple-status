#!/usr/bin/env node
// Builds the Wrangler config for your own site: wrangler.jsonc (the defaults, in the
// repository) with wrangler.site.jsonc (your settings, not in the repository) merged
// over it, written to wrangler.site.json. Without wrangler.site.jsonc it's a copy.
//
// Merging: objects are merged key by key; arrays of objects with a "binding" (D1, R2)
// are merged by binding; any other value, arrays included, replaces the default.
//
//   node scripts/site-config.mjs && npx wrangler deploy -c wrangler.site.json

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { imageSize } from "image-size";

const BASE = "wrangler.jsonc";
const SITE = "wrangler.site.jsonc";
const OUT = "wrangler.site.json";

/** JSON with comments and trailing commas, as Wrangler accepts it. */
export function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      // Copy a string as it is, escapes included.
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      if (i === 0) throw new Error("Unterminated comment");
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

export function merge(base, override) {
  if (isObject(base) && isObject(override)) {
    const result = { ...base };
    for (const [key, value] of Object.entries(override)) result[key] = merge(base[key], value);
    return result;
  }
  const byBinding = (list) => Array.isArray(list) && list.every((x) => isObject(x) && x.binding);
  if (byBinding(base) && byBinding(override)) {
    const result = base.map((item) => {
      const match = override.find((o) => o.binding === item.binding);
      return match ? merge(item, match) : item;
    });
    for (const o of override) if (!base.some((b) => b.binding === o.binding)) result.push(o);
    return result;
  }
  return override;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = parseJsonc(readFileSync(BASE, "utf8"));
  const site = existsSync(SITE) ? parseJsonc(readFileSync(SITE, "utf8")) : {};
  const config = merge(base, site);
  // The logo's size, so its width and height go into the page and nothing jumps while
  // it loads. Files are under public/, like SITE_LOGO itself.
  for (const [logo, sizeVar] of [
    ["SITE_LOGO", "SITE_LOGO_SIZE"],
    ["SITE_LOGO_DARK", "SITE_LOGO_DARK_SIZE"],
  ]) {
    const path = (config.vars?.[logo] ?? "").trim().replace(/^\/+/, "");
    if (!path) continue;
    const file = `public/${path}`;
    if (!existsSync(file)) {
      console.error(`${logo}: ${file} doesn't exist.`);
      process.exitCode = 1;
      continue;
    }
    try {
      const { width, height } = imageSize(readFileSync(file));
      config.vars[sizeVar] = `${width}x${height}`;
    } catch {
      console.error(`${logo}: couldn't read the size of ${file}; it may shift while loading.`);
    }
  }
  // The generated file sits next to wrangler.jsonc, so relative paths still work.
  config.$schema = "node_modules/wrangler/config-schema.json";
  writeFileSync(OUT, `${JSON.stringify(config, null, 2)}\n`);
  console.error(existsSync(SITE) ? `${OUT}: ${BASE} with ${SITE}` : `${OUT}: ${BASE} (no ${SITE})`);
}
