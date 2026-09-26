import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { EventResult, FieldRecord } from "./types.js";

export interface DatabaseSummary {
  attendeeId?: string;
  attendeeName?: string;
  totalEvents: number;
  totalAttempted: number;
  submittedCount: number;
  notSubmittedCount: number;
  waitlistCount: number;
  remainingCount: number;
  successRatePercent: number;
  lastUpdated: string;
}

export class DatabaseManager {
  private db: DatabaseSync;
  private dbPath: string;

  constructor(customPath?: string) {
    const dataDir = path.resolve(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.dbPath = customPath || path.resolve(dataDir, "autoform.db");
    this.db = new DatabaseSync(this.dbPath);
    this.init();
  }

  public init(): void {
    // 1. Registrations Master Table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS registrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL,
        event_title TEXT NOT NULL,
        event_url TEXT NOT NULL,
        attendee_id TEXT NOT NULL,
        attendee_name TEXT NOT NULL,
        attendee_email TEXT NOT NULL,
        status TEXT NOT NULL,
        is_submitted INTEGER NOT NULL,
        already_registered INTEGER DEFAULT 0,
        failure_reason TEXT,
        duration_seconds INTEGER DEFAULT 0,
        fields_count INTEGER DEFAULT 0,
        fields_data TEXT,
        event_logs TEXT,
        submitted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(event_url, attendee_id)
      );

      CREATE INDEX IF NOT EXISTS idx_reg_attendee ON registrations(attendee_id);
      CREATE INDEX IF NOT EXISTS idx_reg_status ON registrations(status);
      CREATE INDEX IF NOT EXISTS idx_reg_is_sub ON registrations(is_submitted);
      CREATE INDEX IF NOT EXISTS idx_reg_event ON registrations(event_id);
    `);

    // 2. Normalized Input Fields Table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS input_fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL,
        event_url TEXT NOT NULL,
        attendee_id TEXT NOT NULL,
        field_label TEXT NOT NULL,
        field_type TEXT NOT NULL,
        field_name TEXT,
        placeholder TEXT,
        is_required INTEGER NOT NULL,
        is_combobox INTEGER NOT NULL,
        value_filled TEXT,
        options_available TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_fields_event ON input_fields(event_id);
      CREATE INDEX IF NOT EXISTS idx_fields_attendee ON input_fields(attendee_id);
    `);

    // 3. Event Step Logs Table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS event_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER,
        event_url TEXT,
        attendee_id TEXT NOT NULL,
        log_type TEXT DEFAULT 'info',
        message TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_logs_event ON event_logs(event_id);
      CREATE INDEX IF NOT EXISTS idx_logs_attendee ON event_logs(attendee_id);
    `);

    // 4. Campaign Summary / Counters Table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS campaign_summary (
        attendee_id TEXT PRIMARY KEY,
        attendee_name TEXT NOT NULL,
        total_events INTEGER DEFAULT 0,
        total_attempted INTEGER DEFAULT 0,
        submitted_count INTEGER DEFAULT 0,
        not_submitted_count INTEGER DEFAULT 0,
        waitlist_count INTEGER DEFAULT 0,
        remaining_count INTEGER DEFAULT 0,
        success_rate_percent REAL DEFAULT 0.0,
        last_event_id INTEGER,
        last_event_title TEXT,
        updated_at TEXT NOT NULL
      );
    `);

    // Views for quick querying
    this.db.exec(`
      CREATE VIEW IF NOT EXISTS v_submitted_events AS
      SELECT event_id, event_title, event_url, attendee_name, status, fields_count, submitted_at
      FROM registrations
      WHERE is_submitted = 1;

      CREATE VIEW IF NOT EXISTS v_not_submitted_events AS
      SELECT event_id, event_title, event_url, attendee_name, status, failure_reason, fields_count, submitted_at
      FROM registrations
      WHERE is_submitted = 0;
    `);
  }

  /**
   * Save a single event result into registrations, input_fields, and event_logs
   */
  public saveRegistration(result: EventResult, eventLogs?: string[], skipSummary = false): void {
    const isSubmitted = result.status === "confirmed_success" || result.status === "waitlist_joined" ? 1 : 0;
    const now = new Date().toISOString();
    const attendeeId = result.attendeeId || "default";

    // 1. Insert or replace registration
    const regStmt = this.db.prepare(`
      INSERT INTO registrations (
        event_id, event_title, event_url, attendee_id, attendee_name, attendee_email,
        status, is_submitted, already_registered, failure_reason, duration_seconds,
        fields_count, fields_data, event_logs, submitted_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_url, attendee_id) DO UPDATE SET
        event_id = excluded.event_id,
        event_title = excluded.event_title,
        status = excluded.status,
        is_submitted = excluded.is_submitted,
        already_registered = excluded.already_registered,
        failure_reason = excluded.failure_reason,
        duration_seconds = excluded.duration_seconds,
        fields_count = excluded.fields_count,
        fields_data = excluded.fields_data,
        event_logs = excluded.event_logs,
        submitted_at = excluded.submitted_at,
        updated_at = excluded.updated_at
    `);

    const fieldsJson = JSON.stringify(result.allFields || []);
    const logsJson = JSON.stringify(eventLogs || result.eventLogs || []);

    regStmt.run(
      result.eventId,
      result.eventTitle,
      result.eventUrl,
      attendeeId,
      result.attendeeName,
      result.attendeeEmail,
      result.status,
      isSubmitted,
      result.alreadyRegistered ? 1 : 0,
      result.failureReason || null,
      result.durationSeconds || 0,
      (result.allFields || []).length,
      fieldsJson,
      logsJson,
      result.timestamp || now,
      now
    );

    // 2. Save normalized input fields
    if (Array.isArray(result.allFields) && result.allFields.length > 0) {
      // Clean previous fields for this event/attendee
      const delFields = this.db.prepare("DELETE FROM input_fields WHERE event_url = ? AND attendee_id = ?");
      delFields.run(result.eventUrl, attendeeId);

      const fieldStmt = this.db.prepare(`
        INSERT INTO input_fields (
          event_id, event_url, attendee_id, field_label, field_type,
          field_name, placeholder, is_required, is_combobox,
          value_filled, options_available, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const f of result.allFields) {
        fieldStmt.run(
          result.eventId,
          result.eventUrl,
          attendeeId,
          f.label || "Field",
          f.type || "text",
          f.name || null,
          f.placeholder || null,
          f.isRequired ? 1 : 0,
          f.isCombobox ? 1 : 0,
          f.valueFilled || null,
          f.options ? JSON.stringify(f.options) : null,
          now
        );
      }
    }

    // 3. Save logs
    const allLogs = eventLogs || result.eventLogs || [];
    if (allLogs.length > 0) {
      const logStmt = this.db.prepare(`
        INSERT INTO event_logs (event_id, event_url, attendee_id, log_type, message, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const log of allLogs) {
        logStmt.run(
          result.eventId,
          result.eventUrl,
          attendeeId,
          "event_step",
          typeof log === "string" ? log : JSON.stringify(log),
          now
        );
      }
    }

    // 4. Refresh campaign summary (skip during bulk batch backfill)
    if (!skipSummary) {
      this.refreshCampaignSummary(attendeeId, result.attendeeName, result.eventId, result.eventTitle);
    }
  }

  /**
   * Recalculates and stores aggregate metrics in campaign_summary
   */
  public refreshCampaignSummary(attendeeId: string, attendeeName: string, lastEventId?: number, lastEventTitle?: string): void {
    const countsStmt = this.db.prepare(`
      SELECT 
        COUNT(*) as total_attempted,
        SUM(CASE WHEN is_submitted = 1 AND status = 'confirmed_success' THEN 1 ELSE 0 END) as submitted_count,
        SUM(CASE WHEN is_submitted = 0 THEN 1 ELSE 0 END) as not_submitted_count,
        SUM(CASE WHEN status = 'waitlist_joined' THEN 1 ELSE 0 END) as waitlist_count
      FROM registrations
      WHERE attendee_id = ?
    `);

    const row = countsStmt.get(attendeeId) as any;
    const totalAttempted = row?.total_attempted || 0;
    const submittedCount = row?.submitted_count || 0;
    const notSubmittedCount = row?.not_submitted_count || 0;
    const waitlistCount = row?.waitlist_count || 0;
    const rate = totalAttempted > 0 ? Math.round(((submittedCount + waitlistCount) / totalAttempted) * 1000) / 10 : 0.0;
    const now = new Date().toISOString();

    const sumStmt = this.db.prepare(`
      INSERT INTO campaign_summary (
        attendee_id, attendee_name, total_events, total_attempted,
        submitted_count, not_submitted_count, waitlist_count, remaining_count,
        success_rate_percent, last_event_id, last_event_title, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(attendee_id) DO UPDATE SET
        attendee_name = excluded.attendee_name,
        total_attempted = excluded.total_attempted,
        submitted_count = excluded.submitted_count,
        not_submitted_count = excluded.not_submitted_count,
        waitlist_count = excluded.waitlist_count,
        success_rate_percent = excluded.success_rate_percent,
        last_event_id = COALESCE(excluded.last_event_id, campaign_summary.last_event_id),
        last_event_title = COALESCE(excluded.last_event_title, campaign_summary.last_event_title),
        updated_at = excluded.updated_at
    `);

    sumStmt.run(
      attendeeId,
      attendeeName,
      274, // default Token2049 total
      totalAttempted,
      submittedCount,
      notSubmittedCount,
      waitlistCount,
      Math.max(0, 274 - totalAttempted),
      rate,
      lastEventId || null,
      lastEventTitle || null,
      now
    );
  }

  /**
   * Get aggregate summary metrics
   */
  public getSummary(attendeeId?: string): DatabaseSummary {
    let query = `
      SELECT 
        attendee_id,
        attendee_name,
        COUNT(*) as total_attempted,
        SUM(CASE WHEN is_submitted = 1 THEN 1 ELSE 0 END) as submitted_count,
        SUM(CASE WHEN is_submitted = 0 THEN 1 ELSE 0 END) as not_submitted_count,
        SUM(CASE WHEN status = 'waitlist_joined' THEN 1 ELSE 0 END) as waitlist_count
      FROM registrations
    `;

    const params: any[] = [];
    if (attendeeId) {
      query += ` WHERE attendee_id = ? GROUP BY attendee_id`;
      params.push(attendeeId);
    }

    const row = this.db.prepare(query).get(...params) as any;
    const totalAttempted = row?.total_attempted || 0;
    const submittedCount = row?.submitted_count || 0;
    const notSubmittedCount = row?.not_submitted_count || 0;
    const waitlistCount = row?.waitlist_count || 0;
    const rate = totalAttempted > 0 ? Math.round(((submittedCount) / totalAttempted) * 1000) / 10 : 0.0;

    return {
      attendeeId: row?.attendee_id || attendeeId || "all",
      attendeeName: row?.attendee_name || "Team",
      totalEvents: 274,
      totalAttempted,
      submittedCount,
      notSubmittedCount,
      waitlistCount,
      remainingCount: Math.max(0, 274 - totalAttempted),
      successRatePercent: rate,
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Query registrations with optional filter
   */
  public getRegistrations(options: { attendeeId?: string; isSubmitted?: number; limit?: number; offset?: number } = {}): any[] {
    let query = "SELECT * FROM registrations WHERE 1=1";
    const params: any[] = [];

    if (options.attendeeId) {
      query += " AND attendee_id = ?";
      params.push(options.attendeeId);
    }
    if (typeof options.isSubmitted === "number") {
      query += " AND is_submitted = ?";
      params.push(options.isSubmitted);
    }

    query += " ORDER BY id DESC";

    if (options.limit) {
      query += " LIMIT ?";
      params.push(options.limit);
      if (options.offset) {
        query += " OFFSET ?";
        params.push(options.offset);
      }
    }

    return this.db.prepare(query).all(...params);
  }

  /**
   * Backfill historical events from data/results.json and data/results/*.json into SQLite
   */
  public backfillFromResults(): { imported: number; updated: number } {
    const dataDir = path.resolve(process.cwd(), "data");
    const resultsDir = path.resolve(dataDir, "results");
    let count = 0;

    const filesToScan: string[] = [];
    if (fs.existsSync(resultsDir)) {
      const files = fs.readdirSync(resultsDir).filter(f => f.endsWith(".json") && f !== "team-summary.json");
      for (const f of files) filesToScan.push(path.resolve(resultsDir, f));
    }
    const globalPath = path.resolve(dataDir, "results.json");
    if (fs.existsSync(globalPath) && !filesToScan.includes(globalPath)) {
      filesToScan.push(globalPath);
    }

    this.db.exec("BEGIN TRANSACTION;");
    const attendeesToRefresh = new Map<string, string>();

    try {
      for (const filePath of filesToScan) {
        try {
          const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          const attendee = raw.attendee || { id: "devishree-mohan", name: "Devishree Mohan", email: "devishree@openledger.xyz" };
          attendeesToRefresh.set(attendee.id, attendee.name);

          const successes: EventResult[] = Array.isArray(raw.successEvents) ? raw.successEvents : [];
          const unsuccesses: EventResult[] = Array.isArray(raw.unsuccessEvents) ? raw.unsuccessEvents : [];

          for (const res of unsuccesses) {
            res.attendeeId = res.attendeeId || attendee.id;
            res.attendeeName = res.attendeeName || attendee.name;
            res.attendeeEmail = res.attendeeEmail || attendee.email;
            this.saveRegistration(res, res.eventLogs, true);
            count++;
          }

          for (const res of successes) {
            res.attendeeId = res.attendeeId || attendee.id;
            res.attendeeName = res.attendeeName || attendee.name;
            res.attendeeEmail = res.attendeeEmail || attendee.email;
            this.saveRegistration(res, res.eventLogs, true);
            count++;
          }
        } catch (e: any) {
          console.warn(`[Database] Notice during backfill of ${filePath}: ${e.message}`);
        }
      }
      this.db.exec("COMMIT;");
    } catch (err: any) {
      this.db.exec("ROLLBACK;");
      console.error(`[Database] Backfill transaction error: ${err.message}`);
    }

    for (const [attId, attName] of attendeesToRefresh.entries()) {
      this.refreshCampaignSummary(attId, attName);
    }

    return { imported: count, updated: count };
  }

  /**
   * Formatted summary display
   */
  public printSummary(attendeeId?: string): void {
    const summary = this.getSummary(attendeeId);
    const submittedRows = this.getRegistrations({ attendeeId, isSubmitted: 1 });
    const notSubmittedRows = this.getRegistrations({ attendeeId, isSubmitted: 0 });

    console.log("\n==================================================================");
    console.log("💾 AUTOFORM SQLITE DATABASE SUMMARY (data/autoform.db)");
    console.log("==================================================================");
    console.log(`👤 Attendee       : ${summary.attendeeName} (${summary.attendeeId})`);
    console.log(`📊 Total Attempted: ${summary.totalAttempted} / ${summary.totalEvents}`);
    console.log(`✅ Submitted      : ${summary.submittedCount} events`);
    console.log(`❌ Not Submitted  : ${summary.notSubmittedCount} events`);
    console.log(`⏳ Waitlist       : ${summary.waitlistCount} events`);
    console.log(`📈 Success Rate   : ${summary.successRatePercent}%`);
    console.log(`🕒 Last Updated   : ${summary.lastUpdated}`);
    console.log("------------------------------------------------------------------");
    console.log(`📋 Total Input Fields Logged: ${(this.db.prepare("SELECT COUNT(*) as c FROM input_fields").get() as any)?.c || 0}`);
    console.log(`📜 Total Event Step Logs    : ${(this.db.prepare("SELECT COUNT(*) as c FROM event_logs").get() as any)?.c || 0}`);
    console.log("==================================================================\n");

    if (submittedRows.length > 0) {
      console.log("✅ Recent Submitted Events:");
      for (const r of submittedRows.slice(0, 5)) {
        console.log(`   • [#${r.event_id}] ${r.event_title} (${r.fields_count} fields recorded)`);
      }
    }

    if (notSubmittedRows.length > 0) {
      console.log("\n❌ Recent Not Submitted Events:");
      for (const r of notSubmittedRows.slice(0, 5)) {
        console.log(`   • [#${r.event_id}] ${r.event_title} -> Reason: ${r.failure_reason || "Unconfirmed"}`);
      }
    }
    console.log("==================================================================\n");
  }

  public close(): void {
    try {
      this.db.close();
    } catch {}
  }
}
