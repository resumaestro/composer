/**
 * src/skills/researchCompany.ts
 *
 * Migrates the legacy `job-research` skill's scraping step to Cloudflare
 * Browser Rendering via the official `@cloudflare/puppeteer` API.
 *
 * Session discipline (Step 3): launch, navigate, harvest the structural text
 * in a single page.evaluate, then close immediately. The browser is never held
 * open across embedding/vector work — `close()` runs in a finally block so the
 * session is released even if harvesting throws.
 */

import puppeteer from "@cloudflare/puppeteer";
import config from "../../config/agentConfig.json";
import type { CompanyResearch, Env, ScrapedPage } from "../types.js";
import { clamp } from "../lib/text.js";

const BROWSER_CFG = config.browser;

/**
 * Launches a constrained browser session, scrapes the target URL, and returns
 * structured page text. Closes the session before returning.
 */
export async function scrapePage(env: Env, url: string): Promise<ScrapedPage> {
  const browser = await puppeteer.launch(env.MY_BROWSER);
  try {
    const page = await browser.newPage();
    await page.setUserAgent(BROWSER_CFG.userAgent);
    await page.goto(url, {
      waitUntil: BROWSER_CFG.waitUntil as "domcontentloaded",
      timeout: BROWSER_CFG.navigationTimeoutMs,
    });

    // Runs in the page (browser) context. We reach DOM globals through
    // globalThis so the worker's TS project does not need the DOM lib.
    const harvested = await page.evaluate(
      (maxChars: number, maxHeadings: number) => {
        const doc = (globalThis as unknown as { document: any }).document;
        const textOf = (sel: string): string[] =>
          Array.from(doc.querySelectorAll(sel) as ArrayLike<any>)
            .map((el: any) => (el.textContent || "").trim())
            .filter((t: string) => t.length > 0);

        const metaEl = doc.querySelector('meta[name="description"]');
        const ogEl = doc.querySelector('meta[property="og:description"]');

        return {
          title: String(doc.title || ""),
          metaDescription: String(
            (metaEl && metaEl.getAttribute("content")) ||
              (ogEl && ogEl.getAttribute("content")) ||
              "",
          ),
          headings: textOf("h1, h2, h3").slice(0, maxHeadings),
          bodyText: String((doc.body && doc.body.innerText) || "").slice(0, maxChars),
          jsonLd: Array.from(
            doc.querySelectorAll('script[type="application/ld+json"]') as ArrayLike<any>,
          )
            .map((s: any) => String(s.textContent || "").trim())
            .filter((t: string) => t.length > 0)
            .slice(0, 5),
        };
      },
      BROWSER_CFG.maxTextChars,
      BROWSER_CFG.maxHeadings,
    );

    return {
      url,
      title: harvested.title,
      metaDescription: harvested.metaDescription,
      headings: harvested.headings,
      bodyText: harvested.bodyText,
      jsonLd: harvested.jsonLd,
      scrapedAt: new Date().toISOString(),
    };
  } finally {
    // Always release the edge browser session.
    await browser.close();
  }
}

/** Condenses scraped page text into a compact, framing-only research summary. */
function summarize(company: string, page: ScrapedPage): string {
  const parts: string[] = [`Company: ${company}`];
  if (page.title) parts.push(`Page title: ${page.title}`);
  if (page.metaDescription) parts.push(`Description: ${page.metaDescription}`);
  if (page.headings.length > 0) {
    parts.push(`Key sections: ${page.headings.slice(0, 20).join(" | ")}`);
  }
  if (page.bodyText) {
    parts.push(`Excerpt: ${clamp(page.bodyText, 1500)}`);
  }
  return parts.join("\n");
}

/**
 * Full research step: scrape the company/posting URL and build a worker-shaped
 * CompanyResearch payload. The coordinator is responsible for caching the result.
 */
export async function researchCompany(
  env: Env,
  company: string,
  url: string,
): Promise<CompanyResearch> {
  const page = await scrapePage(env, url);
  return {
    company,
    source: "browser",
    page,
    summary: summarize(company, page),
  };
}
