import fs from "fs";
import path from "path";
import { Attendee, EventItem, RunnerOptions } from "./types.js";
import { MonitorServer } from "./monitor.js";
import { EventAutomationRunner } from "./runner.js";

function parseArgs(): {
  personId?: string;
  allTeam: boolean;
  reset: boolean;
  retryFailed: boolean;
  headless: boolean;
  limit?: number;
  startFrom?: number;
  port: number;
  urls?: string[];
  eventIds?: number[];
} {
  const args = process.argv.slice(2);
  let personId = "devishree-mohan";
  let allTeam = false;
  let reset = false;
  let retryFailed = false;
  let headless = false;
  let limit: number | undefined;
  let startFrom: number | undefined;
  let port = 3005;
  let urls: string[] | undefined;
  let eventIds: number[] | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--person" || a === "-p") {
      personId = args[++i];
    } else if (a === "--all-team" || a === "--all") {
      allTeam = true;
    } else if (a === "--reset" || a === "-r") {
      reset = true;
    } else if (a === "--retry-failed") {
      retryFailed = true;
    } else if (a === "--headless") {
      headless = true;
    } else if (a === "--limit" || a === "-l") {
      limit = parseInt(args[++i], 10);
    } else if (a === "--start-from" || a === "-s") {
      startFrom = parseInt(args[++i], 10);
      if (startFrom > 0) startFrom -= 1; // Convert 1-based CLI input to 0-based index
    } else if (a === "--port") {
      port = parseInt(args[++i], 10);
    } else if (a === "--urls") {
      urls = args[++i].split(",").map(u => u.trim());
    } else if (a === "--event-ids") {
      eventIds = args[++i].split(",").map(id => parseInt(id.trim(), 10));
    } else if (a === "--red-events") {
      const redPath = path.resolve(process.cwd(), "data", "red-events.json");
      if (fs.existsSync(redPath)) {
        const raw = JSON.parse(fs.readFileSync(redPath, "utf-8"));
        urls = raw.filter((e: any) => e.url && e.url.includes("luma.com")).map((e: any) => e.url);
      } else {
        console.error("❌ data/red-events.json not found.");
      }
    }
  }

  return { personId, allTeam, reset, retryFailed, headless, limit, startFrom, port, urls, eventIds };
}

function getAttendeeProgress(attendeeId: string, totalEvents: number, targetEvents?: EventItem[]): {
  attempted: number;
  confirmed: number;
  failed: number;
  nextIndex: number;
  isComplete: boolean;
} {
  const resultsFile = path.resolve(process.cwd(), "data", "results", `${attendeeId}.json`);
  const globalFile = path.resolve(process.cwd(), "data", "results.json");

  let data: any = null;
  if (fs.existsSync(resultsFile)) {
    try {
      data = JSON.parse(fs.readFileSync(resultsFile, "utf-8"));
    } catch {}
  } else if (fs.existsSync(globalFile)) {
    try {
      const g = JSON.parse(fs.readFileSync(globalFile, "utf-8"));
      if (g.attendee && g.attendee.id === attendeeId) data = g;
    } catch {}
  }

  if (!data) {
    return { attempted: 0, confirmed: 0, failed: 0, nextIndex: 1, isComplete: false };
  }

  let confirmed = data.stats?.successCount || 0;
  if (Array.isArray(data.successEvents) && targetEvents && targetEvents.length > 0) {
    const successUrls = new Set(data.successEvents.map((e: any) => (e.eventUrl || "").toLowerCase().replace(/\/+$/, "")));
    confirmed = targetEvents.filter(e => successUrls.has((e.url || "").toLowerCase().replace(/\/+$/, ""))).length;
  }

  const attempted = data.stats?.totalAttempted || 0;
  const failed = data.stats?.failedCount || 0;
  const lastIdx = typeof data.lastProcessedIndex === "number" ? data.lastProcessedIndex : attempted - 1;
  const nextIndex = lastIdx >= 0 ? lastIdx + 2 : 1;
  const isComplete = confirmed >= totalEvents;

  return { attempted, confirmed, failed, nextIndex, isComplete };
}

async function main() {
  const config = parseArgs();

  // Load team members
  const teamPath = path.resolve(process.cwd(), "data", "team.json");
  if (!fs.existsSync(teamPath)) {
    throw new Error(`Team file not found at ${teamPath}. Copy data/team.example.json to data/team.json and fill in your team details.`);
  }
  const team: Attendee[] = JSON.parse(fs.readFileSync(teamPath, "utf-8"));

  // Load events
  const eventsPath = path.resolve(process.cwd(), "data", "events.json");
  if (!fs.existsSync(eventsPath)) {
    throw new Error(`Events file not found at ${eventsPath}. Copy data/events.example.json to data/events.json and configure your event list.`);
  }
  const allEvents: EventItem[] = JSON.parse(fs.readFileSync(eventsPath, "utf-8"));

  // Filter or resolve target events
  let targetEvents: EventItem[];
  if (config.urls && config.urls.length > 0) {
    targetEvents = config.urls.map((u, idx) => {
      const cleanU = u.trim();
      const match = allEvents.find(e => e.url.toLowerCase() === cleanU.toLowerCase() || e.url.toLowerCase().includes(cleanU.toLowerCase()));
      if (match) {
        return { ...match, soldOut: false }; // Force attempt requested event
      }
      return {
        id: 9900000 + idx + 1,
        title: `Requested Event: ${cleanU.replace(/^https?:\/\//, '')}`,
        url: cleanU,
        isLuma: true,
        soldOut: false
      };
    });
  } else if (config.eventIds && config.eventIds.length > 0) {
    targetEvents = config.eventIds.map(id => {
      const match = allEvents.find(e => e.id === id);
      if (match) return { ...match, soldOut: false };
      throw new Error(`Event ID ${id} not found in data/events.json`);
    });
  } else {
    targetEvents = allEvents.filter(e => e.isLuma && !e.soldOut);
  }

  console.log(`\n==================================================================`);
  console.log(`⚡ AutoForm — Autonomous High-Accuracy Event Registration Engine`);
  console.log(`🛡️ Universal Radix Combobox Solver • Strict Verification • Stealth Anti-Bot`);
  console.log(`💾 Persistent State Per-Person • Automatic Resume • Live Port ${config.port}`);
  console.log(`==================================================================`);
  console.log(`📅 Total Curated Events: ${allEvents.length} (${targetEvents.length} open Luma events ready)`);
  console.log(`👥 Team Members Progress & Resume Points:`);

  team.forEach((m, idx) => {
    const p = getAttendeeProgress(m.id, targetEvents.length, targetEvents);
    const statusText = p.isComplete
      ? `✅ Completed (${p.confirmed} confirmed)`
      : p.attempted > 0
      ? `⏸️ ${p.attempted}/${targetEvents.length} attempted (${p.confirmed} confirmed) -> Resumes at Event #${p.nextIndex}`
      : `⏳ Not started -> Ready`;
    console.log(`   ${idx + 1}. ${m.name.padEnd(25)} : ${statusText}`);
  });
  console.log(`==================================================================\n`);

  const attendeesToRun: Attendee[] = [];
  if (config.allTeam) {
    attendeesToRun.push(...team);
  } else {
    const matched = team.find(
      m => m.id.toLowerCase() === config.personId?.toLowerCase() ||
           m.name.toLowerCase().includes(config.personId?.toLowerCase() || "") ||
           m.firstName.toLowerCase() === config.personId?.toLowerCase()
    );
    if (!matched) {
      console.error(`❌ Attendee matching "${config.personId}" not found in data/team.json.`);
      console.log(`Available IDs: ${team.map(t => t.id).join(", ")}`);
      process.exit(1);
    }
    attendeesToRun.push(matched);
  }

  for (let aIdx = 0; aIdx < attendeesToRun.length; aIdx++) {
    const attendee = attendeesToRun[aIdx];
    const progress = getAttendeeProgress(attendee.id, targetEvents.length, targetEvents);

    console.log(`\n==================================================================`);
    console.log(`👤 Active Attendee [${aIdx + 1}/${attendeesToRun.length}]: ${attendee.name} (${attendee.email})`);
    console.log(`🏢 ${attendee.company} | ${attendee.role}`);
    console.log(`👩 Gender: ${attendee.gender || 'Female'} | Age: ${attendee.age || 28} | Country: ${attendee.country || 'India'}`);
    console.log(`📊 Prior Progress: ${progress.attempted}/${targetEvents.length} attempted (${progress.confirmed} confirmed)`);
    console.log(`==================================================================\n`);

    if (config.allTeam && progress.isComplete && !config.reset && !config.retryFailed) {
      console.log(`⏩ [Skip]: ${attendee.name} has already completed all ${targetEvents.length} events! Moving to next attendee...`);
      continue;
    }
    if (config.allTeam && config.retryFailed && progress.confirmed >= targetEvents.length) {
      console.log(`⏩ [Skip]: ${attendee.name} has 100% confirmed registrations (${progress.confirmed}/${targetEvents.length})! Moving to next attendee...`);
      continue;
    }

    // Reset results if requested
    if (config.reset) {
      const attendeeResultsFile = path.resolve(process.cwd(), "data", "results", `${attendee.id}.json`);
      const globalResultsFile = path.resolve(process.cwd(), "data", "results.json");
      if (fs.existsSync(attendeeResultsFile)) {
        console.log(`🔄 [--reset]: Resetting saved state for ${attendee.name}.`);
        fs.unlinkSync(attendeeResultsFile);
      }
      if (fs.existsSync(globalResultsFile)) {
        try {
          const g = JSON.parse(fs.readFileSync(globalResultsFile, "utf-8"));
          if (g.attendee && g.attendee.id === attendee.id) {
            fs.unlinkSync(globalResultsFile);
          }
        } catch {}
      }
    }

    const monitor = new MonitorServer(attendee, targetEvents.length, config.port);
    await monitor.start();

    const runnerOptions: RunnerOptions = {
      attendeeId: attendee.id,
      headless: config.headless,
      reset: config.reset,
      retryFailed: config.retryFailed,
      limit: config.limit,
      startFromIndex: config.retryFailed ? 0 : ((config.urls || config.eventIds) ? (config.startFrom ?? 0) : config.startFrom),
      fieldDelayMs: 2000,
      eventDelayMs: 5000,
      enableBreather: true,
    };

    const runner = new EventAutomationRunner(attendee, targetEvents, monitor, runnerOptions);
    await runner.start();

    // Close monitor server before moving to next attendee
    monitor.stop();
  }

  console.log(`\n🎉 All scheduled team registrations finished!`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});