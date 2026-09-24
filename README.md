# AutoForm — Standalone Autonomous Event Registration Engine

Autonomous event registration system for TOKEN2049 & KBW events with stealth browser automation, Radix combobox solver, persistent per-attendee state tracking, and anti-bot pacing.

## Features
- **Standalone & Framework-Free**: 0 heavy web framework dependencies (no Express, no Next.js). Pure TypeScript and Playwright.
- **Universal Radix Combobox Solver**: Handles headless Radix UI popovers, composite comboboxes, and floating dynamic portals (`[role="option"]`, `[data-radix-collection-item]`).
- **Strict Multi-Layer Verification**: Zero tolerance for false positives. Validates form closure, server 200/400 confirmation, or verified ticket confirmation screen.
- **3-Stage "Already Registered" Detector**: Gracefully skips previously registered events (Pre-Check on page, In-Modal notice, or API response).
- **Anti-Bot Shielding**: 2.0s human delay per field, 5.0s between events, 2.0-minute breather every 50 events, real Google Chrome with automation stealth.
- **Persistent State & Resume Guarantee**: 
  - Tracks state individually for all 6 team members (`data/results/<personId>.json`).
  - Closing the terminal or pressing Ctrl+C safely flushes progress and marks state as `paused`.
  - Re-running the automation automatically resumes at the exact next uncompleted event index without repeating prior work.
- **Interactive Live Dashboard**: Built-in monitor on port 3005 with:
  - **Pause / Resume Button**: Instantly pause the browser automation from the web UI and resume when ready.
  - **Tabs**: Real-time logs, confirmed registrations with filled required inputs accordion, failed events with failure reasons, and team-wide progress matrix.
- **Dedicated Audit & Text Logs**: Writes audit trails to `data/logs/<personId>.log` and structured results to `data/results/<personId>.json`.

## Commands
- `npm start`: Run or auto-resume automation for active person (defaults to Devishree Mohan, port 3005)
- `npm run run:devishree`: Run / resume for Devishree Mohan
- `npm run run:kamesh`: Run / resume for Kameshwaran Elangovan
- `npm run run:ram`: Run / resume for Ramkumar Subramanian
- `npm run run:all`: Run sequentially for all 6 team members (skipping completed ones)
- `npm run run:reset`: Reset saved state and restart from event #1
- `npx tsx src/index.ts --person <id>`: Run for any specific person by ID or name
- `npx tsx src/index.ts --limit 5`: Run a test batch of 5 events
- `npx tsx src/index.ts --headless`: Run in headless mode

## Architecture & Storage
- `src/runner.ts`: Browser automation engine, Turnstile auto-clearance, pacing, verification, signal traps.
- `src/resolver.ts`: Field solver matching labels to attendee persona, gender/age/country rules, and required field fallbacks.
- `src/monitor.ts`: Live HTML dashboard on port 3005, REST endpoints (`/api/status`, `/api/pause`, `/api/resume`, `/api/toggle-pause`), and audit logger.
- `data/team.example.json` -> `data/team.json`: Team members with full profiles, social links, company pitches, and Q&A memory.
- `data/events.example.json` -> `data/events.json`: Curated event registry.
- `data/results/<personId>.json`: Isolated state per team member (confirmed, waitlisted, failed, and filled inputs).
- `data/results/team-summary.json`: High-level progress matrix across all team members.
- `data/results.json`: Active attendee mirror for backward compatibility.
- `data/logs/<personId>.log`: Timestamped audit logs for each attendee.
