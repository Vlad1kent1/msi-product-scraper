const fs = require("fs/promises");
const path = require("path");
const { chromium } = require("playwright");

const PRODUCT_URL =
  "https://us-store.msi.com/Motherboards/Intel-Platform-Motherboard/INTEL-Z890/MAG-Z890-TOMAHAWK-WIFI";

const OUTPUT_PATH = path.join(__dirname, "..", "output", "product.json");
const NAVIGATION_TIMEOUT_MS = 45000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function normalizeText(value) {
  if (value == null) return null;
  const text = String(value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  return text || null;
}

function parsePrice(value) {
  const text = normalizeText(value);
  if (!text) return null;

  const match = text.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;

  const price = Number(match[0]);
  return Number.isFinite(price) ? price : null;
}

function parseRating(value) {
  const text = normalizeText(value);
  if (!text) return { starRating: null, reviewCount: null };

  const match = text.match(/(\d+(?:\.\d+)?)\s*\(\s*(\d+)\s*\)/);
  if (!match) return { starRating: null, reviewCount: null };

  return {
    starRating: Number(match[1]),
    reviewCount: Number(match[2]),
  };
}

function normalizeAvailability(value) {
  const text = normalizeText(value);
  if (!text) return null;

  const normalized = text.toLowerCase();
  if (/pre[-\s]?order/.test(normalized)) return "pre_order";
  if (/out of stock|sold out|unavailable/.test(normalized)) return "out_of_stock";
  if (/in stock/.test(normalized)) return "in_stock";
  return null;
}

function extractBrand(documentTitle, productTitle) {
  const title = normalizeText(documentTitle);
  const product = normalizeText(productTitle);
  if (!title || !product) return null;

  const index = title.indexOf(product);
  if (index <= 0) return null;

  return normalizeText(title.slice(0, index));
}

function buildCategoryTree(breadcrumbs, productTitle) {
  const product = normalizeText(productTitle);

  return (breadcrumbs || [])
    .map((crumb) => ({
      name: normalizeText(crumb.name),
      url: normalizeText(crumb.url),
      current: Boolean(crumb.current),
    }))
    .filter((crumb) => {
      if (!crumb.name || crumb.current) return false;
      if (crumb.name.toLowerCase() === "home") return false;
      if (product && crumb.name.toLowerCase() === product.toLowerCase()) return false;
      return true;
    })
    .map((crumb) => ({ name: crumb.name, url: crumb.url }));
}

function findSpecValue(specs, pattern) {
  const match = specs.find((spec) => pattern.test(spec.name));
  return match ? match.value : null;
}

function resolvePageUrl(pageUrl) {
  if (pageUrl && /^https?:\/\//i.test(pageUrl)) return pageUrl;
  return PRODUCT_URL;
}

function extractFromDom() {
  const normalize = (value) => {
    if (value == null) return null;
    const text = String(value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    return text || null;
  };

  const toAbsoluteUrl = (value) => {
    const raw = normalize(value);
    if (!raw) return null;
    try {
      return new URL(raw, location.href).href;
    } catch {
      return raw;
    }
  };

  const title = normalize(document.querySelector("h2.title")?.textContent);
  const summary = document.querySelector("h2.title + div p");
  const description =
    normalize(summary?.innerText) || normalize(document.querySelector("#description-list")?.innerText);

  const priceRoot = document.querySelector("#prices-wrapper");
  const priceText = normalize(
    priceRoot?.querySelector("#prices-new, .prices-new, .price-new")?.textContent
  );
  const oldPriceText = normalize(priceRoot?.querySelector(".price-old, #prices-old")?.textContent);
  const availabilityText = normalize(
    [...(priceRoot?.querySelectorAll("span") || [])]
      .map((span) => normalize(span.textContent))
      .find((text) => text && !/^\$/.test(text) && !/^was$/i.test(text) && text !== priceText && text !== oldPriceText)
  );

  const breadcrumbs = [...document.querySelectorAll("ol.breadcrumb > li.breadcrumb-item")].map((item) => {
    const link = item.querySelector("a");
    return {
      name: normalize(item.textContent),
      url: link ? toAbsoluteUrl(link.getAttribute("href")) : null,
      current: item.classList.contains("active") || item.getAttribute("aria-current") === "page",
    };
  });

  const imageUrl = toAbsoluteUrl(document.querySelector("#imagePopup")?.getAttribute("src"));
  const galleryUrls = [];
  const slides = [...document.querySelectorAll("#carouselImages .swiper-slide")]
    .filter((slide) => !slide.classList.contains("swiper-slide-duplicate"))
    .sort(
      (left, right) =>
        Number(left.getAttribute("data-swiper-slide-index") || 0) -
        Number(right.getAttribute("data-swiper-slide-index") || 0)
    );

  for (const slide of slides) {
    const image = slide.querySelector("img.product-detail-thumb-bto");
    const url = toAbsoluteUrl(image?.getAttribute("popup_img") || image?.getAttribute("src"));
    if (url && !galleryUrls.includes(url)) galleryUrls.push(url);
  }

  const specs = [];
  for (const row of document.querySelectorAll("table.table-borderless tr")) {
    const name = normalize(row.querySelector("th")?.textContent);
    const value = normalize(row.querySelector("td")?.innerText);
    if (!name) continue;
    specs.push({ name, value });
  }

  return {
    documentTitle: normalize(document.title),
    pageUrl: location.href,
    itemId: normalize(document.querySelector('#product_qty input[name="product_id"]')?.value),
    title,
    description,
    priceText,
    oldPriceText,
    availabilityText,
    breadcrumbs,
    imageUrl,
    galleryUrls,
    specs,
    ratingText: normalize(document.querySelector("#average-rating-info")?.textContent),
  };
}

function buildProduct(raw) {
  const title = normalizeText(raw.title);
  const categoryTree = buildCategoryTree(raw.breadcrumbs, title);
  const specs = (raw.specs || [])
    .map((spec) => ({
      name: normalizeText(spec.name),
      value: normalizeText(spec.value),
    }))
    .filter((spec) => spec.name);

  const currentPrice = parsePrice(raw.priceText);
  const oldPrice = parsePrice(raw.oldPriceText);
  const onSale = oldPrice != null && currentPrice != null && oldPrice !== currentPrice;
  const rating = parseRating(raw.ratingText);
  const imageUrl = normalizeText(raw.imageUrl);
  const additionalImageUrls = [...new Set((raw.galleryUrls || []).map(normalizeText).filter(Boolean))].filter(
    (url) => url !== imageUrl
  );

  return {
    url: resolvePageUrl(raw.pageUrl),
    item_id: normalizeText(raw.itemId),
    title,
    brand: extractBrand(raw.documentTitle, title),
    product_category: categoryTree.length ? categoryTree.map((category) => category.name).join(" > ") : null,
    category_tree: categoryTree,
    description: normalizeText(raw.description),
    price: onSale ? oldPrice : currentPrice,
    sale_price: onSale ? currentPrice : null,
    availability: normalizeAvailability(raw.availabilityText),
    image_url: imageUrl,
    additional_image_urls: additionalImageUrls,
    specs,
    star_rating: rating.starRating,
    review_count: rating.reviewCount,
    gtin: findSpecValue(specs, /^(gtin|upc|ean|barcode)$/i),
    mpn: findSpecValue(specs, /manufacturer number|^mpn$|part number/i),
    scraped_at: new Date().toISOString(),
  };
}

async function launchBrowser() {
  const channels = ["chrome", "msedge", null];
  let lastError = null;

  for (const channel of channels) {
    try {
      return await chromium.launch({
        headless: true,
        args: ["--disable-blink-features=AutomationControlled"],
        ...(channel ? { channel } : {}),
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Unable to launch a browser");
}

async function fetchProductHtml(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(NAVIGATION_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Product page request failed with status ${response.status}`);
  }

  return response.text();
}

async function pageIsBlocked(page, response) {
  if (response && response.status() >= 400) return true;
  const title = await page.title().catch(() => "");
  return /access denied/i.test(title);
}

async function openProductPage(browser) {
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: "en-US",
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);

  let response = null;
  try {
    response = await page.goto(PRODUCT_URL, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
  } catch (error) {
    response = null;
  }

  if (await pageIsBlocked(page, response)) {
    const html = await fetchProductHtml(PRODUCT_URL);
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
  }

  await page.waitForSelector("h2.title", { timeout: 20000 });
  return page;
}

async function saveProduct(product) {
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(product, null, 2)}\n`, "utf8");
}

async function main() {
  let browser;

  try {
    browser = await launchBrowser();
    const page = await openProductPage(browser);
    const raw = await page.evaluate(extractFromDom);
    const product = buildProduct(raw);

    if (!product.title && product.price == null) {
      throw new Error("Product content was not found on the page");
    }

    await saveProduct(product);
    console.log(`Saved ${path.relative(process.cwd(), OUTPUT_PATH)}`);
  } catch (error) {
    console.error(`Scrape failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
}

main();
