#!/usr/bin/env tsx
/**
 * CERT-SE / MSB Ingestion Crawler
 *
 * Crawls CERT-SE (https://www.cert.se) for cybersecurity advisories,
 * vulnerability warnings, weekly newsletters, and guidance articles.
 * Also crawls MSB/MCF publications for cybersecurity guidance documents.
 *
 * Data sources:
 *   1. CERT-SE news archive  — paginated at /nyheter/page/{N}/index.html (67+ pages)
 *   2. CERT-SE article pages — individual articles at /{YYYY}/{MM}/{slug}.html
 *   3. MSB/MCF publications  — guidance documents at mcf.se/sv/publikationer/
 *
 * Populates three tables: advisories, guidance, frameworks (see src/db.ts).
 *
 * Usage:
 *   npx tsx scripts/ingest-cert-se.ts
 *   npx tsx scripts/ingest-cert-se.ts --resume
 *   npx tsx scripts/ingest-cert-se.ts --dry-run
 *   npx tsx scripts/ingest-cert-se.ts --force
 *   npx tsx scripts/ingest-cert-se.ts --max-pages 5
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["MSB_DB_PATH"] ?? "data/msb.db";
const STATE_PATH = join(dirname(DB_PATH), "ingest-state.json");

const CERT_SE_BASE = "https://www.cert.se";
const CERT_SE_NEWS = `${CERT_SE_BASE}/nyheter/`;
const MCF_PUBLICATIONS = "https://www.mcf.se/sv/publikationer/";

const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const USER_AGENT =
  "Swedish-Cybersecurity-MCP/0.1.0 (https://github.com/Ansvar-Systems/swedish-cybersecurity-mcp)";

// Article types — classified by URL slug and content patterns
const VECKOBREV_PATTERN = /veckobrev/i;
const PATCH_TUESDAY_PATTERN = /patchtisdag/i;
const BLIXTMEDDELANDE_PATTERN = /blixtmeddelande/i;

// Severity keywords for classification
const SEVERITY_KEYWORDS: Record<string, string[]> = {
  critical: ["kritisk", "cvss 9", "cvss 10", "critical", "maximal"],
  high: ["allvarlig", "cvss 7", "cvss 8", "high", "hög"],
  medium: ["medel", "cvss 4", "cvss 5", "cvss 6", "medium"],
  low: ["låg", "low", "cvss 1", "cvss 2", "cvss 3"],
};

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const resume = args.includes("--resume");
const force = args.includes("--force");
const maxPagesArg = args.find((a) => a.startsWith("--max-pages"));
const maxPages = maxPagesArg ? parseInt(maxPagesArg.split("=")[1] ?? args[args.indexOf("--max-pages") + 1] ?? "0", 10) : 0;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ArticleListEntry {
  title: string;
  url: string;
  date: string;
  summary: string;
  tags: string[];
}

interface ArticleDetail {
  title: string;
  url: string;
  date: string;
  summary: string;
  fullText: string;
  tags: string[];
  affectedProducts: string[];
  cveReferences: string[];
  severity: string | null;
  sources: string[];
  sections: Record<string, string>;
}

interface IngestState {
  lastPage: number;
  processedUrls: string[];
  lastRun: string;
}

interface IngestStats {
  pagesScanned: number;
  articlesFound: number;
  articlesProcessed: number;
  advisoriesInserted: number;
  guidanceInserted: number;
  skipped: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

function loadState(): IngestState {
  if (existsSync(STATE_PATH)) {
    try {
      return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as IngestState;
    } catch {
      log("WARN", "Could not parse state file, starting fresh");
    }
  }
  return { lastPage: 0, processedUrls: [], lastRun: "" };
}

function saveState(state: IngestState): void {
  const dir = dirname(STATE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level: string, message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`);
}

function logProgress(stats: IngestStats): void {
  log(
    "INFO",
    `Progress: ${stats.pagesScanned} pages | ${stats.articlesFound} found | ` +
      `${stats.articlesProcessed} processed | ${stats.advisoriesInserted} advisories | ` +
      `${stats.guidanceInserted} guidance | ${stats.skipped} skipped | ${stats.errors} errors`,
  );
}

// ---------------------------------------------------------------------------
// HTTP fetch with retry
// ---------------------------------------------------------------------------

async function fetchWithRetry(url: string, attempt = 1): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "sv-SE,sv;q=0.9,en;q=0.5",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
    }

    return await response.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (attempt < MAX_RETRIES) {
      const delay = RETRY_BACKOFF_MS * attempt;
      log("WARN", `Attempt ${attempt}/${MAX_RETRIES} failed for ${url}: ${message}. Retrying in ${delay}ms...`);
      await sleep(delay);
      return fetchWithRetry(url, attempt + 1);
    }
    throw new Error(`Failed after ${MAX_RETRIES} attempts for ${url}: ${message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// CERT-SE news listing parser
// ---------------------------------------------------------------------------

function parseNewsListingPage(html: string): ArticleListEntry[] {
  const $ = cheerio.load(html);
  const articles: ArticleListEntry[] = [];

  // CERT-SE lists articles as <li> elements with timestamps, linked titles,
  // summary text, and category tags
  $("li").each((_i, el) => {
    const $el = $(el);
    const $link = $el.find("a").first();
    const href = $link.attr("href");
    const title = $link.text().trim();

    if (!href || !title || !href.match(/\/\d{4}\/\d{2}\//)) {
      return; // skip non-article list items
    }

    // Extract date from the text content (format: YYYY-MM-DD HH:MM)
    const dateMatch = $el.text().match(/(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}/);
    const date = dateMatch?.[1] ?? "";

    // Extract summary — text after the link, before tags
    const fullText = $el.text().trim();
    const titleIdx = fullText.indexOf(title);
    let summary = "";
    if (titleIdx >= 0) {
      const afterTitle = fullText.substring(titleIdx + title.length).trim();
      // Remove date prefix if present
      summary = afterTitle.replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s*/, "").trim();
    }

    // Extract tags from text patterns (tags appear as category labels)
    const tags: string[] = [];
    const tagPatterns = [
      "Veckobrev", "Sårbarhet", "Rekommendationer", "Patchtisdag",
      "Blixtmeddelande", "MISP-SE",
    ];
    for (const tag of tagPatterns) {
      if (fullText.includes(tag)) tags.push(tag);
    }

    const url = href.startsWith("http") ? href : `${CERT_SE_BASE}${href}`;
    articles.push({ title, url, date, summary, tags });
  });

  return articles;
}

/**
 * Determine total page count from pagination links on the news page.
 */
function parseTotalPages(html: string): number {
  const $ = cheerio.load(html);
  let maxPage = 1;

  // Look for pagination links with page numbers
  $("a[href*='/nyheter/page/']").each((_i, el) => {
    const href = $(el).attr("href") ?? "";
    const pageMatch = href.match(/\/nyheter\/page\/(\d+)\//);
    if (pageMatch?.[1]) {
      const page = parseInt(pageMatch[1], 10);
      if (page > maxPage) maxPage = page;
    }
  });

  return maxPage;
}

// ---------------------------------------------------------------------------
// CERT-SE article detail parser
// ---------------------------------------------------------------------------

function parseArticlePage(html: string, url: string): ArticleDetail {
  const $ = cheerio.load(html);

  // Title: main h1
  const title = $("h1").first().text().trim();

  // Date: look for "Publicerad: YYYY-MM-DD" or date pattern in the page
  let date = "";
  const dateMatch = $.text().match(/(?:Publicerad|Uppdaterad):\s*(\d{4}-\d{2}-\d{2})/);
  if (dateMatch?.[1]) {
    date = dateMatch[1];
  } else {
    // Fall back to URL date pattern /YYYY/MM/
    const urlDateMatch = url.match(/\/(\d{4})\/(\d{2})\//);
    if (urlDateMatch?.[1] && urlDateMatch?.[2]) {
      date = `${urlDateMatch[1]}-${urlDateMatch[2]}-01`;
    }
  }

  // Parse sections by h2 headings
  const sections: Record<string, string> = {};
  let currentSection = "introduction";
  const sectionTexts: string[] = [];

  // Collect the main content — everything after h1, before footer/sidebar
  const bodyElements = $("h1").first().parent().children();
  let collectContent = false;
  const allTextParts: string[] = [];

  bodyElements.each((_i, el) => {
    const $el = $(el);
    const tagName = ("name" in el ? (el.name as string) : "").toLowerCase();

    if (tagName === "h1") {
      collectContent = true;
      return;
    }

    if (!collectContent) return;

    if (tagName === "h2") {
      if (sectionTexts.length > 0) {
        sections[currentSection] = sectionTexts.join("\n").trim();
      }
      currentSection = $el.text().trim().toLowerCase();
      sectionTexts.length = 0;
      return;
    }

    const text = $el.text().trim();
    if (text) {
      sectionTexts.push(text);
      allTextParts.push(text);
    }
  });

  // Save last section
  if (sectionTexts.length > 0) {
    sections[currentSection] = sectionTexts.join("\n").trim();
  }

  // If the above method yielded nothing, fall back to broader text extraction
  let fullText = allTextParts.join("\n\n").trim();
  if (!fullText) {
    // Broader fallback: get all paragraph text from the page body
    const paragraphs: string[] = [];
    $("p, li, h2, h3").each((_i, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 10) paragraphs.push(text);
    });
    fullText = paragraphs.join("\n\n").trim();
  }

  // Extract summary — first meaningful paragraph or the introduction section
  const introText = sections["introduction"] ?? "";
  const summary = introText
    ? introText.split("\n")[0]?.trim() ?? ""
    : fullText.split("\n")[0]?.trim() ?? "";

  // Extract CVE references
  const cveReferences: string[] = [];
  const cveMatches = fullText.matchAll(/CVE-\d{4}-\d{4,}/g);
  for (const match of cveMatches) {
    if (!cveReferences.includes(match[0])) {
      cveReferences.push(match[0]);
    }
  }

  // Extract affected products from "Påverkade produkter" section
  const affectedProducts: string[] = [];
  const affectedSection = sections["påverkade produkter"] ?? sections["berörda produkter"] ?? "";
  if (affectedSection) {
    const productLines = affectedSection.split("\n").filter((l) => l.trim());
    for (const line of productLines) {
      const cleaned = line.replace(/^[-•*]\s*/, "").trim();
      if (cleaned) affectedProducts.push(cleaned);
    }
  }

  // Determine severity from content
  const severity = classifySeverity(fullText);

  // Extract source URLs from "Källor" section
  const sources: string[] = [];
  $("a[href^='http']").each((_i, el) => {
    const href = $(el).attr("href");
    if (href && !href.includes("cert.se")) {
      sources.push(href);
    }
  });

  // Extract tags from page content
  const tags: string[] = [];
  if (VECKOBREV_PATTERN.test(title) || VECKOBREV_PATTERN.test(url)) tags.push("Veckobrev");
  if (PATCH_TUESDAY_PATTERN.test(title)) tags.push("Patchtisdag");
  if (BLIXTMEDDELANDE_PATTERN.test(fullText)) tags.push("Blixtmeddelande");
  if (cveReferences.length > 0) tags.push("Sårbarhet");

  return {
    title,
    url,
    date,
    summary,
    fullText,
    tags,
    affectedProducts,
    cveReferences,
    severity,
    sources,
    sections,
  };
}

function classifySeverity(text: string): string | null {
  const lower = text.toLowerCase();

  // Check for explicit CVSS scores first
  const cvssMatch = lower.match(/cvss[:\s]+(\d+(?:\.\d+)?)/);
  if (cvssMatch?.[1]) {
    const score = parseFloat(cvssMatch[1]);
    if (score >= 9.0) return "critical";
    if (score >= 7.0) return "high";
    if (score >= 4.0) return "medium";
    return "low";
  }

  // Fall back to keyword matching
  for (const [severity, keywords] of Object.entries(SEVERITY_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lower.includes(keyword)) return severity;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Article classification — advisory vs guidance
// ---------------------------------------------------------------------------

type ArticleType = "advisory" | "guidance" | "veckobrev" | "skip";

function classifyArticle(entry: ArticleListEntry, detail: ArticleDetail): ArticleType {
  const title = detail.title.toLowerCase();
  const tags = detail.tags.map((t) => t.toLowerCase());

  // Weekly newsletters are stored as guidance (informational content)
  if (tags.includes("veckobrev") || VECKOBREV_PATTERN.test(title)) {
    return "veckobrev";
  }

  // Vulnerability warnings and blixtmeddelanden are advisories
  if (
    tags.includes("sårbarhet") ||
    tags.includes("blixtmeddelande") ||
    detail.cveReferences.length > 0 ||
    title.includes("sårbarhet") ||
    title.includes("sarbarhet") ||
    title.includes("nolldagssårbarhet") ||
    title.includes("nolldagssarbarhet") ||
    PATCH_TUESDAY_PATTERN.test(title)
  ) {
    return "advisory";
  }

  // Guidance articles — recommendations, best practices, general advice
  if (
    title.includes("rekommendation") ||
    title.includes("råd") ||
    title.includes("vägledning") ||
    title.includes("vagledning") ||
    title.includes("säkerhet i") ||
    title.includes("sakerhet i") ||
    tags.includes("rekommendationer")
  ) {
    return "guidance";
  }

  // Default: treat as guidance (general informational content)
  return "guidance";
}

// ---------------------------------------------------------------------------
// Reference ID generation
// ---------------------------------------------------------------------------

function generateReference(url: string, date: string, title: string): string {
  // Extract year/month from URL pattern /YYYY/MM/slug.html
  const urlMatch = url.match(/\/(\d{4})\/(\d{2})\/([^/.]+)/);
  if (urlMatch?.[1] && urlMatch?.[2] && urlMatch?.[3]) {
    const slug = urlMatch[3]
      .replace(/-/g, " ")
      .replace(/\s+/g, "-")
      .substring(0, 40);
    return `CERT-SE-${urlMatch[1]}-${urlMatch[2]}-${slug}`;
  }

  // Fallback: use date and sanitized title
  const dateStr = date.replace(/-/g, "");
  const titleSlug = title
    .toLowerCase()
    .replace(/[^a-z0-9åäö]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 40);
  return `CERT-SE-${dateStr}-${titleSlug}`;
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function initDb(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    log("INFO", `Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function insertAdvisory(
  db: Database.Database,
  detail: ArticleDetail,
  reference: string,
): boolean {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO advisories
     (reference, title, date, severity, affected_products, summary, full_text, cve_references)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const result = stmt.run(
    reference,
    detail.title,
    detail.date || null,
    detail.severity,
    detail.affectedProducts.length > 0
      ? JSON.stringify(detail.affectedProducts)
      : null,
    detail.summary || null,
    detail.fullText,
    detail.cveReferences.length > 0
      ? JSON.stringify(detail.cveReferences)
      : null,
  );

  return result.changes > 0;
}

function insertGuidance(
  db: Database.Database,
  detail: ArticleDetail,
  reference: string,
  type: string,
  series: string,
): boolean {
  const topics = detail.tags.length > 0 ? JSON.stringify(detail.tags) : null;

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO guidance
     (reference, title, title_en, date, type, series, summary, full_text, topics, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const result = stmt.run(
    reference,
    detail.title,
    null, // title_en — not available from Swedish source
    detail.date || null,
    type,
    series,
    detail.summary || null,
    detail.fullText,
    topics,
    "current",
  );

  return result.changes > 0;
}

function upsertFrameworks(db: Database.Database): void {
  const frameworks = [
    {
      id: "cert-se-advisories",
      name: "CERT-SE Säkerhetsvarningar",
      name_en: "CERT-SE Security Advisories",
      description:
        "Säkerhetsvarningar och blixtmeddelanden från CERT-SE, " +
        "Sveriges nationella CSIRT. Inkluderar varningar om kritiska " +
        "sårbarheter, aktivt exploaterade säkerhetsbrister och rekommenderade åtgärder.",
    },
    {
      id: "cert-se-veckobrev",
      name: "CERT-SE Veckobrev",
      name_en: "CERT-SE Weekly Newsletters",
      description:
        "CERT-SE:s veckobrev med samlad omvärldsbevakning inom " +
        "cybersäkerhet. Publiceras varje fredag med nyheter, rapporter " +
        "och analyser från nationella och internationella källor.",
    },
    {
      id: "cert-se-guidance",
      name: "CERT-SE Rekommendationer",
      name_en: "CERT-SE Recommendations & Guidance",
      description:
        "Rekommendationer och vägledningar från CERT-SE om " +
        "cybersäkerhetsåtgärder, säker konfiguration och " +
        "förebyggande arbete mot cyberhot.",
    },
    {
      id: "msb-guidance",
      name: "MSB Vägledningar",
      name_en: "MSB Guidance Publications",
      description:
        "Vägledningar och rekommendationer från Myndigheten för " +
        "samhällsskydd och beredskap (MSB) inom informationssäkerhet, " +
        "cybersäkerhet och skydd av samhällsviktig verksamhet.",
    },
    {
      id: "msbfs",
      name: "MSBFS Föreskrifter",
      name_en: "MSB Regulations (MSBFS)",
      description:
        "MSB:s bindande föreskrifter (MSBFS) om informationssäkerhet " +
        "för statliga myndigheter. Grundar sig i förordningen om " +
        "informationssäkerhet för statliga myndigheter (2015:1052).",
    },
    {
      id: "nis2-se",
      name: "NIS2 i Sverige",
      name_en: "NIS2 Directive Implementation in Sweden",
      description:
        "MSB är kompetent myndighet och nationell CSIRT för " +
        "NIS2-direktivet (Direktiv (EU) 2022/2555) i Sverige. " +
        "Vägledning för verksamheter som omfattas av NIS2.",
    },
  ];

  const stmt = db.prepare(
    `INSERT OR REPLACE INTO frameworks (id, name, name_en, description, document_count)
     VALUES (?, ?, ?, ?, 0)`,
  );

  for (const f of frameworks) {
    stmt.run(f.id, f.name, f.name_en, f.description);
  }

  log("INFO", `Upserted ${frameworks.length} frameworks`);
}

function updateFrameworkCounts(db: Database.Database): void {
  // Count advisories for cert-se-advisories
  const advisoryCount = (
    db.prepare("SELECT count(*) as cnt FROM advisories").get() as { cnt: number }
  ).cnt;

  // Count veckobrev in guidance
  const veckobrevCount = (
    db
      .prepare("SELECT count(*) as cnt FROM guidance WHERE series = 'CERT-SE-Veckobrev'")
      .get() as { cnt: number }
  ).cnt;

  // Count CERT-SE guidance
  const certGuidanceCount = (
    db
      .prepare("SELECT count(*) as cnt FROM guidance WHERE series = 'CERT-SE'")
      .get() as { cnt: number }
  ).cnt;

  // Count MSB guidance
  const msbGuidanceCount = (
    db
      .prepare("SELECT count(*) as cnt FROM guidance WHERE series = 'MSB'")
      .get() as { cnt: number }
  ).cnt;

  // Count MSBFS
  const msbfsCount = (
    db
      .prepare("SELECT count(*) as cnt FROM guidance WHERE series = 'MSBFS'")
      .get() as { cnt: number }
  ).cnt;

  // Count NIS2
  const nis2Count = (
    db
      .prepare("SELECT count(*) as cnt FROM guidance WHERE series = 'NIS2-SE'")
      .get() as { cnt: number }
  ).cnt;

  const update = db.prepare("UPDATE frameworks SET document_count = ? WHERE id = ?");
  update.run(advisoryCount, "cert-se-advisories");
  update.run(veckobrevCount, "cert-se-veckobrev");
  update.run(certGuidanceCount, "cert-se-guidance");
  update.run(msbGuidanceCount, "msb-guidance");
  update.run(msbfsCount, "msbfs");
  update.run(nis2Count, "nis2-se");
}

// ---------------------------------------------------------------------------
// Crawl orchestration
// ---------------------------------------------------------------------------

async function crawlCertSeNewsList(
  page: number,
): Promise<{ articles: ArticleListEntry[]; totalPages: number }> {
  const url =
    page === 1
      ? CERT_SE_NEWS
      : `${CERT_SE_BASE}/nyheter/page/${page}/index.html`;

  log("INFO", `Fetching news listing page ${page}: ${url}`);
  const html = await fetchWithRetry(url);
  const articles = parseNewsListingPage(html);
  const totalPages = page === 1 ? parseTotalPages(html) : 0;

  log("INFO", `Page ${page}: found ${articles.length} articles`);
  return { articles, totalPages };
}

async function crawlArticle(url: string): Promise<ArticleDetail> {
  log("INFO", `Fetching article: ${url}`);
  const html = await fetchWithRetry(url);
  return parseArticlePage(html, url);
}

async function main(): Promise<void> {
  log("INFO", "=== CERT-SE / MSB Ingestion Crawler ===");
  log("INFO", `Database: ${DB_PATH}`);
  log("INFO", `Mode: ${dryRun ? "DRY RUN" : force ? "FORCE (fresh DB)" : resume ? "RESUME" : "NORMAL"}`);

  if (maxPages > 0) {
    log("INFO", `Max pages: ${maxPages}`);
  }

  // Initialize database (unless dry run)
  let db: Database.Database | null = null;
  if (!dryRun) {
    db = initDb();
    upsertFrameworks(db);
  }

  // Load resume state
  const state = resume ? loadState() : { lastPage: 0, processedUrls: [] as string[], lastRun: "" };
  const startPage = resume ? Math.max(state.lastPage, 1) : 1;

  const stats: IngestStats = {
    pagesScanned: 0,
    articlesFound: 0,
    articlesProcessed: 0,
    advisoriesInserted: 0,
    guidanceInserted: 0,
    skipped: 0,
    errors: 0,
  };

  // Phase 1: Discover all articles from the CERT-SE news archive
  log("INFO", "--- Phase 1: Crawling CERT-SE news archive ---");

  let totalPages = 0;
  let currentPage = startPage;

  // Fetch first page to get total page count
  {
    const result = await crawlCertSeNewsList(1);
    totalPages = result.totalPages || 67; // fallback to known count
    if (maxPages > 0) totalPages = Math.min(totalPages, maxPages);
    log("INFO", `Total pages to crawl: ${totalPages} (starting from page ${startPage})`);
  }

  await sleep(RATE_LIMIT_MS);

  // Collect all article URLs from listing pages
  const allArticles: ArticleListEntry[] = [];

  for (currentPage = startPage; currentPage <= totalPages; currentPage++) {
    try {
      const result = await crawlCertSeNewsList(currentPage);
      allArticles.push(...result.articles);
      stats.pagesScanned++;

      // Save state after each page
      if (!dryRun) {
        state.lastPage = currentPage;
        state.lastRun = new Date().toISOString();
        saveState(state);
      }

      if (currentPage % 10 === 0) {
        logProgress(stats);
      }

      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("ERROR", `Failed to fetch page ${currentPage}: ${message}`);
      stats.errors++;

      // Save state so we can resume from this page
      if (!dryRun) {
        state.lastPage = currentPage - 1;
        saveState(state);
      }
    }
  }

  stats.articlesFound = allArticles.length;
  log("INFO", `Phase 1 complete: found ${allArticles.length} articles across ${stats.pagesScanned} pages`);

  // Phase 2: Fetch each article detail page and insert into DB
  log("INFO", "--- Phase 2: Fetching article details and populating database ---");

  const processedSet = new Set(state.processedUrls);

  for (let i = 0; i < allArticles.length; i++) {
    const entry = allArticles[i]!;

    // Skip already processed articles (resume mode)
    if (processedSet.has(entry.url)) {
      stats.skipped++;
      continue;
    }

    try {
      const detail = await crawlArticle(entry.url);

      if (!detail.fullText || detail.fullText.length < 20) {
        log("WARN", `Skipping article with insufficient content: ${entry.title}`);
        stats.skipped++;
        continue;
      }

      const articleType = classifyArticle(entry, detail);
      const reference = generateReference(entry.url, detail.date, detail.title);

      if (dryRun) {
        log(
          "DRY-RUN",
          `Would insert ${articleType}: ${reference} — ${detail.title} (${detail.date})`,
        );
        stats.articlesProcessed++;
        if (articleType === "advisory") stats.advisoriesInserted++;
        else stats.guidanceInserted++;
      } else if (db) {
        let inserted = false;

        switch (articleType) {
          case "advisory":
            inserted = insertAdvisory(db, detail, reference);
            if (inserted) stats.advisoriesInserted++;
            break;
          case "veckobrev":
            inserted = insertGuidance(db, detail, reference, "newsletter", "CERT-SE-Veckobrev");
            if (inserted) stats.guidanceInserted++;
            break;
          case "guidance":
            inserted = insertGuidance(db, detail, reference, "guidance", "CERT-SE");
            if (inserted) stats.guidanceInserted++;
            break;
          case "skip":
            stats.skipped++;
            break;
        }

        if (inserted) {
          stats.articlesProcessed++;
        } else if (articleType !== "skip") {
          stats.skipped++; // duplicate (already in DB)
        }

        // Track processed URL for resume
        state.processedUrls.push(entry.url);
        if (i % 20 === 0) {
          saveState(state);
        }
      }

      // Progress log every 25 articles
      if ((i + 1) % 25 === 0) {
        logProgress(stats);
      }

      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("ERROR", `Failed to process article ${entry.url}: ${message}`);
      stats.errors++;
    }
  }

  // Phase 3: Update framework document counts
  if (db && !dryRun) {
    log("INFO", "--- Phase 3: Updating framework counts ---");
    updateFrameworkCounts(db);
    saveState(state);
  }

  // Final summary
  log("INFO", "=== Ingestion complete ===");
  logProgress(stats);

  if (db && !dryRun) {
    const guidanceCount = (
      db.prepare("SELECT count(*) as cnt FROM guidance").get() as { cnt: number }
    ).cnt;
    const advisoryCount = (
      db.prepare("SELECT count(*) as cnt FROM advisories").get() as { cnt: number }
    ).cnt;
    const frameworkCount = (
      db.prepare("SELECT count(*) as cnt FROM frameworks").get() as { cnt: number }
    ).cnt;

    log("INFO", "Database totals:");
    log("INFO", `  Frameworks:  ${frameworkCount}`);
    log("INFO", `  Guidance:    ${guidanceCount}`);
    log("INFO", `  Advisories:  ${advisoryCount}`);

    db.close();
  }

  log("INFO", `Database at ${DB_PATH}`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  log("FATAL", `Ingestion failed: ${message}`);
  process.exit(1);
});
