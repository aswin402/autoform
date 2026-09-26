const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

function cleanUrl(u) {
  if (!u) return "";
  return u.trim().replace(/\/+$/, "");
}

async function checkUrlHealth(url, timeoutMs = 7000) {
  if (!url || !url.trim() || url === "#" || url === "empty") {
    return { working: false, status: 0, category: "INVALID", reason: "No link provided" };
  }

  let target = url.trim();
  // Check if it is an email address
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target) || target.startsWith("mailto:")) {
    return { working: false, status: 0, category: "INVALID", reason: "Email address instead of URL" };
  }

  // Check if it is plain text like "Invite Only"
  if (!target.includes(".") || target.includes(" ")) {
    return { working: false, status: 0, category: "INVALID", reason: `Invalid URL format ("${target}")` };
  }

  if (!/^https?:\/\//i.test(target)) {
    target = "https://" + target;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await fetch(target, {
        method: "HEAD",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        },
        redirect: "follow"
      });
    } catch (headErr) {
      // Fallback to GET if HEAD failed
      const getController = new AbortController();
      const getTimeout = setTimeout(() => getController.abort(), timeoutMs);
      res = await fetch(target, {
        method: "GET",
        signal: getController.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        },
        redirect: "follow"
      });
      clearTimeout(getTimeout);
    }
    clearTimeout(timeout);

    const status = res.status;
    if (status >= 200 && status < 400) {
      return { working: true, status, category: "ACTIVE", reason: "OK (HTTP " + status + ")" };
    } else if (status === 401 || status === 403) {
      return { working: true, status, category: "ACTIVE", reason: "Live (Auth / Cloudflare Protected)" };
    } else if (status === 429) {
      // Live server hit rate-limiting during batch requests
      return { working: true, status, category: "ACTIVE", reason: "Live (CDN Rate Limited 429)" };
    } else if (status === 404) {
      return { working: false, status, category: "BROKEN", reason: "404 Not Found" };
    } else if (status === 410) {
      return { working: false, status, category: "BROKEN", reason: "410 Gone / Expired" };
    } else {
      return { working: false, status, category: "BROKEN", reason: `HTTP ${status}` };
    }
  } catch (err) {
    if (err.name === "AbortError") {
      return { working: false, status: 0, category: "TIMEOUT", reason: "Connection Timeout (>7s)" };
    }
    return { working: false, status: 0, category: "ERROR", reason: err.message || "Connection failed" };
  }
}

async function runWithConcurrency(items, fn, concurrency = 10) {
  const results = new Array(items.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < items.length) {
      const idx = currentIndex++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        results[idx] = { working: false, status: 0, category: "ERROR", reason: err.message };
      }
      // Small pause between requests to respect rate limits
      await new Promise(r => setTimeout(r, 40));
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  console.log("==================================================================");
  console.log("🌐 TOKEN2049 Singapore 2026 Event Extractor & Link Health Auditor");
  console.log("==================================================================\n");

  const browser = await chromium.launch({ headless: true });
  
  // 1. Scrape week.token2049.com
  console.log("📡 [1/3] Extracting events from https://week.token2049.com/ ...");
  const p = await browser.newPage();
  await p.goto("https://week.token2049.com/", { waitUntil: "networkidle", timeout: 30000 });
  const rawWeekData = await p.$eval("#__NEXT_DATA__", el => el.innerText).catch(() => null);
  await p.close();

  let weekEvents = [];
  if (rawWeekData) {
    const parsed = JSON.parse(rawWeekData);
    weekEvents = parsed.props?.pageProps?.events || [];
  }
  console.log(`   ✅ Extracted ${weekEvents.length} events from week.token2049.com.`);

  // 2. Fetch Luma calendar events from API (specifically tag=ai)
  console.log("\n📡 [2/3] Extracting events from https://luma.com/token2049?tag=ai ...");
  const calId = "cal-WfTOVDTJaAVqK3S";
  let cursor = null;
  let allLumaEntries = [];

  while (true) {
    let url = `https://api.luma.com/calendar/get-items?calendar_api_id=${calId}&pagination_limit=100&period=future`;
    if (cursor) url += `&pagination_cursor=${encodeURIComponent(cursor)}`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (!data.entries || data.entries.length === 0) break;
      allLumaEntries.push(...data.entries);
      if (!data.has_more || !data.next_cursor) break;
      cursor = data.next_cursor;
    } catch (e) {
      console.error("   ⚠️ Error querying Luma API:", e.message);
      break;
    }
  }
  console.log(`   ✅ Fetched ${allLumaEntries.length} total events from Luma calendar.`);

  const lumaAiEntries = allLumaEntries.filter(e => {
    const hasAiTag = (e.tags || []).some(t => t.name?.toLowerCase() === "ai" || t.api_id === "tag-52TGZWRCiKKGQ3J");
    const hasAiInTitle = /\bai\b|artificial intelligence|agentic|machine learning|llm/i.test(e.event?.name || "");
    return hasAiTag || hasAiInTitle;
  });
  console.log(`   ✅ Found ${lumaAiEntries.length} AI-tagged or AI-related events on Luma.`);

  await browser.close();

  // 3. Unify, Deduplicate and Normalize
  console.log("\n🔄 [3/3] Deduplicating and indexing events across both sources...");
  const unifiedMap = new Map();

  weekEvents.forEach(e => {
    const regUrl = cleanUrl(e.registration_link);
    const isFree = (e.event_type || "").toLowerCase() === "free" || e.price === "0" || e.price === 0;
    const isFreeAndPaid = (e.event_type || "").toLowerCase().includes("free & paid");
    const isPaid = (e.event_type || "").toLowerCase().includes("paid") && !isFreeAndPaid;
    const isInviteOnly = (e.event_type || "").toLowerCase().includes("invite") || (e.registration_link || "").toLowerCase().includes("invite");

    const eventItem = {
      id: e.event_id || e._id,
      title: (e.event_name || "").trim(),
      organizer: e.organiser_name || "",
      category: e.event_category || "",
      date: e.event_date ? e.event_date.split("T")[0] : "",
      startTime: e.start_time || "",
      endTime: e.end_time || "",
      venue: e.venue?.name || "",
      price: e.price || "0",
      eventType: isInviteOnly ? "Invite Only" : (isFreeAndPaid ? "Free & Paid" : (isFree ? "Free" : "Paid")),
      isFree: isFree || isFreeAndPaid,
      isPaidOnly: isPaid,
      isInviteOnly: isInviteOnly,
      url: (e.registration_link || "").trim(),
      source: "week.token2049.com",
      tags: [],
      soldOut: !!e.soldOut
    };

    if (regUrl) {
      unifiedMap.set(regUrl, eventItem);
    } else {
      unifiedMap.set(`no-link-${eventItem.id || Math.random()}`, eventItem);
    }
  });

  // Enrich / Merge Luma AI events
  lumaAiEntries.forEach(le => {
    const lumaUrl = cleanUrl("https://luma.com/" + le.event?.url);
    const existing = unifiedMap.get(lumaUrl);
    const tags = (le.tags || []).map(t => t.name);

    if (existing) {
      existing.tags = Array.from(new Set([...existing.tags, ...tags, "AI"]));
      existing.source = "week.token2049.com + luma (tag=ai)";
      if (le.ticket_info?.is_free) existing.isFree = true;
    } else {
      const isFree = !!le.ticket_info?.is_free;
      const isApproval = !!le.ticket_info?.require_approval;
      const eventItem = {
        id: le.event?.api_id || le.api_id,
        title: (le.event?.name || "").trim(),
        organizer: le.hosts?.[0]?.name || "",
        category: "AI",
        date: le.event?.start_at ? le.event.start_at.split("T")[0] : "",
        startTime: "",
        endTime: "",
        venue: le.event?.geo_address_info?.city || "Singapore",
        price: le.ticket_info?.price || (isFree ? "0" : "Paid"),
        eventType: isFree ? "Free" : "Paid",
        isFree: isFree,
        isPaidOnly: !isFree,
        isInviteOnly: isApproval,
        url: "https://luma.com/" + le.event?.url,
        source: "luma.com/token2049?tag=ai",
        tags: Array.from(new Set([...tags, "AI"])),
        soldOut: !!le.ticket_info?.is_sold_out
      };
      unifiedMap.set(lumaUrl, eventItem);
    }
  });

  const allEvents = Array.from(unifiedMap.values());
  console.log(`   ✅ Total unified unique events: ${allEvents.length}`);

  // 4. Link Health Check
  console.log(`\n🩺 Performing live HTTP link health checks across all ${allEvents.length} event URLs...`);
  console.log(`   (Concurrency: 10 workers, Timeout: 7s per link, Paced)`);

  const startTime = Date.now();
  const healthResults = await runWithConcurrency(allEvents, async (evt) => {
    return await checkUrlHealth(evt.url);
  }, 10);

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`   ✅ Health check completed in ${durationSec}s.`);

  allEvents.forEach((evt, idx) => {
    const h = healthResults[idx];
    evt.linkWorking = h.working;
    evt.httpStatus = h.status;
    evt.linkCategory = h.category;
    evt.linkReason = h.reason;
  });

  // 5. Partition Data
  const workingEvents = allEvents.filter(e => e.linkWorking);
  const brokenEvents = allEvents.filter(e => !e.linkWorking);
  const freeEvents = allEvents.filter(e => e.isFree);
  const freeAndWorking = allEvents.filter(e => e.isFree && e.linkWorking);
  const paidOnlyEvents = allEvents.filter(e => e.isPaidOnly);
  const aiEvents = allEvents.filter(e => (e.tags || []).includes("AI") || /ai\b|agent|artificial/i.test(e.title) || /ai/i.test(e.category));

  // 6. Save Datasets to data/
  const dataDir = path.resolve(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  fs.writeFileSync(path.join(dataDir, "token2049-all-events.json"), JSON.stringify(allEvents, null, 2), "utf8");
  fs.writeFileSync(path.join(dataDir, "token2049-free-events.json"), JSON.stringify(freeEvents, null, 2), "utf8");
  fs.writeFileSync(path.join(dataDir, "token2049-ai-events.json"), JSON.stringify(aiEvents, null, 2), "utf8");

  console.log("\n==================================================================");
  console.log("📊 EXTRACTION & AUDIT RESULTS SUMMARY");
  console.log("==================================================================");
  console.log(`Total Events Extracted:         ${allEvents.length}`);
  console.log(`- Working Link (Active):        ${workingEvents.length} (${(workingEvents.length / allEvents.length * 100).toFixed(1)}%)`);
  console.log(`- Broken / Invalid / Missing:   ${brokenEvents.length} (${(brokenEvents.length / allEvents.length * 100).toFixed(1)}%)`);
  console.log(`------------------------------------------------------------------`);
  console.log(`Total Free Events:              ${freeEvents.length} (${(freeEvents.length / allEvents.length * 100).toFixed(1)}%)`);
  console.log(`- Free & Link Working:          ${freeAndWorking.length}`);
  console.log(`- Free & Link Broken/Invalid:   ${freeEvents.length - freeAndWorking.length}`);
  console.log(`------------------------------------------------------------------`);
  console.log(`Total Paid Only Events:         ${paidOnlyEvents.length}`);
  console.log(`------------------------------------------------------------------`);
  console.log(`Total AI / Agentic Events:      ${aiEvents.length}`);
  console.log(`- AI Free Events:               ${aiEvents.filter(e => e.isFree).length}`);
  console.log(`- AI Working Links:             ${aiEvents.filter(e => e.linkWorking).length}`);
  console.log("==================================================================\n");

  console.log("📁 Saved structured datasets to:");
  console.log("   • data/token2049-all-events.json  (" + allEvents.length + " events)");
  console.log("   • data/token2049-free-events.json (" + freeEvents.length + " free events)");
  console.log("   • data/token2049-ai-events.json   (" + aiEvents.length + " AI events)\n");

  if (brokenEvents.length > 0) {
    console.log(`⚠️ Problematic / Invalid / Broken URLs (${brokenEvents.length}):`);
    brokenEvents.forEach((b, i) => {
      console.log(`   ${i+1}. [${b.linkCategory}] ${b.title}: ${b.url || "(No URL)"} -> ${b.linkReason}`);
    });
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
