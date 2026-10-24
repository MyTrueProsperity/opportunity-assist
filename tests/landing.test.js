"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync("index.html", "utf8");

test("every in-page link has a target and every structured-data block is valid JSON", () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const [, ref] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(ref), "missing #" + ref);
  for (const [, block] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) JSON.parse(block);
});

test("the share image the page advertises exists at the advertised size", () => {
  assert.match(html, /og:image" content="https:\/\/opportunityassist\.com\/assets\/og-image\.png"/);
  const png = fs.readFileSync("assets/og-image.png");
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});

test("open signup: pricing is visible, CTAs lead to the app, and no free Enterprise offer is advertised", () => {
  assert.match(html, /id="pricing"/);
  assert.match(html, /\$149<small> \/ month/);
  assert.match(html, /\$249<small> \/ month/);
  assert.match(html, /class="btn btn-primary nav-cta" href="\/app\.html">Start free/);
  assert.doesNotMatch(html, /founding cohort|Request early access/);
  assert.doesNotMatch(html, /"price": "0"/);
});

test("claims match the product: no knowledge base, no partnerships factor, Grant Factory is described", () => {
  assert.doesNotMatch(html, /Knowledge Base|required partnerships|team assignments|school district, and CRA sources/);
  assert.match(html, /Grant Factory/);
  assert.doesNotMatch(html, /—/, "no em dashes");
});
