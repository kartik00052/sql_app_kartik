#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: node verify-links.mjs [index.html] [--links]");
  console.log("  (default)  verify every row against LeetCode; report mismatches/premium/missing");
  console.log("  --links    also request every unique LeetCode problem URL and report 404/410");
  process.exit(0);
}
const checkLinks = args.includes("--links");
const fileArg = args.find((a) => !a.startsWith("--"));
const file = fileArg ? path.resolve(fileArg) : path.resolve("index.html");

const html = fs.readFileSync(file, "utf8");
const start = html.indexOf("const SECTIONS=");
const end = html.indexOf("const FINAL50=", start);
if (start < 0 || end < 0) throw new Error("Could not find SECTIONS in " + file);
const block = html.slice(start + "const SECTIONS=".length, end).trim().replace(/;\s*$/, "");
const R = (t, lc, d, p, co, sk, nc, cx) => [t, lc, d, p, co, sk, nc, cx || ""];
const SECTIONS = new Function("R", "return " + block + ";")(R);
const rows = [];
for (const sec of SECTIONS) for (const r of sec.rows) rows.push({ title: r[0], lc: String(r[1]), d: r[2], pat: r[3], section: sec.name });

const ov = {};
const ovStart = html.indexOf("const SLUG_OV={");
const ovEnd = html.indexOf("};", ovStart);
if (ovStart >= 0 && ovEnd > ovStart) {
  const body = html.slice(ovStart + "const SLUG_OV=".length, ovEnd + 1);
  Object.assign(ov, new Function("return " + body)());
}
const slug = (t) => ov[t] || t.toLowerCase().replace(/[\u2019']/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const DIFFS = ["Easy", "Medium", "Hard"];

async function fetchAll() {
  const headers = {
    "content-type": "application/json",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    referer: "https://leetcode.com/problemset/",
  };
  try {
    const r = await fetch("https://leetcode.com/api/problems/all/", { headers });
    if (r.ok) {
      const j = await r.json();
      const stat = new Map();
      for (const p of j.stat_status_pairs || []) {
        const s = p.stat || {};
        const id = String(s.frontend_question_id ?? s.question_id);
        stat.set(id, {
          title: s.question__title,
          titleSlug: s.question__title_slug,
          difficulty: DIFFS[p.difficulty && p.difficulty.level ? p.difficulty.level - 1 : 1],
          paidOnly: !!p.paid_only,
          tags: [],
        });
      }
      if (stat.size) return { source: "public-api", questions: stat };
    }
  } catch {}

  const query = `query problemsetQuestionList($categorySlug:String,$limit:Int,$skip:Int,$filters:QuestionListFilterInput){problemsetQuestionList:questionList(categorySlug:$categorySlug,limit:$limit,skip:$skip,filters:$filters){total:totalNum questions:data{frontendQuestionId:questionFrontendId title titleSlug difficulty paidOnly:isPaidOnly topicTags{name slug}}}}`;
  const stat = new Map();
  let skip = 0, total = Infinity;
  while (skip < total) {
    const r = await fetch("https://leetcode.com/graphql", {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables: { categorySlug: "all-code-essentials", limit: 100, skip, filters: {} } }),
    });
    if (!r.ok) throw new Error("LeetCode GraphQL HTTP " + r.status + " (public API and GraphQL both unavailable)");
    const j = await r.json();
    const data = j?.data?.problemsetQuestionList;
    if (!data) throw new Error("LeetCode GraphQL returned no data: " + JSON.stringify(j).slice(0, 300));
    total = data.total || 0;
    for (const q of data.questions || []) {
      stat.set(String(q.frontendQuestionId), {
        title: q.title,
        titleSlug: q.titleSlug,
        difficulty: q.difficulty,
        paidOnly: !!q.paidOnly,
        tags: (q.topicTags || []).map((t) => t.slug),
      });
    }
    skip += (data.questions || []).length;
    if (!(data.questions || []).length) break;
  }
  return { source: "graphql", questions: stat };
}

function cmp(a, b) {
  return String(a || "").toLowerCase().replace(/[^a-z0-9]/g, "") === String(b || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const data = await fetchAll();
const used = new Set(rows.map((r) => r.lc));
const issues = [];

for (const row of rows) {
  const v = data.questions.get(row.lc);
  if (!v) {
    issues.push({ type: "missing", ...row });
    continue;
  }
  if (v.paidOnly) issues.push({ type: "premium", ...row, current: v.title });
  if (!cmp(row.title, v.title)) issues.push({ type: "title", ...row, current: v.title });
  const generated = slug(row.title);
  if (generated !== v.titleSlug) issues.push({ type: "slug", ...row, current: v.titleSlug, generated });
  if (DIFFS[row.d] !== v.difficulty) issues.push({ type: "difficulty", ...row, current: v.difficulty });
}

function replacementsFor(row) {
  const usedNow = new Set(used);
  const source = data.questions.get(row.lc);
  const tags = source?.tags || [];
  const wantDiff = DIFFS[row.d];
  const candidates = [];
  for (const [id, q] of data.questions) {
    if (usedNow.has(id) || q.paidOnly) continue;
    if (!q.tags.some((t) => tags.includes(t))) continue;
    const penalty = (q.difficulty === wantDiff ? 0 : 1) + (q.titleSlug ? 0 : 1);
    candidates.push({ id, title: q.title, difficulty: q.difficulty, slug: q.titleSlug, penalty });
  }
  candidates.sort((a, b) => a.penalty - b.penalty || a.title.localeCompare(b.title));
  return candidates.slice(0, 5);
}

const needReplacement = issues.filter((i) => i.type === "missing" || (i.type === "premium" && +i.lc >= 3000));
if (needReplacement.length) {
  console.log("\nRows needing replacement (missing or premium, LC id >= 3000):");
  for (const row of needReplacement) {
    const list = replacementsFor(row);
    console.log(`- LC ${row.lc} "${row.title}" [${row.section}; pattern ${row.pat}] -> ` + (list.length ? list.map((c) => `LC ${c.id} "${c.title}" (${c.difficulty})`).join(" | ") : "no same-tag free candidate found"));
  }
}

const byType = {};
for (const i of issues) {
  byType[i.type] = (byType[i.type] || 0) + 1;
}
console.log(`\nLeetCode data source: ${data.source}`);
console.log(`Rows checked: ${rows.length}`);
if (!issues.length) console.log("OK — every id/title/slug/difficulty matches verified LeetCode data and no row is premium.");
else {
  console.log("Issues: " + Object.entries(byType).map(([k, n]) => `${k}=${n}`).join(", "));
  for (const i of issues) {
    const extra = i.type === "slug" ? ` (generated ${i.generated}, verified ${i.current})` : i.current ? ` (verified: ${i.current})` : "";
    console.log(`- ${i.type.toUpperCase()} LC ${i.lc} "${i.title}"${extra}`);
  }
}

if (checkLinks) {
  const urls = [...new Set(rows.map((r) => `https://leetcode.com/problems/${slug(r.title)}/`))];
  console.log(`\nChecking ${urls.length} unique LeetCode problem URLs (concurrency 4)...`);
  let bad = 0;
  let idx = 0;
  async function worker() {
    while (idx < urls.length) {
      const url = urls[idx++];
      let status = 0;
      for (const method of ["HEAD", "GET"]) {
        try {
          const r = await fetch(url, { method, redirect: "follow", headers: { "user-agent": "Mozilla/5.0" } });
          status = r.status;
          if (status !== 405 && status !== 403) break;
        } catch {}
      }
      if (status === 404 || status === 410) {
        bad++;
        console.log(`- 404 ${url}`);
      }
    }
  }
  await Promise.all([0, 1, 2, 3].map(worker));
  console.log(bad ? `${bad} URL(s) returned 404/410` : "OK — no LeetCode URL returned 404/410.");
  if (bad) process.exitCode = 1;
}

if (issues.length) process.exitCode = 1;
