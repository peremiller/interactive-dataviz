#!/usr/bin/env node
/**
 * Build concerns.csv from live r/Accenture data using Reddit's OAuth API.
 *
 * Reddit blocks anonymous JSON now, so this uses application-only OAuth
 * (no user login). One-time setup:
 *   1. Go to https://www.reddit.com/prefs/apps  →  "create another app"
 *   2. Choose type "script", set redirect uri to http://localhost
 *   3. Copy the client id (under the app name) and the secret.
 *   4. Export them before running:
 *        export REDDIT_CLIENT_ID=xxxx
 *        export REDDIT_CLIENT_SECRET=yyyy
 *   5. node fetch-concerns.mjs        (writes concerns.csv)
 *
 * Offline test:  node fetch-concerns.mjs --fixture sample-posts.json
 *
 * Scores are heuristics derived from public post signals, not official metrics:
 *   controversy = how divisive (low upvote-ratio + high comment density)
 *   trend       = momentum (recent activity vs the prior window)
 *   volume      = relative discussion share (summed score)
 */

import { writeFileSync, readFileSync } from "node:fs";

const SUB = "Accenture";
const OUT = "concerns.csv";

// Theme buckets: a post is matched to every theme whose keywords appear in title+body.
const THEMES = [
  { title: "AI 'use it or lose it' mandate", tags: ["AI","promotion"],
    kw: ["ai ","genai","gen ai","copilot","use it or lose it","reskill","automation","chatgpt","llm"] },
  { title: "Forced-ranking performance ratings", tags: ["ratings","promotion"],
    kw: ["rating","appraisal","performance review","bell curve","forced rank","promo","promotion","cip","feedback"] },
  { title: "Layoffs & job security", tags: ["layoffs","restructuring"],
    kw: ["layoff","laid off","fired","job security","rif","severance","let go","job cut","restructur"] },
  { title: "Pay, raises & shrinking bonuses", tags: ["pay","bonus"],
    kw: ["pay","salary","raise","bonus","comp ","underpaid","hike","increment","promotion cycle"] },
  { title: "The bench / rolled off a project", tags: ["bench","staffing"],
    kw: ["bench","rolled off","no project","unstaffed","on beach","staffing","roll off","between project"] },
  { title: "Manager & project lottery", tags: ["staffing","management"],
    kw: ["manager","supervisor","career counselor","bad project","toxic project","people lead"] },
  { title: "Overwork & burnout (understaffing)", tags: ["burnout","workload"],
    kw: ["burnout","overwork","long hours","overtime","work life","wlb","stress","understaff","workload"] },
  { title: "Onboarding & access bureaucracy", tags: ["onboarding","process"],
    kw: ["onboarding","access","vetting","laptop","provisioning","bureaucracy","vpn","credentials"] },
];

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i+1] : null; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const iso = (utc) => new Date(utc * 1000).toISOString().slice(0, 10);

async function getToken() {
  const id = process.env.REDDIT_CLIENT_ID, secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) {
    console.error("✗ Missing REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET. See the header of this file for setup.");
    process.exit(1);
  }
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "dataviz-concerns/1.0 by peremiller",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) { console.error("✗ Token request failed:", res.status, await res.text()); process.exit(1); }
  return (await res.json()).access_token;
}

async function fetchListing(token, path) {
  const res = await fetch(`https://oauth.reddit.com${path}`, {
    headers: { "Authorization": `Bearer ${token}`, "User-Agent": "dataviz-concerns/1.0 by peremiller" },
  });
  if (!res.ok) { console.error("✗ Fetch failed:", path, res.status); process.exit(1); }
  return (await res.json()).data.children.map(c => c.data);
}

async function getPosts() {
  const fixture = arg("--fixture");
  if (fixture) {
    console.log("• Using fixture:", fixture);
    return JSON.parse(readFileSync(fixture, "utf8"));
  }
  const token = await getToken();
  const [yearTop, monthTop, recent] = await Promise.all([
    fetchListing(token, `/r/${SUB}/top?t=year&limit=100`),
    fetchListing(token, `/r/${SUB}/top?t=month&limit=100`),
    fetchListing(token, `/r/${SUB}/new?limit=100`),
  ]);
  // De-dupe by id.
  const byId = new Map();
  [...yearTop, ...monthTop, ...recent].forEach(p => byId.set(p.id, p));
  return [...byId.values()];
}

function score(theme, posts) {
  const text = p => `${p.title} ${p.selftext || ""}`.toLowerCase();
  const matched = posts.filter(p => theme.kw.some(k => text(p).includes(k)));
  if (!matched.length) return null;

  const now = Date.now() / 1000, DAY = 86400;
  const recent = matched.filter(p => now - p.created_utc <= 30 * DAY);
  const prior  = matched.filter(p => now - p.created_utc > 30 * DAY && now - p.created_utc <= 60 * DAY);

  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const totalScore = sum(matched, p => p.score || 0);

  // controversy: divisiveness from upvote ratio (0.5 ratio ≈ max) + comment density, score-weighted
  const wControv = sum(matched, p => ((1 - (p.upvote_ratio ?? 1)) * 200) * (p.score || 1)) / Math.max(1, totalScore);
  const commentDensity = sum(matched, p => (p.num_comments || 0)) / Math.max(1, totalScore); // comments per upvote
  const controversy = clamp(Math.round(0.7 * wControv + 0.3 * clamp(commentDensity * 60, 0, 100)), 0, 100);

  // trend: recent window activity vs prior window
  const recentAct = sum(recent, p => (p.score || 0) + (p.num_comments || 0));
  const priorAct  = sum(prior,  p => (p.score || 0) + (p.num_comments || 0));
  const trend = clamp(Math.round(100 * (recentAct - priorAct) / Math.max(1, priorAct)), -100, 100);

  const newest = matched.reduce((a, p) => p.created_utc > a.created_utc ? p : a);
  const top = matched.reduce((a, p) => (p.score || 0) > (a.score || 0) ? p : a);

  return {
    title: theme.title, tags: theme.tags,
    controversy, trend, _rawVolume: totalScore,
    date: iso(newest.created_utc),
    desc: (top.title || "").replace(/\s+/g, " ").slice(0, 160),
    _matches: matched.length,
  };
}

function toCsv(rows) {
  const cols = ["title","desc","controversy","trend","volume","date","tags"];
  const esc = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : v;
  const body = rows.map(r => [r.title, r.desc, r.controversy, r.trend, r.volume, r.date, r.tags.join(";")].map(esc).join(","));
  return cols.join(",") + "\n" + body.join("\n");
}

(async () => {
  const posts = await getPosts();
  console.log(`• ${posts.length} unique posts pulled`);
  let rows = THEMES.map(t => score(t, posts)).filter(Boolean);
  if (!rows.length) { console.error("✗ No themes matched any posts."); process.exit(1); }

  // Normalize volume to 0-100 across themes.
  const maxVol = Math.max(...rows.map(r => r._rawVolume), 1);
  rows.forEach(r => r.volume = Math.round(100 * r._rawVolume / maxVol));
  rows.sort((a, b) => b.controversy - a.controversy);

  writeFileSync(OUT, toCsv(rows));
  console.log(`✓ Wrote ${OUT} with ${rows.length} concerns:`);
  rows.forEach(r => console.log(`   ${String(r.controversy).padStart(3)}  ${r.trend>=0?"+":""}${r.trend}%  ${r._matches} posts  ${r.title}`));
  console.log("\nNext: deploy it →  npm run deploy \"Refresh concerns from live r/Accenture\"");
})();
