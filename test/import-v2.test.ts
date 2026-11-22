import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { cleanText, convert, parseDump } from "../scripts/v2/import.ts";
import { scheduledPublish } from "../src/publish";
import { publishedJson } from "./helpers";

// Times in v2 are Unix seconds.
const T0 = Date.UTC(2026, 5, 1, 10) / 1000;
const T1 = Date.UTC(2026, 6, 1, 10) / 1000;
const T2 = Date.UTC(2026, 7, 1, 10) / 1000;
const T3 = Date.UTC(2026, 8, 1, 10) / 1000;
const NOW = Date.UTC(2026, 10, 1) / 1000;

/** A cut-down mysqldump of a v2 database, in mysqldump's own format. */
const DUMP = `
CREATE TABLE \`services\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`name\` varchar(50) NOT NULL,
  \`description\` varchar(200) NOT NULL,
  \`group_id\` int(11) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
INSERT INTO \`services\` VALUES (1,'Website &amp; CDN','Main site',1),(2,'API','REST &lt;v1&gt;',NULL),(3,'Email','',NULL);

CREATE TABLE \`services_groups\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`name\` varchar(50) NOT NULL,
  \`description\` varchar(50) DEFAULT NULL,
  \`visibility\` tinyint(4) NOT NULL
) ENGINE=InnoDB;
INSERT INTO \`services_groups\` VALUES (1,'Web',NULL,1);

CREATE TABLE \`users\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`email\` varchar(60) NOT NULL,
  \`username\` varchar(50) NOT NULL
) ENGINE=InnoDB;
INSERT INTO \`users\` VALUES (1,'alice@example.com','alice');

CREATE TABLE \`status\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`type\` int(11) NOT NULL,
  \`title\` varchar(50) NOT NULL,
  \`text\` text NOT NULL,
  \`time\` int(11) NOT NULL,
  \`end_time\` int(11) NOT NULL,
  \`user_id\` int(11) NOT NULL
) ENGINE=InnoDB;
INSERT INTO \`status\` VALUES (1,1,'It\\'s slow','Investigating<br>more soon',${String(T0)},0,1),(2,3,'Resolved','All good',${String(T0 + 3600)},0,1),(3,0,'Outage','Down',${String(T1)},0,1),(4,3,'Website back','',${String(T1 + 600)},0,1);
INSERT INTO \`status\` VALUES (5,3,'Email back','Queue sent',${String(T1 + 1200)},0,1),(6,2,'Upgrade','',${String(T2)},${String(T2 + 3600)},1),(7,1,'Still broken','',${String(T3)},0,1),(8,3,'Stray','',${String(T0 + 7200)},0,1),(9,1,'Unlinked','',${String(T0 - 60)},0,1);

CREATE TABLE \`services_status\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`service_id\` int(11) NOT NULL,
  \`status_id\` int(11) NOT NULL
) ENGINE=InnoDB;
INSERT INTO \`services_status\` VALUES (1,2,1),(2,2,2),(3,1,3),(4,3,3),(5,1,4),(6,3,5),(7,1,6),(8,3,7),(9,2,8);

CREATE TABLE \`subscribers\` (
  \`subscriberID\` int(11) NOT NULL AUTO_INCREMENT,
  \`userID\` varchar(200) NOT NULL
) ENGINE=InnoDB;
INSERT INTO \`subscribers\` VALUES (1,'bob@example.com'),(2,'12345');

CREATE TABLE \`settings\` (
  \`setting\` varchar(255) NOT NULL,
  \`value\` varchar(255) NOT NULL
) ENGINE=InnoDB;
INSERT INTO \`settings\` VALUES ('name','Acme &amp; Co status'),('url','https://status.acme.example');
`;

interface Imported {
  title: string;
  impact: string;
  state: string;
  ends_at: string | null;
  body: string;
  updates: { status: string; body: string }[];
}

describe("v2 import", () => {
  it("reads mysqldump rows, including escapes", () => {
    const tables = parseDump(DUMP);
    expect(tables["status"]).toHaveLength(9);
    expect(tables["status"]?.[0]).toMatchObject({ id: 1, title: "It's slow", end_time: 0 });
    expect(tables["settings"]?.[0]).toEqual({ setting: "name", value: "Acme &amp; Co status" });
  });

  it("converts services, incidents and updates, and loads into the schema", async () => {
    const result = await convert(parseDump(DUMP), NOW);
    expect(result.counts).toEqual({ services: 3, incidents: 5, updates: 3 });

    const statements = result.sql
      .split("\n")
      .filter((line) => line && !line.startsWith("--"))
      .map((line) => env.DB.prepare(line));
    await env.DB.batch(statements);
    await scheduledPublish(env);

    // Unescaped names, in v2's order: by group (ungrouped first), then name.
    const { services } = await publishedJson<{ services: { name: string; description: string }[] }>(
      "api/v1/services",
    );
    expect(services.map((s) => s.name)).toEqual(
      ["API", "Email", "Website & CDN"].sort((a, b) =>
        a === "Website & CDN" ? 1 : b === "Website & CDN" ? -1 : a.localeCompare(b),
      ),
    );
    expect(services.find((s) => s.name === "API")?.description).toBe("REST <v1>");

    const incidents = await env.DB.prepare(
      "SELECT id, title, impact, ends_at FROM incidents ORDER BY starts_at",
    ).all<{ id: string; title: string; impact: string; ends_at: string | null }>();
    const byTitle = Object.fromEntries(incidents.results.map((i) => [i.title, i]));
    const get = (title: string) =>
      publishedJson<Imported>(`api/v1/incidents/${byTitle[title]?.id ?? ""}`);

    // Ended by the "Operational" post, which became its Ended update.
    const slow = await get("It's slow");
    expect(slow).toMatchObject({
      state: "ended",
      ends_at: new Date((T0 + 3600) * 1000).toISOString(),
    });
    expect(slow.body).toBe("Investigating\nmore soon");
    expect(slow.updates).toEqual([
      expect.objectContaining({ status: "ended", body: "Resolved\n\nAll good" }),
    ]);

    // Two services recovered at different times: an Update, then Ended.
    const outage = await get("Outage");
    expect(outage.ends_at).toBe(new Date((T1 + 1200) * 1000).toISOString());
    expect(outage.updates.map((u) => [u.status, u.body])).toEqual([
      ["ended", "Email back\n\nQueue sent"],
      ["update", "Website & CDN recovered.\n\nWebsite back"],
    ]);

    expect(await get("Upgrade")).toMatchObject({ impact: "maintenance", state: "ended" });

    // No services in v2: it gets those that existed then. It's older than every linked
    // incident, so it uses the first one's: ids up to 2 (API), so Website and API. Newer
    // outages on both services end it.
    const unlinked = await get("Unlinked");
    expect(unlinked).toMatchObject({ state: "ended" });
    const links = await env.DB.prepare(
      "SELECT s.name FROM incident_services l JOIN services s ON s.id = l.service_id WHERE l.incident_id = ?",
    )
      .bind(byTitle["Unlinked"]?.id ?? "")
      .all<{ name: string }>();
    expect(links.results.map((l) => l.name).sort()).toEqual(["API", "Website & CDN"]);
    expect(await get("Still broken")).toMatchObject({ state: "active", ends_at: null });

    // Authors are kept, and go into the activity log.
    const authors = await env.DB.prepare(
      "SELECT DISTINCT created_by FROM incidents UNION SELECT DISTINCT created_by FROM incident_updates",
    ).all<{ created_by: string }>();
    expect(authors.results).toEqual([{ created_by: "alice (v2)" }]);
    const actors = await env.DB.prepare("SELECT DISTINCT actor FROM activity").all<{
      actor: string;
    }>();
    expect(actors.results).toEqual([{ actor: "alice (v2)" }]);

    const report = result.report.join("\n");
    expect(report).toContain("still ongoing");
    expect(report).toContain('"Still broken"');
    expect(report).toContain('8 "Stray"');
    expect(report).toContain("2 subscriber(s)");
    expect(report).toContain('"Acme & Co status"');
  });

  it("handles old installs whose services have no description column", async () => {
    const old = `
CREATE TABLE \`services\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`name\` varchar(50) NOT NULL
) ENGINE=InnoDB;
INSERT INTO \`services\` VALUES (1,'Archive server');
`;
    const { sql } = await convert(parseDump(old), NOW);
    expect(sql).toContain("'Archive server', '', 0");
    expect(sql).not.toContain("undefined");
  });

  it("turns leftover HTML into Markdown", () => {
    expect(
      cleanText(
        'See <a href="https://example.com/x?a=1&b=2">the thread</a>.<br />More <b>soon</b>. <https://keep.example>',
      ),
    ).toBe("See [the thread](https://example.com/x?a=1&b=2).\nMore soon. <https://keep.example>");
  });

  it("gives the same ids every time, so a second import fails instead of duplicating", async () => {
    const a = await convert(parseDump(DUMP), NOW);
    const b = await convert(parseDump(DUMP), NOW);
    expect(a.sql).toBe(b.sql);
  });
});
