import fs from "fs";
import path from "path";
import { DatabaseManager } from "./database.js";

async function main() {
  const args = process.argv.slice(2);
  const command = (args[0] || "summary").toLowerCase();
  const db = new DatabaseManager();

  // Always ensure historical results are synced
  db.backfillFromResults();

  const filterArg = args[1];
  const isAttendeeFilter = filterArg && isNaN(Number(filterArg));

  if (command === "summary") {
    db.printSummary(filterArg);
  } else if (command === "submitted") {
    const rows = db.getRegistrations({ 
      attendeeId: isAttendeeFilter ? filterArg : undefined, 
      isSubmitted: 1 
    });
    console.log(`\n==================================================================`);
    console.log(`✅ SUBMITTED / CONFIRMED EVENTS (${rows.length} total${filterArg ? ` for ${filterArg}` : ""})`);
    console.log(`==================================================================`);
    for (const r of rows) {
      console.log(`[#${r.event_id}] ${r.event_title}`);
      console.log(`   🔗 URL: ${r.event_url}`);
      console.log(`   👤 Attendee: ${r.attendee_name} | 🕒 ${r.submitted_at} | 📋 Fields: ${r.fields_count}`);
      console.log(`------------------------------------------------------------------`);
    }
  } else if (command === "not-submitted" || command === "failed") {
    const rows = db.getRegistrations({ 
      attendeeId: isAttendeeFilter ? filterArg : undefined, 
      isSubmitted: 0 
    });
    console.log(`\n==================================================================`);
    console.log(`❌ NOT SUBMITTED EVENTS (${rows.length} total${filterArg ? ` for ${filterArg}` : ""})`);
    console.log(`==================================================================`);
    for (const r of rows) {
      console.log(`[#${r.event_id}] ${r.event_title}`);
      console.log(`   🔗 URL: ${r.event_url}`);
      console.log(`   ⚠️ Reason: ${r.failure_reason || "Unconfirmed"}`);
      console.log(`   🕒 ${r.submitted_at} | 📋 Fields detected: ${r.fields_count}`);
      console.log(`------------------------------------------------------------------`);
    }
  } else if (command === "fields") {
    const eventId = args[1] ? parseInt(args[1], 10) : undefined;
    let query = "SELECT * FROM input_fields";
    const params: any[] = [];
    if (eventId) {
      query += " WHERE event_id = ?";
      params.push(eventId);
    }
    query += " ORDER BY id DESC LIMIT 50";
    const rows = (db as any).db.prepare(query).all(...params);

    console.log(`\n==================================================================`);
    console.log(`📋 INPUT FIELDS LOGGED (${rows.length} displayed)`);
    console.log(`==================================================================`);
    for (const f of rows) {
      console.log(`[Event #${f.event_id}] "${f.field_label}" (${f.field_type})`);
      console.log(`   • Required: ${f.is_required ? "Yes" : "No"} | Combobox: ${f.is_combobox ? "Yes" : "No"}`);
      console.log(`   • Value Filled: ${f.value_filled !== null ? `"${f.value_filled}"` : "(blank)"}`);
      if (f.options_available) {
        console.log(`   • Choices: ${f.options_available}`);
      }
      console.log(`------------------------------------------------------------------`);
    }
  } else if (command === "logs") {
    const eventId = args[1] ? parseInt(args[1], 10) : undefined;
    let query = "SELECT * FROM event_logs";
    const params: any[] = [];
    if (eventId) {
      query += " WHERE event_id = ?";
      params.push(eventId);
    }
    query += " ORDER BY id DESC LIMIT 100";
    const rows = (db as any).db.prepare(query).all(...params);

    console.log(`\n==================================================================`);
    console.log(`📜 EVENT STEP LOGS (${rows.length} entries)`);
    console.log(`==================================================================`);
    for (const l of rows) {
      console.log(`[Event #${l.event_id || "?"}] [${l.timestamp}] ${l.message}`);
    }
  } else if (command === "export") {
    const summary = db.getSummary();
    const allRegs = db.getRegistrations();
    const allFields = (db as any).db.prepare("SELECT * FROM input_fields").all();
    const allLogs = (db as any).db.prepare("SELECT * FROM event_logs").all();

    const exportData = {
      summary,
      counts: {
        totalAttempted: summary.totalAttempted,
        submitted: summary.submittedCount,
        notSubmitted: summary.notSubmittedCount,
        waitlist: summary.waitlistCount,
        totalFieldsRecorded: allFields.length,
        totalLogsRecorded: allLogs.length,
      },
      registrations: allRegs.map(r => ({
        ...r,
        fields_data: r.fields_data ? JSON.parse(r.fields_data) : [],
        event_logs: r.event_logs ? JSON.parse(r.event_logs) : [],
      })),
      inputFields: allFields,
      eventLogs: allLogs,
      exportedAt: new Date().toISOString(),
    };

    const outPath = path.resolve(process.cwd(), "data", "database-export.json");
    fs.writeFileSync(outPath, JSON.stringify(exportData, null, 2), "utf-8");
    console.log(`\n✅ Database successfully exported to: ${outPath}`);
    console.log(`📊 Exported ${allRegs.length} registrations, ${allFields.length} input fields, ${allLogs.length} logs.`);
  } else {
    console.log(`\nUsage: npx tsx src/db-cli.ts [summary|submitted|not-submitted|fields|logs|export]`);
  }

  db.close();
}

main().catch(console.error);
