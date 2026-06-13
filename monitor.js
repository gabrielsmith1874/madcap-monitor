const cheerio = require("cheerio");
const nodemailer = require("nodemailer");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  /** URL to scrape for product listings */
  productsUrl: "https://retail.madcapdeals.com/products?sort_by=latest&per_page=24",

  /** Base URL for building absolute product links */
  baseUrl: "https://retail.madcapdeals.com",

  /** Polling interval in milliseconds (default: 5 minutes) */
  pollIntervalMs: 300_000,

  /** Path to the JSON file where known products are persisted */
  stateFile: path.join(process.env.STATE_DIR || __dirname, "products.json"),

  /** User-Agent sent with every request */
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",

  // ── Email Settings ──────────────────────────────────────────────────────
  // Set via environment variables (or `fly secrets set` when deployed).
  // Locally, you can create a .env file or pass them inline:
  //   EMAIL_FROM=you@gmail.com EMAIL_PASS="xxxx xxxx xxxx xxxx" EMAIL_TO=you@gmail.com node monitor.js
  email: {
    from: process.env.EMAIL_FROM || "",
    appPassword: process.env.EMAIL_PASS || "",
    to: process.env.EMAIL_TO || "",
  },
};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(message) {
  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: true });
  console.log(`[${timestamp}] ${message}`);
}

function logError(message, error) {
  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: true });
  console.error(`[${timestamp}] ❌ ${message}`, error?.message || "");
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function loadKnownProducts() {
  try {
    if (fs.existsSync(CONFIG.stateFile)) {
      const data = fs.readFileSync(CONFIG.stateFile, "utf-8");
      return JSON.parse(data);
    }
  } catch (err) {
    logError("Failed to load state file, starting fresh", err);
  }
  return {};
}

function saveKnownProducts(products) {
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(products, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Scraping
// ---------------------------------------------------------------------------

/**
 * Fetches the products page and parses product cards from the HTML.
 * Returns an array of { slug, title, price, imageUrl, productUrl }.
 */
async function fetchProducts() {
  const response = await fetch(CONFIG.productsUrl, {
    headers: { "User-Agent": CONFIG.userAgent },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const products = [];

  $(".product-card").each((_i, card) => {
    const $card = $(card);
    if ($card.find(".sold-ribbon").length > 0) return;

    // The product link is the overlay anchor or the thumb link
    const linkEl =
      $card.find("a.card-overlay-link").first().attr("href")
        ? $card.find("a.card-overlay-link").first()
        : $card.find("a.product-thumb-link").first();
    const href = linkEl.attr("href") || "";

    // Extract the slug from the URL (last path segment)
    const slug = href.split("/").filter(Boolean).pop() || "";
    if (!slug || slug === "null" || !href.includes("/product/")) return; // skip invalid cards

    // Product title — inside .product-title-link or .title a
    const title =
      $card.find("a.product-title-link").text().trim() ||
      $card.find(".title a").text().trim() ||
      slug;

    // Price — the first text node in .price (before <del>)
    const priceText = $card.find(".price").first().contents().first().text().trim();

    // Image — prefer data-src (lazy-loaded) over src
    const imgEl = $card.find(".product-thumb img").first();
    const imageUrl = imgEl.attr("data-src") || imgEl.attr("src") || "";

    // Full product URL
    const productUrl = href.startsWith("http") ? href : `${CONFIG.baseUrl}${href}`;

    products.push({ slug, title, price: priceText, imageUrl, productUrl });
  });

  return products;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: CONFIG.email.from,
    pass: CONFIG.email.appPassword,
  },
});

function assertEmailConfigured() {
  const missing = [];
  if (!CONFIG.email.from) missing.push("EMAIL_FROM");
  if (!CONFIG.email.appPassword) missing.push("EMAIL_PASS");
  if (!CONFIG.email.to) missing.push("EMAIL_TO");

  if (missing.length > 0) {
    throw new Error(`Missing email configuration: ${missing.join(", ")}`);
  }
}

/**
 * Sends a single email listing all newly detected products.
 */
async function emailNewProducts(products) {
  assertEmailConfigured();

  const productRows = products
    .map(
      (p) =>
        `<tr>
          <td style="padding:12px;border-bottom:1px solid #eee">
            <a href="${p.productUrl}" style="color:#1a73e8;font-weight:600;text-decoration:none;font-size:15px">${p.title}</a>
            <br/><span style="color:#555;font-size:14px">${p.price}</span>
          </td>
        </tr>`
    )
    .join("");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
      <h2 style="color:#222">🆕 ${products.length} New Product${products.length > 1 ? "s" : ""} on Madcap Deals</h2>
      <table style="width:100%;border-collapse:collapse">${productRows}</table>
      <p style="margin-top:20px;font-size:13px;color:#999">
        <a href="${CONFIG.productsUrl}" style="color:#999">View all products</a>
      </p>
    </div>
  `;

  const subject =
    products.length === 1
      ? `Madcap Deals: ${products[0].title}`
      : `Madcap Deals: ${products.length} new products`;

  await transporter.sendMail({
    from: CONFIG.email.from,
    to: CONFIG.email.to,
    subject,
    html,
  });

  log(`📧 Email sent to ${CONFIG.email.to} — ${products.length} product(s)`);
}

// ---------------------------------------------------------------------------
// Main polling loop
// ---------------------------------------------------------------------------

async function poll(knownProducts, isFirstRun, options = {}) {
  try {
    const products = await fetchProducts();

    if (products.length === 0) {
      log("⚠️  No products found on page — possible scrape failure or site change");
      return knownProducts;
    }

    if (isFirstRun) {
      // First run: record everything without alerting
      log(`📋 Initial scan: found ${products.length} products. Saving baseline...`);
      for (const p of products) {
        knownProducts[p.slug] = {
          title: p.title,
          price: p.price,
          productUrl: p.productUrl,
          firstSeen: new Date().toISOString(),
        };
      }
      saveKnownProducts(knownProducts);
      return knownProducts;
    }

    // Subsequent runs: diff and notify
    const newProducts = [];
    for (const p of products) {
      if (!knownProducts[p.slug]) {
        newProducts.push(p);

        knownProducts[p.slug] = {
          title: p.title,
          price: p.price,
          productUrl: p.productUrl,
          firstSeen: new Date().toISOString(),
        };
      }
    }

    if (newProducts.length > 0) {
      await emailNewProducts(newProducts);
      saveKnownProducts(knownProducts);
      log(`✅ ${newProducts.length} new product(s) detected and saved`);
    } else {
      log(`✅ No new products (${products.length} on page, ${Object.keys(knownProducts).length} known)`);
    }

    return knownProducts;
  } catch (err) {
    logError("Poll failed", err);
    if (options.throwOnError) {
      throw err;
    }
    return knownProducts;
  }
}

async function main() {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║         Madcap Deals — New Product Monitor          ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log("");
  log(`Monitoring: ${CONFIG.productsUrl}`);
  log(`Poll interval: ${CONFIG.pollIntervalMs / 1000}s`);
  log(`State file: ${CONFIG.stateFile}`);
  console.log("");

  let knownProducts = loadKnownProducts();
  const isFirstRun = Object.keys(knownProducts).length === 0;

  if (!isFirstRun) {
    log(`Loaded ${Object.keys(knownProducts).length} known products from state file`);
  }

  const runOnce = process.argv.includes("--once") || process.env.ONCE === "true";
  if (runOnce) {
    assertEmailConfigured();
  }

  // Initial poll
  knownProducts = await poll(knownProducts, isFirstRun, { throwOnError: runOnce });

  if (runOnce) {
    log("Single run complete, exiting.");
    return;
  }

  // Schedule recurring polls
  setInterval(async () => {
    knownProducts = await poll(knownProducts, false);
  }, CONFIG.pollIntervalMs);

  // Health check server (keeps Render free tier alive when pinged)
  const port = process.env.PORT || 3000;
  http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "running",
      knownProducts: Object.keys(knownProducts).length,
      uptime: Math.floor(process.uptime()),
    }));
  }).listen(port, () => {
    log(`Health check listening on port ${port}`);
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err) => {
  logError("Fatal error", err);
  process.exit(1);
});
