import http from "http";
import fs from "fs";
import path from "path";
import { LiveState, LogEntry, EventResult, Attendee, TeamMemberSummary } from "./types.js";

export class MonitorServer {
  private state: LiveState;
  private server: http.Server | null = null;
  private attendeeResultsFilePath: string;
  private globalResultsFilePath: string;
  private teamSummaryFilePath: string;
  private logFilePath: string;
  private port: number;
  private isPausedState = false;
  private attendee: Attendee;

  constructor(attendee: Attendee, totalEvents: number, port = 3005) {
    this.port = port;
    this.attendee = attendee;

    const dataDir = path.resolve(process.cwd(), "data");
    const resultsDir = path.resolve(dataDir, "results");
    const logsDir = path.resolve(dataDir, "logs");

    if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    this.attendeeResultsFilePath = path.resolve(resultsDir, `${attendee.id}.json`);
    this.globalResultsFilePath = path.resolve(dataDir, "results.json");
    this.teamSummaryFilePath = path.resolve(resultsDir, "team-summary.json");
    this.logFilePath = path.resolve(logsDir, `${attendee.id}.log`);

    this.state = {
      status: "idle",
      updatedAt: new Date().toISOString(),
      attendee: {
        id: attendee.id,
        name: attendee.name,
        email: attendee.email,
        company: attendee.company,
        gender: attendee.gender || "Female",
        age: attendee.age || 28,
        country: attendee.country || "India",
      },
      lastProcessedIndex: -1,
      stats: {
        totalPending: totalEvents,
        totalAttempted: 0,
        successCount: 0,
        waitlistCount: 0,
        failedCount: 0,
        remainingCount: totalEvents,
      },
      currentEvent: null,
      breather: {
        active: false,
        remainingSec: 0,
        totalSec: 120,
      },
      recentLogs: [],
      successEvents: [],
      unsuccessEvents: [],
    };

    this.loadPersistedResults();
  }

  private loadPersistedResults() {
    try {
      let data: any = null;

      // 1. Try attendee-specific results file first
      if (fs.existsSync(this.attendeeResultsFilePath)) {
        data = JSON.parse(fs.readFileSync(this.attendeeResultsFilePath, "utf-8"));
      } else if (fs.existsSync(this.globalResultsFilePath)) {
        // 2. Fall back to global results.json if it belongs to this attendee
        const globalData = JSON.parse(fs.readFileSync(this.globalResultsFilePath, "utf-8"));
        if (globalData.attendee && globalData.attendee.id === this.attendee.id) {
          data = globalData;
        }
      }

      if (data) {
        if (Array.isArray(data.successEvents)) this.state.successEvents = data.successEvents;
        if (Array.isArray(data.unsuccessEvents)) this.state.unsuccessEvents = data.unsuccessEvents;

        this.state.stats.successCount = this.state.successEvents.filter(e => e.status === "confirmed_success").length;
        this.state.stats.waitlistCount = this.state.successEvents.filter(e => e.status === "waitlist_joined").length;
        this.state.stats.failedCount = this.state.unsuccessEvents.length;
        this.state.stats.totalAttempted = this.state.stats.successCount + this.state.stats.waitlistCount + this.state.stats.failedCount;
        this.state.stats.remainingCount = Math.max(0, this.state.stats.totalPending - this.state.stats.totalAttempted);

        if (typeof data.lastProcessedIndex === "number") {
          this.state.lastProcessedIndex = data.lastProcessedIndex;
        } else if (this.state.stats.totalAttempted > 0) {
          this.state.lastProcessedIndex = this.state.stats.totalAttempted - 1;
        }

        if (typeof data.lastProcessedEventId === "number") {
          this.state.lastProcessedEventId = data.lastProcessedEventId;
        }

        if (Array.isArray(data.recentLogs) && data.recentLogs.length > 0) {
          this.state.recentLogs = data.recentLogs.slice(0, 100);
        }

        // Save immediately to ensure attendeeResultsFilePath is populated
        this.saveResults();
      }
    } catch (e: any) {
      console.warn(`[Monitor] Notice loading persisted results: ${e.message}`);
    }
  }

  public saveResults() {
    try {
      this.state.updatedAt = new Date().toISOString();
      const serialized = JSON.stringify(this.state, null, 2);

      // Save attendee-specific results
      fs.writeFileSync(this.attendeeResultsFilePath, serialized, "utf-8");

      // Save global mirror of active attendee
      fs.writeFileSync(this.globalResultsFilePath, serialized, "utf-8");

      // Update team summary
      this.updateTeamSummaryFile();
    } catch (e: any) {
      console.error("[Monitor] Failed to persist results:", e.message);
    }
  }

  private updateTeamSummaryFile() {
    try {
      let teamSummary: Record<string, TeamMemberSummary> = {};
      if (fs.existsSync(this.teamSummaryFilePath)) {
        try {
          teamSummary = JSON.parse(fs.readFileSync(this.teamSummaryFilePath, "utf-8"));
        } catch {}
      }

      teamSummary[this.attendee.id] = {
        attendeeId: this.attendee.id,
        name: this.attendee.name,
        email: this.attendee.email,
        company: this.attendee.company,
        lastProcessedIndex: this.state.lastProcessedIndex ?? -1,
        lastProcessedEventId: this.state.lastProcessedEventId,
        totalPending: this.state.stats.totalPending,
        totalAttempted: this.state.stats.totalAttempted,
        successCount: this.state.stats.successCount,
        waitlistCount: this.state.stats.waitlistCount,
        failedCount: this.state.stats.failedCount,
        remainingCount: this.state.stats.remainingCount,
        status: this.state.status,
        updatedAt: this.state.updatedAt,
      };

      fs.writeFileSync(this.teamSummaryFilePath, JSON.stringify(teamSummary, null, 2), "utf-8");
    } catch (e: any) {
      console.error("[Monitor] Failed to update team summary:", e.message);
    }
  }

  public log(message: string, type: LogEntry["type"] = "info") {
    const now = new Date();
    const time = now.toLocaleTimeString();
    const entry: LogEntry = { time, message, type };

    this.state.recentLogs.unshift(entry);
    if (this.state.recentLogs.length > 200) this.state.recentLogs.pop();

    // Append to attendee log file
    try {
      const line = `[${now.toISOString()}] [${type.toUpperCase()}] ${message}\n`;
      fs.appendFileSync(this.logFilePath, line, "utf-8");
    } catch {}

    this.saveResults();
  }

  public updateCurrentEvent(ev: LiveState["currentEvent"]) {
    this.state.currentEvent = ev;
    this.saveResults();
  }

  public setBreather(active: boolean, remainingSec = 0) {
    this.state.breather.active = active;
    this.state.breather.remainingSec = remainingSec;
    this.saveResults();
  }

  public recordEventResult(result: EventResult, eventIndex?: number, eventId?: number) {
    result.attendeeId = this.attendee.id;

    if (result.status === "confirmed_success") {
      this.state.stats.successCount++;
      this.state.successEvents.push(result);
    } else if (result.status === "waitlist_joined") {
      this.state.stats.waitlistCount++;
      this.state.successEvents.push(result);
    } else {
      this.state.stats.failedCount++;
      this.state.unsuccessEvents.push(result);
    }

    this.state.stats.totalAttempted++;
    this.state.stats.remainingCount = Math.max(0, this.state.stats.totalPending - this.state.stats.totalAttempted);

    if (typeof eventIndex === "number") {
      this.state.lastProcessedIndex = eventIndex;
    }
    if (typeof eventId === "number") {
      this.state.lastProcessedEventId = eventId;
    }

    // Write audit trail log
    const auditMsg = `[AUDIT #${result.eventId}] status=${result.status} | title="${result.eventTitle}" | requiredFields=${result.requiredFields.length} | allFields=${result.allFields.length}${result.failureReason ? ` | reason="${result.failureReason}"` : ""}`;
    try {
      fs.appendFileSync(this.logFilePath, `[${new Date().toISOString()}] ${auditMsg}\n`, "utf-8");
    } catch {}

    this.saveResults();
  }

  public setStatus(status: LiveState["status"]) {
    this.state.status = status;
    this.isPausedState = (status === "paused");
    this.saveResults();
  }

  public pause(): void {
    this.isPausedState = true;
    this.state.status = "paused";
    this.log("⏸️ Automation PAUSED by user. State saved.", "warn");
    this.saveResults();
  }

  public resume(): void {
    this.isPausedState = false;
    this.state.status = "running";
    this.log("▶️ Automation RESUMED by user.", "success");
    this.saveResults();
  }

  public togglePause(): boolean {
    if (this.isPausedState) {
      this.resume();
    } else {
      this.pause();
    }
    return this.isPausedState;
  }

  public isPaused(): boolean {
    return this.isPausedState;
  }

  public getState(): LiveState {
    return this.state;
  }

  public start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        const url = req.url || "/";

        if (url === "/api/status" || url === "/status") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.state));
          return;
        }

        if (url === "/api/pause") {
          this.pause();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, status: this.state.status, isPaused: this.isPausedState }));
          return;
        }

        if (url === "/api/resume") {
          this.resume();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, status: this.state.status, isPaused: this.isPausedState }));
          return;
        }

        if (url === "/api/toggle-pause") {
          const paused = this.togglePause();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, status: this.state.status, isPaused: paused }));
          return;
        }

        if (url === "/api/results/success") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.state.successEvents));
          return;
        }

        if (url === "/api/results/failed") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.state.unsuccessEvents));
          return;
        }

        if (url === "/api/team-summary") {
          let summary: any = {};
          if (fs.existsSync(this.teamSummaryFilePath)) {
            try {
              summary = JSON.parse(fs.readFileSync(this.teamSummaryFilePath, "utf-8"));
            } catch {}
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(summary));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(this.renderHtml());
      });

      this.server.listen(this.port, () => {
        console.log(`\n🌐 [Live Dashboard] Running at: http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  public stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private renderHtml(): string {
    const a = this.state.attendee;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>AutoForm — Event Registration Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background: #07090e; color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-thumb { background: #1f2937; border-radius: 3px; }
  </style>
</head>
<body class="p-4 md:p-6 max-w-7xl mx-auto space-y-6">
  <!-- Top Bar -->
  <div class="flex flex-col md:flex-row md:items-center justify-between border-b border-gray-800 pb-4 gap-4">
    <div>
      <div class="flex items-center gap-3">
        <h1 class="text-2xl font-black text-white flex items-center gap-2">
          ⚡ AutoForm
        </h1>
        <span id="pipeline-badge" class="text-xs uppercase font-mono px-2.5 py-0.5 rounded-full font-bold bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">IDLE</span>
      </div>
      <p class="text-xs text-gray-400 mt-1">Autonomous Event Registration Engine • Anti-Bot Pacing • Persistent State Resume</p>
    </div>
    
    <div class="flex items-center gap-3">
      <!-- Interactive Pause/Resume Button -->
      <button id="btn-toggle-pause" onclick="togglePauseAction()" class="px-4 py-2 rounded-xl font-bold text-xs flex items-center gap-2 transition-all bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30 active:scale-95 shadow-lg">
        <span id="btn-pause-icon">⏸️</span>
        <span id="btn-pause-text">Pause Automation</span>
      </button>

      <div class="text-right text-xs bg-gray-900/90 border border-gray-800 px-4 py-2 rounded-xl">
        <div class="font-bold text-gray-100 text-sm">${a.name}</div>
        <div class="text-gray-400 text-[11px]">${a.company} • ${a.gender} • Age ${a.age} • ${a.country}</div>
      </div>
    </div>
  </div>

  <!-- Breather Alert Banner -->
  <div id="breather-banner" class="hidden p-4 rounded-xl bg-amber-950/40 border border-amber-500/50 text-amber-200 flex justify-between items-center animate-pulse">
    <div>
      <h3 class="font-bold text-sm flex items-center gap-2">🛡️ Anti-Bot Breather Active</h3>
      <p class="text-xs text-amber-300/80">Resting 2 minutes every 50 events to prevent Luma rate-limiting.</p>
    </div>
    <div class="text-2xl font-mono font-bold text-amber-400" id="breather-timer">0s</div>
  </div>

  <!-- Main Status Card -->
  <div class="bg-gray-900/80 border border-gray-800 rounded-2xl p-5 shadow-xl">
    <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-3 mb-3">
      <div class="flex-1">
        <div class="text-xs text-gray-500 font-mono">Current Target</div>
        <h2 id="current-title" class="text-lg font-bold text-white mt-1">Ready to run</h2>
        <a id="current-url" href="#" target="_blank" class="text-xs text-indigo-400 hover:underline block truncate max-w-xl"></a>
      </div>
      <div class="text-left md:text-right">
        <span class="text-xs text-gray-500 font-mono">Current Engine Action</span>
        <div id="current-step" class="text-xs font-mono text-emerald-400 font-bold mt-1">Waiting</div>
        <div id="current-detail" class="text-[11px] text-gray-400 mt-0.5 truncate max-w-sm"></div>
      </div>
    </div>

    <!-- Progress Bar -->
    <div class="w-full bg-gray-800 rounded-full h-3 overflow-hidden mt-4">
      <div id="progress-bar" class="bg-gradient-to-r from-indigo-500 via-purple-500 to-emerald-400 h-3 rounded-full transition-all duration-300" style="width: 0%"></div>
    </div>
    <div class="flex justify-between items-center text-[11px] font-mono text-gray-500 mt-2">
      <span id="progress-text">0% Complete</span>
      <span id="resume-info">Saved progress auto-resumes</span>
    </div>
  </div>

  <!-- Stats Grid -->
  <div class="grid grid-cols-2 md:grid-cols-6 gap-3">
    <div class="bg-gray-900/90 border border-gray-800 rounded-xl p-4">
      <div class="text-[11px] uppercase tracking-wider text-gray-500 font-bold">Total Target</div>
      <div class="text-2xl font-black text-white mt-1 font-mono" id="stat-total">0</div>
    </div>
    <div class="bg-gray-900/90 border border-gray-800 rounded-xl p-4">
      <div class="text-[11px] uppercase tracking-wider text-blue-400 font-bold">Attempted</div>
      <div class="text-2xl font-black text-blue-400 mt-1 font-mono" id="stat-attempted">0</div>
    </div>
    <div class="bg-gray-900/90 border border-gray-800 rounded-xl p-4">
      <div class="text-[11px] uppercase tracking-wider text-emerald-400 font-bold">Confirmed</div>
      <div class="text-2xl font-black text-emerald-400 mt-1 font-mono" id="stat-success">0</div>
    </div>
    <div class="bg-gray-900/90 border border-gray-800 rounded-xl p-4">
      <div class="text-[11px] uppercase tracking-wider text-amber-400 font-bold">Waitlist</div>
      <div class="text-2xl font-black text-amber-400 mt-1 font-mono" id="stat-waitlist">0</div>
    </div>
    <div class="bg-gray-900/90 border border-gray-800 rounded-xl p-4">
      <div class="text-[11px] uppercase tracking-wider text-red-400 font-bold">Failed / Closed</div>
      <div class="text-2xl font-black text-red-400 mt-1 font-mono" id="stat-failed">0</div>
    </div>
    <div class="bg-gray-900/90 border border-gray-800 rounded-xl p-4">
      <div class="text-[11px] uppercase tracking-wider text-purple-400 font-bold">Remaining</div>
      <div class="text-2xl font-black text-purple-400 mt-1 font-mono" id="stat-remaining">0</div>
    </div>
  </div>

  <!-- Navigation Tabs -->
  <div class="flex gap-2 border-b border-gray-800 pb-2">
    <button onclick="switchTab('logs')" id="tab-btn-logs" class="px-4 py-2 rounded-lg text-xs font-bold bg-indigo-600/30 text-indigo-300 border border-indigo-500/40">⚡ Live Logs</button>
    <button onclick="switchTab('confirmed')" id="tab-btn-confirmed" class="px-4 py-2 rounded-lg text-xs font-bold bg-gray-900 text-gray-400 hover:text-white border border-gray-800">✅ Confirmed Events (<span id="count-tab-confirmed">0</span>)</button>
    <button onclick="switchTab('failed')" id="tab-btn-failed" class="px-4 py-2 rounded-lg text-xs font-bold bg-gray-900 text-gray-400 hover:text-white border border-gray-800">❌ Failed Events (<span id="count-tab-failed">0</span>)</button>
    <button onclick="switchTab('team')" id="tab-btn-team" class="px-4 py-2 rounded-lg text-xs font-bold bg-gray-900 text-gray-400 hover:text-white border border-gray-800">👥 Team Progress (6)</button>
  </div>

  <!-- TAB 1: Live Logs & Active Protections -->
  <div id="tab-content-logs" class="grid grid-cols-1 md:grid-cols-3 gap-6">
    <div class="md:col-span-2 bg-gray-900/80 border border-gray-800 rounded-2xl p-5 shadow-lg flex flex-col h-[460px]">
      <div class="flex justify-between items-center border-b border-gray-800 pb-3 mb-3">
        <h3 class="text-sm font-bold text-gray-200">📋 Real-Time Execution Logs</h3>
        <span class="text-[11px] text-gray-500 font-mono">Saved to data/logs/${a.id}.log</span>
      </div>
      <div id="log-feed" class="flex-1 overflow-y-auto space-y-1.5 font-mono text-xs pr-2">
        <div class="text-gray-500 italic">No logs yet. Automation starting...</div>
      </div>
    </div>

    <!-- Active Shielding Info -->
    <div class="bg-gray-900/80 border border-gray-800 rounded-2xl p-5 shadow-lg space-y-4 text-xs h-[460px] flex flex-col justify-between">
      <div>
        <h3 class="text-sm font-bold text-gray-200 border-b border-gray-800 pb-2">🛡️ Active Protections</h3>
        <div class="space-y-3 mt-3">
          <div class="flex justify-between border-b border-gray-800/60 pb-2">
            <span class="text-gray-400">Input Field Delay:</span>
            <span class="font-mono text-emerald-400 font-bold">2.0s</span>
          </div>
          <div class="flex justify-between border-b border-gray-800/60 pb-2">
            <span class="text-gray-400">Inter-Event Rest:</span>
            <span class="font-mono text-emerald-400 font-bold">5.0s</span>
          </div>
          <div class="flex justify-between border-b border-gray-800/60 pb-2">
            <span class="text-gray-400">Breather Cooldown:</span>
            <span class="font-mono text-amber-400 font-bold">2 min / 50 events</span>
          </div>
          <div class="flex justify-between border-b border-gray-800/60 pb-2">
            <span class="text-gray-400">Combobox Selector:</span>
            <span class="font-mono text-emerald-400 font-bold">Radix & Portal Aware</span>
          </div>
          <div class="flex justify-between border-b border-gray-800/60 pb-2">
            <span class="text-gray-400">Turnstile Stealth:</span>
            <span class="font-mono text-emerald-400 font-bold">Passive Auto-Clear</span>
          </div>
          <div class="flex justify-between border-b border-gray-800/60 pb-2">
            <span class="text-gray-400">State Persistence:</span>
            <span class="font-mono text-indigo-400 font-bold">data/results/${a.id}.json</span>
          </div>
        </div>
      </div>
      <div class="text-[11px] text-gray-400 bg-gray-950/60 p-3 rounded-xl border border-gray-800">
        💡 <strong>Pause & Resume Guarantee:</strong> Closing the terminal or clicking Pause immediately saves your exact event index. Re-running continues without repeating completed events.
      </div>
    </div>
  </div>

  <!-- TAB 2: Confirmed Events with Accordion Inputs -->
  <div id="tab-content-confirmed" class="hidden bg-gray-900/80 border border-gray-800 rounded-2xl p-5 shadow-lg">
    <div class="flex justify-between items-center border-b border-gray-800 pb-3 mb-4">
      <h3 class="text-sm font-bold text-gray-200">✅ Successfully Confirmed Registrations</h3>
      <span class="text-xs text-gray-500 font-mono">Includes filled required inputs</span>
    </div>
    <div id="confirmed-list" class="space-y-3 max-h-[500px] overflow-y-auto pr-2">
      <div class="text-gray-500 text-xs italic">Loading confirmed events...</div>
    </div>
  </div>

  <!-- TAB 3: Failed Events with Reasons -->
  <div id="tab-content-failed" class="hidden bg-gray-900/80 border border-gray-800 rounded-2xl p-5 shadow-lg">
    <div class="flex justify-between items-center border-b border-gray-800 pb-3 mb-4">
      <h3 class="text-sm font-bold text-gray-200">❌ Failed or Closed Events</h3>
      <span class="text-xs text-gray-500 font-mono">Shows failure reason and scanned inputs</span>
    </div>
    <div id="failed-list" class="space-y-3 max-h-[500px] overflow-y-auto pr-2">
      <div class="text-gray-500 text-xs italic">Loading failed events...</div>
    </div>
  </div>

  <!-- TAB 4: Team Overview -->
  <div id="tab-content-team" class="hidden bg-gray-900/80 border border-gray-800 rounded-2xl p-5 shadow-lg">
    <div class="flex justify-between items-center border-b border-gray-800 pb-3 mb-4">
      <h3 class="text-sm font-bold text-gray-200">👥 All Team Members Progress</h3>
      <span class="text-xs text-gray-500 font-mono">Loaded from data/results/team-summary.json</span>
    </div>
    <div id="team-table" class="overflow-x-auto">
      <div class="text-gray-500 text-xs italic">Loading team progress...</div>
    </div>
  </div>

  <script>
    let currentTab = "logs";
    let isPausedLocal = false;

    function switchTab(tab) {
      currentTab = tab;
      ["logs", "confirmed", "failed", "team"].forEach(t => {
        const btn = document.getElementById("tab-btn-" + t);
        const content = document.getElementById("tab-content-" + t);
        if (t === tab) {
          btn.className = "px-4 py-2 rounded-lg text-xs font-bold bg-indigo-600/30 text-indigo-300 border border-indigo-500/40";
          content.classList.remove("hidden");
        } else {
          btn.className = "px-4 py-2 rounded-lg text-xs font-bold bg-gray-900 text-gray-400 hover:text-white border border-gray-800";
          content.classList.add("hidden");
        }
      });
      if (tab === "confirmed") renderConfirmedEvents();
      if (tab === "failed") renderFailedEvents();
      if (tab === "team") renderTeamSummary();
    }

    async function togglePauseAction() {
      try {
        const res = await fetch("/api/toggle-pause", { method: "POST" });
        const d = await res.json();
        isPausedLocal = d.isPaused;
        updatePauseButton(d.status);
      } catch (e) {
        console.error("Failed to toggle pause:", e);
      }
    }

    function updatePauseButton(status) {
      const btnIcon = document.getElementById("btn-pause-icon");
      const btnText = document.getElementById("btn-pause-text");
      const btn = document.getElementById("btn-toggle-pause");

      if (status === "paused") {
        btnIcon.innerText = "▶️";
        btnText.innerText = "Resume Automation";
        btn.className = "px-4 py-2 rounded-xl font-bold text-xs flex items-center gap-2 transition-all bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30 active:scale-95 shadow-lg";
      } else {
        btnIcon.innerText = "⏸️";
        btnText.innerText = "Pause Automation";
        btn.className = "px-4 py-2 rounded-xl font-bold text-xs flex items-center gap-2 transition-all bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30 active:scale-95 shadow-lg";
      }
    }

    async function renderConfirmedEvents() {
      try {
        const res = await fetch("/api/results/success");
        if (!res.ok) return;
        const list = await res.json();
        const container = document.getElementById("confirmed-list");
        if (!list || list.length === 0) {
          container.innerHTML = '<div class="text-gray-500 text-xs italic">No confirmed events yet.</div>';
          return;
        }

        container.innerHTML = list.map((ev, idx) => {
          const reqs = ev.requiredFields || [];
          const reqRows = reqs.map(r => 
            '<div class="flex justify-between border-b border-gray-800/40 py-1 text-[11px]"><span class="text-gray-400">' + (r.label || 'Field') + ':</span><span class="font-mono text-emerald-400">' + (r.valueFilled || 'Yes') + '</span></div>'
          ).join('');

          return '<div class="bg-gray-950/70 border border-gray-800 rounded-xl p-3 text-xs">' +
            '<div class="flex justify-between items-start">' +
              '<div>' +
                '<span class="font-bold text-white text-sm">#' + ev.eventId + ' ' + ev.eventTitle + '</span>' +
                (ev.alreadyRegistered ? ' <span class="bg-blue-500/20 text-blue-400 border border-blue-500/30 px-1.5 py-0.5 rounded text-[10px]">Already Registered</span>' : '') +
                '<a href="' + ev.eventUrl + '" target="_blank" class="block text-indigo-400 text-[11px] hover:underline truncate max-w-lg mt-0.5">' + ev.eventUrl + '</a>' +
              '</div>' +
              '<span class="text-[11px] text-gray-500 font-mono">' + (ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : '') + '</span>' +
            '</div>' +
            '<details class="mt-2 text-gray-400">' +
              '<summary class="cursor-pointer text-[11px] text-indigo-300 hover:text-indigo-200 select-none">📋 View ' + reqs.length + ' Filled Required Fields</summary>' +
              '<div class="mt-2 bg-gray-900/80 p-2.5 rounded-lg border border-gray-800 space-y-1">' + (reqRows || '<div class="text-gray-500 text-[11px]">No specific required fields.</div>') + '</div>' +
            '</details>' +
          '</div>';
        }).join('');
      } catch (e) {}
    }

    async function renderFailedEvents() {
      try {
        const res = await fetch("/api/results/failed");
        if (!res.ok) return;
        const list = await res.json();
        const container = document.getElementById("failed-list");
        if (!list || list.length === 0) {
          container.innerHTML = '<div class="text-gray-500 text-xs italic">No failed events recorded.</div>';
          return;
        }

        container.innerHTML = list.map((ev, idx) => {
          return '<div class="bg-gray-950/70 border border-red-950/40 rounded-xl p-3 text-xs">' +
            '<div class="flex justify-between items-start">' +
              '<div>' +
                '<span class="font-bold text-red-200 text-sm">#' + ev.eventId + ' ' + ev.eventTitle + '</span>' +
                '<a href="' + ev.eventUrl + '" target="_blank" class="block text-gray-400 text-[11px] hover:underline truncate max-w-lg mt-0.5">' + ev.eventUrl + '</a>' +
              '</div>' +
              '<span class="text-[11px] text-gray-500 font-mono">' + (ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : '') + '</span>' +
            '</div>' +
            '<div class="mt-2 text-[11px] text-red-400 bg-red-950/20 border border-red-900/30 p-2 rounded-lg">' +
              '<strong>Failure Reason:</strong> ' + (ev.failureReason || 'Incomplete registration') +
            '</div>' +
          '</div>';
        }).join('');
      } catch (e) {}
    }

    async function renderTeamSummary() {
      try {
        const res = await fetch("/api/team-summary");
        if (!res.ok) return;
        const data = await res.json();
        const container = document.getElementById("team-table");
        const keys = Object.keys(data);
        if (keys.length === 0) {
          container.innerHTML = '<div class="text-gray-500 text-xs italic">No team summary recorded yet.</div>';
          return;
        }

        let rows = keys.map(k => {
          const m = data[k];
          return '<tr class="border-b border-gray-800 text-xs">' +
            '<td class="py-2.5 font-bold text-white">' + m.name + '<br><span class="text-gray-500 font-normal">' + m.email + '</span></td>' +
            '<td class="py-2.5 font-mono text-blue-400">' + m.totalAttempted + ' / ' + m.totalPending + '</td>' +
            '<td class="py-2.5 font-mono text-emerald-400 font-bold">' + m.successCount + '</td>' +
            '<td class="py-2.5 font-mono text-amber-400">' + m.waitlistCount + '</td>' +
            '<td class="py-2.5 font-mono text-red-400">' + m.failedCount + '</td>' +
            '<td class="py-2.5 font-mono text-purple-400">' + m.remainingCount + '</td>' +
            '<td class="py-2.5 font-mono text-indigo-300">#' + (m.lastProcessedIndex + 2) + '</td>' +
            '<td class="py-2.5"><span class="px-2 py-0.5 rounded text-[10px] font-mono ' + (m.status === 'running' ? 'bg-emerald-500/20 text-emerald-400' : (m.status === 'paused' ? 'bg-amber-500/20 text-amber-400' : 'bg-gray-800 text-gray-400')) + '">' + (m.status || 'idle').toUpperCase() + '</span></td>' +
          '</tr>';
        }).join('');

        container.innerHTML = '<table class="w-full text-left font-sans">' +
          '<thead><tr class="border-b border-gray-700 text-gray-400 text-[11px] uppercase tracking-wider">' +
            '<th class="pb-2">Attendee</th><th class="pb-2">Attempted</th><th class="pb-2">Confirmed</th><th class="pb-2">Waitlist</th><th class="pb-2">Failed</th><th class="pb-2">Remaining</th><th class="pb-2">Next Event</th><th class="pb-2">Status</th>' +
          '</tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>';
      } catch (e) {}
    }

    async function sync() {
      try {
        const res = await fetch("/api/status?t=" + Date.now());
        if (!res.ok) return;
        const d = await res.json();
        
        document.getElementById("stat-total").innerText = d.stats.totalPending;
        document.getElementById("stat-attempted").innerText = d.stats.totalAttempted;
        document.getElementById("stat-success").innerText = d.stats.successCount;
        document.getElementById("stat-waitlist").innerText = d.stats.waitlistCount;
        document.getElementById("stat-failed").innerText = d.stats.failedCount;
        document.getElementById("stat-remaining").innerText = d.stats.remainingCount;

        document.getElementById("count-tab-confirmed").innerText = d.stats.successCount + d.stats.waitlistCount;
        document.getElementById("count-tab-failed").innerText = d.stats.failedCount;

        const total = d.stats.totalPending || 1;
        const pct = Math.min(100, Math.round((d.stats.totalAttempted / total) * 100));
        document.getElementById("progress-bar").style.width = pct + "%";
        document.getElementById("progress-text").innerText = pct + "% Complete (" + d.stats.totalAttempted + "/" + total + ")";

        const badge = document.getElementById("pipeline-badge");
        badge.innerText = d.status.toUpperCase();
        if (d.status === "running") {
          badge.className = "text-xs uppercase font-mono px-2.5 py-0.5 rounded-full font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30";
        } else if (d.status === "paused") {
          badge.className = "text-xs uppercase font-mono px-2.5 py-0.5 rounded-full font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30";
        } else if (d.status === "finished") {
          badge.className = "text-xs uppercase font-mono px-2.5 py-0.5 rounded-full font-bold bg-purple-500/20 text-purple-400 border border-purple-500/30";
        } else {
          badge.className = "text-xs uppercase font-mono px-2.5 py-0.5 rounded-full font-bold bg-gray-800 text-gray-400 border border-gray-700";
        }

        updatePauseButton(d.status);

        const ev = d.currentEvent;
        if (ev) {
          document.getElementById("current-title").innerText = "[" + ev.index + "/" + ev.total + "] " + ev.eventTitle;
          document.getElementById("current-url").innerText = ev.eventUrl;
          document.getElementById("current-url").href = ev.eventUrl;
          document.getElementById("current-step").innerText = ev.step + " (" + (ev.elapsedSeconds || 0) + "s)";
          document.getElementById("current-detail").innerText = ev.stepDetail || "";
        } else {
          document.getElementById("current-title").innerText = d.status === "finished" ? "🎉 All Events Completed!" : (d.status === "paused" ? "⏸️ Automation Paused" : "Ready");
          document.getElementById("current-step").innerText = d.status;
          document.getElementById("current-detail").innerText = "";
        }

        if (typeof d.lastProcessedIndex === "number" && d.lastProcessedIndex >= 0) {
          document.getElementById("resume-info").innerText = "Last saved at Event #" + (d.lastProcessedIndex + 1);
        }

        const breatherBanner = document.getElementById("breather-banner");
        if (d.breather && d.breather.active) {
          breatherBanner.classList.remove("hidden");
          document.getElementById("breather-timer").innerText = d.breather.remainingSec + "s";
        } else {
          breatherBanner.classList.add("hidden");
        }

        const feed = document.getElementById("log-feed");
        if (d.recentLogs && d.recentLogs.length > 0) {
          feed.innerHTML = d.recentLogs.map(l => {
            let color = "text-gray-300";
            if (l.type === "success") color = "text-emerald-400";
            if (l.type === "error") color = "text-red-400";
            if (l.type === "pacing") color = "text-blue-400";
            if (l.type === "warn") color = "text-amber-400";
            return '<div class="' + color + '"><span class="text-gray-600">[' + l.time + ']</span> ' + l.message + '</div>';
          }).join("");
        }
      } catch (e) {}
    }
    setInterval(sync, 1500);
    sync();
  </script>
</body>
</html>`;
  }
}
