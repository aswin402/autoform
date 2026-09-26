import { chromium, BrowserContext, Page } from "playwright";
import fs from "fs";
import path from "path";
import { Attendee, EventItem, EventResult, FieldRecord, RunnerOptions } from "./types.js";
import { resolveFieldValue } from "./resolver.js";
import { MonitorServer } from "./monitor.js";

interface FormFieldInfo {
  id?: string;
  locator: any;
  tag: string;
  type: string;
  name: string;
  placeholder: string;
  label: string;
  isRequired: boolean;
  isCombobox: boolean;
  options?: string[];
  valueFilled?: string;
}

export class EventAutomationRunner {
  private attendee: Attendee;
  private events: EventItem[];
  private monitor: MonitorServer;
  private options: RunnerOptions;
  private context: BrowserContext | null = null;

  constructor(attendee: Attendee, events: EventItem[], monitor: MonitorServer, options: RunnerOptions = {}) {
    this.attendee = attendee;
    this.events = events;
    this.monitor = monitor;
    this.options = {
      fieldDelayMs: 2000,
      eventDelayMs: 5000,
      enableBreather: true,
      headless: false,
      ...options,
    };
  }

  public async start(): Promise<void> {
    this.monitor.setStatus("running");
    this.monitor.log(`🚀 Initializing automation engine for ${this.attendee.name} (${this.attendee.email})...`, "info");
    this.monitor.log(`📋 Total events in scope: ${this.events.length}. Anti-bot pacing: 2s field delay, 5s next-event delay, 2m breather every 50 events.`, "info");

    // Launch Chrome with stealth flags
    const chromePath = fs.existsSync("/usr/bin/google-chrome")
      ? "/usr/bin/google-chrome"
      : fs.existsSync("/usr/bin/google-chrome-stable")
      ? "/usr/bin/google-chrome-stable"
      : undefined;

    const baseProfileDir = path.resolve(process.cwd(), ".browser-profile");
    const profileDir = this.attendee.id === "devishree-mohan"
      ? baseProfileDir
      : path.resolve(baseProfileDir, this.attendee.id);

    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

    this.context = await chromium.launchPersistentContext(profileDir, {
      executablePath: chromePath,
      headless: !!this.options.headless,
      viewport: { width: 1280, height: 800 },
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-infobars",
      ],
    });

    const page = this.context.pages()[0] || (await this.context.newPage());

    const existingSuccessUrls = new Set(
      this.monitor.getState().successEvents.map(e => e.eventUrl)
    );

    // Compute resume index
    let startIndex = 0;
    if (this.options.retryFailed) {
      startIndex = 0;
      const unconfirmedCount = this.events.filter(e => !existingSuccessUrls.has(e.url)).length;
      this.monitor.log(`🔄 [--retry-failed]: Retrying unconfirmed/failed events (${unconfirmedCount} remaining) for ${this.attendee.name}.`, "info");
      if (unconfirmedCount === 0) {
        console.log(`\n🎉 All ${this.events.length} events are already confirmed successful for ${this.attendee.name}!`);
        this.monitor.log(`🎉 100% of events already confirmed successful for ${this.attendee.name}!`, "success");
        this.monitor.setStatus("finished");
        this.monitor.updateCurrentEvent(null);
        await this.context.close().catch(() => {});
        return;
      }
    } else if (this.options.reset) {
      startIndex = 0;
      this.monitor.log(`🔄 [--reset]: Starting fresh from Event #1 for ${this.attendee.name}.`, "info");
    } else if (typeof this.options.startFromIndex === "number") {
      startIndex = this.options.startFromIndex;
      this.monitor.log(`🎯 [--start-from]: Starting from Event #${startIndex + 1} for ${this.attendee.name}.`, "info");
    } else if (this.options.retryFailed) {
      startIndex = 0;
      this.monitor.log(`🎯 [--retry-failed]: Checking all ${this.events.length} events (skipping already confirmed).`, "info");
    } else {
      const saved = this.monitor.getState();
      const lastEventId = saved.lastProcessedEventId;
      const matchingIdx = lastEventId ? this.events.findIndex(e => e.id === lastEventId) : -1;
      if (matchingIdx >= 0) {
        startIndex = matchingIdx + 1;
        this.monitor.log(`⏩ Auto-resuming saved progress: starting at Event #${startIndex + 1}/${this.events.length} (after Event #${lastEventId}).`, "info");
      } else {
        startIndex = 0;
        this.monitor.log(`🎯 Starting campaign: evaluating all ${this.events.length} events for ${this.attendee.name}.`, "info");
      }
    }

    if (!this.options.retryFailed && startIndex >= this.events.length) {
      console.log(`\n🎉 All ${this.events.length} events have already been completed for ${this.attendee.name}!`);
      this.monitor.log(`🎉 All ${this.events.length} events already processed for ${this.attendee.name}! Use --reset to re-run.`, "success");
      this.monitor.setStatus("finished");
      this.monitor.updateCurrentEvent(null);
      await this.context.close().catch(() => {});
      return;
    }

    let processedCountInSession = 0;
    let isShuttingDown = false;
    let currentEventIndex = startIndex;

    // Graceful interrupt handlers (Ctrl+C / SIGTERM)
    const onExitSignal = async (signal: string) => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      console.log(`\n🛑 Caught ${signal}! Pausing automation and saving state for ${this.attendee.name}...`);
      this.monitor.setStatus("paused");
      this.monitor.log(`⏸️ Automation paused by ${signal}. Progress saved at Event #${currentEventIndex + 1}.`, "warn");
      this.monitor.saveResults();
      try {
        if (this.context) {
          await this.context.close().catch(() => {});
        }
      } catch {}
      this.monitor.stop();
      console.log(`💾 State safely persisted to data/results/${this.attendee.id}.json and data/results.json.`);
      console.log(`👉 To resume later, run: npm start -- --person ${this.attendee.id}\n`);
      process.exit(0);
    };

    process.once("SIGINT", () => onExitSignal("SIGINT"));
    process.once("SIGTERM", () => onExitSignal("SIGTERM"));

    this.context.on("close", () => {
      if (!isShuttingDown && this.monitor.getState().status === "running") {
        console.log(`\n⚠️ Browser context closed. Pausing automation and saving state...`);
        this.monitor.setStatus("paused");
        this.monitor.log("⚠️ Browser context closed. Automation paused and state saved.", "warn");
        this.monitor.saveResults();
      }
    });

    for (let i = startIndex; i < this.events.length; i++) {
      currentEventIndex = i;

      if (isShuttingDown || page.isClosed()) break;

      // Handle interactive pause via Dashboard or API
      while (this.monitor.isPaused() && !isShuttingDown) {
        this.monitor.updateCurrentEvent({
          index: i + 1,
          total: this.events.length,
          eventId: this.events[i].id,
          eventTitle: this.events[i].title,
          eventUrl: this.events[i].url,
          step: "⏸️ Automation PAUSED by user. Click Resume to continue.",
          elapsedSeconds: 0,
        });
        await new Promise(r => setTimeout(r, 1000));
      }
      if (isShuttingDown) break;

      if (typeof this.options.limit === "number" && processedCountInSession >= this.options.limit) {
        this.monitor.log(`⏹️ Reached limit of ${this.options.limit} events. Stopping.`, "info");
        break;
      }

      const ev = this.events[i];

      // If not resetting and already successful in persisted data, skip
      if (!this.options.reset && existingSuccessUrls.has(ev.url)) {
        this.monitor.log(`⏭️ [Event #${ev.id}] Already recorded as successful in results: ${ev.title}`, "info");
        continue;
      }

      console.log(`\n==================================================================`);
      console.log(`🎯 [${i + 1}/${this.events.length}] Processing Event #${ev.id}: ${ev.title}`);
      console.log(`🔗 URL: ${ev.url}`);
      console.log(`==================================================================`);

      const eventStartTime = Date.now();
      this.monitor.updateCurrentEvent({
        index: i + 1,
        total: this.events.length,
        eventId: ev.id,
        eventTitle: ev.title,
        eventUrl: ev.url,
        step: "Navigating to event page...",
        elapsedSeconds: 0,
      });

      const result = await this.processSingleEvent(page, ev, i + 1, this.events.length, eventStartTime);
      this.monitor.recordEventResult(result, i, ev.id);
      processedCountInSession++;

      // 5.0s Inter-Event Delay with live countdown
      const nextIndex = i + 2;
      const nextTitle = nextIndex <= this.events.length ? this.events[i + 1].title : "Done";
      console.log(`\n⏱️ [Pacing]: Resting 5.0s before advancing to next event (${nextIndex}/${this.events.length})...`);
      this.monitor.log(`⏱️ Resting 5.0s before next event: ${nextTitle}`, "pacing");
      for (let sec = 5; sec > 0; sec--) {
        if (page.isClosed()) break;
        this.monitor.updateCurrentEvent({
          index: i + 1,
          total: this.events.length,
          eventId: ev.id,
          eventTitle: ev.title,
          eventUrl: ev.url,
          step: `Pacing: Resting ${sec}s before next event...`,
          elapsedSeconds: Math.round((Date.now() - eventStartTime) / 1000),
        });
        await page.waitForTimeout(1000).catch(() => {});
      }

      if (page.isClosed()) break;

      // Check 2-minute breather every 50 events
      if (
        this.options.enableBreather &&
        processedCountInSession > 0 &&
        processedCountInSession % 50 === 0
      ) {
        this.monitor.log(`🛡️ 50 events completed in this session! Taking 2-minute anti-bot breather cooldown (120s)...`, "pacing");
        this.monitor.setBreather(true, 120);

        for (let s = 120; s > 0; s--) {
          if (page.isClosed()) break;
          this.monitor.setBreather(true, s);
          await page.waitForTimeout(1000).catch(() => {});
        }
        this.monitor.setBreather(false, 0);
        this.monitor.log(`✅ Breather cooldown finished. Resuming automation!`, "success");
      }
    }

    const finalStats = this.monitor.getState().stats;
    if (finalStats.remainingCount === 0 || finalStats.totalAttempted >= this.events.length) {
      this.monitor.setStatus("finished");
      this.monitor.updateCurrentEvent(null);
      this.monitor.log(`🎉 All ${this.events.length} events completed for ${this.attendee.name}! Total attempted: ${finalStats.totalAttempted}`, "success");
    } else {
      this.monitor.setStatus("paused");
      this.monitor.updateCurrentEvent(null);
      this.monitor.log(`⏸️ Automation session stopped. Progress saved. Attempted so far: ${finalStats.totalAttempted}/${this.events.length}`, "info");
    }
    await this.context.close().catch(() => {});
  }

  private async processSingleEvent(
    page: Page,
    ev: EventItem,
    index: number,
    total: number,
    startTime: number
  ): Promise<EventResult> {
    const eventLogs: string[] = [];
    const addLog = (msg: string) => {
      const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
      eventLogs.push(entry);
    };

    const result: EventResult = {
      eventId: ev.id,
      eventTitle: ev.title,
      eventUrl: ev.url,
      attendeeId: this.attendee.id,
      attendeeName: this.attendee.name,
      attendeeEmail: this.attendee.email,
      status: "failed",
      requiredFields: [],
      allFields: [],
      eventLogs,
      timestamp: new Date().toISOString(),
    };

    let isServerConfirmed = false;
    let isAlreadyRegisteredServer = false;
    let serverMessage = "";

    // Intercept network responses for confirmation & already-registered
    const responseHandler = async (res: any) => {
      try {
        const url = res.url();
        if (/luma\.com|api\.lu\.ma|event|ticket|register|join/i.test(url)) {
          const status = res.status();
          if (status === 200 && /register|join|ticket|rsvp/i.test(url)) {
            isServerConfirmed = true;
          } else if (status === 400 || status === 409 || status === 403) {
            const body = await res.text().catch(() => "");
            if (/already registered|already applied|duplicate|이미 등록|이미 신청/i.test(body)) {
              isAlreadyRegisteredServer = true;
              serverMessage = "You have already registered for this event.";
              console.log("🎯 [SERVER INTERCEPT]: Already registered response detected!");
            }
          }
        }
      } catch (e) {}
    };

    page.on("response", responseHandler);

    try {
      // 1. Navigate to event page
      await page.goto(ev.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2000);
      addLog(`Navigated to event page: ${ev.title} (${ev.url})`);

      // STAGE 1: Pre-Check (Already Registered on Page Load)
      const pageText = await page.locator("body").innerText().catch(() => "");
      const isAlreadyOnPage = /You are registered|Your ticket|Manage Registration|Cancel Registration|You're going|Ticket: /i.test(pageText);

      if (isAlreadyOnPage) {
        console.log(`🎯 [PRE-CHECK: ALREADY REGISTERED]: Attendee is already registered for this event.`);
        this.monitor.log(`🎯 [#${ev.id}] Already Registered: ${ev.title}`, "success");
        addLog("Pre-Check: Attendee already registered on page load.");
        result.status = "confirmed_success";
        result.alreadyRegistered = true;
        page.off("response", responseHandler);
        return result;
      }

      // Check if Sold Out (only if no Join Waitlist / Register button is present)
      const hasJoinBtn = (await page.locator("button:has-text('Join Waitlist'), button:has-text('Register'), button:has-text('Request to Join'), button:has-text('RSVP')").count().catch(() => 0)) > 0;
      if (!hasJoinBtn && /sold out|registration closed|rsvp closed/i.test(pageText)) {
        console.log(`🚫 [EVENT CLOSED]: Event is sold out or registrations are closed.`);
        this.monitor.log(`🚫 [#${ev.id}] Event Sold Out / Closed: ${ev.title}`, "warn");
        addLog("Pre-Check: Event is sold out or registrations are closed.");
        result.status = "failed";
        result.failureReason = "Event sold out or registration closed";
        page.off("response", responseHandler);
        return result;
      }

      // 2. Select any required tickets on the page before clicking registration button
      await this.handleTicketSelection(page);

      // 3. Open Registration Form
      this.monitor.updateCurrentEvent({
        index,
        total,
        eventId: ev.id,
        eventTitle: ev.title,
        eventUrl: ev.url,
        step: "Opening registration modal...",
        elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
      });

      const registerBtn = await this.findRegistrationButton(page);

      if (registerBtn) {
        const btnText = (await registerBtn.innerText().catch(() => "")).replace(/\n/g, " ").trim();
        console.log(`🚀 Found registration button [${btnText}]. Scrolling and clicking...`);
        await registerBtn.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(300);
        await registerBtn.click().catch(async () => {
          await registerBtn.click({ force: true }).catch(() => {});
        });
        addLog(`Clicked initial event registration button [${btnText}].`);

        // Wait up to 3500ms for modal / form container to appear
        await page.waitForSelector("[role='dialog'], form:has(input), .lux-modal, [aria-modal='true'], .lux-card:has(input)", { timeout: 3500 }).catch(() => {});
        await page.waitForTimeout(600);
      }

      // STAGE 2: In-Modal Already Registered Check
      const modalText = await page.locator("[role='dialog'], form, .lux-modal, [aria-modal='true']").innerText().catch(() => "");
      if (/already registered|already applied|duplicate entry/i.test(modalText)) {
        console.log(`🎯 [MODAL: ALREADY REGISTERED]: Modal indicates attendee has already registered.`);
        this.monitor.log(`🎯 [#${ev.id}] Already Registered (Notice): ${ev.title}`, "success");
        addLog("Modal Pre-Check: Attendee already registered notice detected.");
        result.status = "confirmed_success";
        result.alreadyRegistered = true;
        await page.keyboard.press("Escape").catch(() => {});
        page.off("response", responseHandler);
        return result;
      }

      // 4. Scan & Extract Form Fields
      let dialog: any = page.locator("[role='dialog'], .lux-modal, [aria-modal='true']").first();
      let hasDialog = (await dialog.count().catch(() => 0)) > 0 && (await dialog.isVisible().catch(() => false));

      if (!hasDialog) {
        const formEl = page.locator("form:has(input), .lux-card:has(input)").first();
        if ((await formEl.count().catch(() => 0)) > 0 && (await formEl.isVisible().catch(() => false))) {
          dialog = formEl;
          hasDialog = true;
        }
      }

      const targetContainer = hasDialog ? dialog : page;
      const interactiveInputsCount = await targetContainer
        .locator("input:not([type='hidden']), textarea, select, [role='combobox']")
        .count()
        .catch(() => 0);

      const isSingleClickRSVP = !hasDialog && interactiveInputsCount === 0;

      if (isSingleClickRSVP) {
        console.log("ℹ️ Single-click RSVP action (no complex form).");
        addLog("Single-click RSVP action (no multi-field modal).");
      } else {
        // Re-check ticket selection inside the form container if needed
        await this.handleTicketSelection(page, targetContainer);

        const fields = await this.extractAllFields(page, targetContainer);
        console.log(`📋 Detected ${fields.length} interactive form fields.`);
        addLog(`Detected ${fields.length} interactive form fields.`);

        for (let fIdx = 0; fIdx < fields.length; fIdx++) {
          const f = fields[fIdx];
          this.monitor.updateCurrentEvent({
            index,
            total,
            eventId: ev.id,
            eventTitle: ev.title,
            eventUrl: ev.url,
            step: `Filling [${fIdx + 1}/${fields.length}]: ${f.label.slice(0, 25)}`,
            stepDetail: `Type: ${f.isCombobox ? 'Combobox' : f.type} | Required: ${f.isRequired}`,
            elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
          });

          const rec: FieldRecord = {
            label: f.label,
            type: f.type,
            name: f.name,
            placeholder: f.placeholder,
            isRequired: f.isRequired,
            isCombobox: f.isCombobox,
            options: f.options,
          };
          result.allFields.push(rec);
          if (f.isRequired) result.requiredFields.push(rec);

          // Fill field with Combobox / Select / Input handler
          const val = await this.fillField(page, f, ev);
          rec.valueFilled = val;
          addLog(`Filled [${f.label}]: "${val || ''}"`);

          // 2.0s human delay per field (per user rule)
          await page.waitForTimeout(this.options.fieldDelayMs || 2000);
        }

        // PRE-FLIGHT CHECK: Ensure NO required dropdown or field is left blank before submitting!
        await this.verifyAndCompleteRequiredFields(page, targetContainer, fields, ev);
      }

      // 5. Click Submit Button
      this.monitor.updateCurrentEvent({
        index,
        total,
        eventId: ev.id,
        eventTitle: ev.title,
        eventUrl: ev.url,
        step: isSingleClickRSVP ? "Awaiting RSVP confirmation..." : "Submitting registration form...",
        elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
      });

      // Ensure any stray open dropdown popover is dismissed cleanly without closing dialog
      await this.closeOpenDropdownMenu(page);

      // Locate submit action button (checking dialog first, then page) - only if not single-click RSVP
      const submitBtn = isSingleClickRSVP ? null : await this.findSubmitButton(page, hasDialog ? dialog : null);

      if (submitBtn) {
        const btnText = (await submitBtn.innerText().catch(() => "")).replace(/\n/g, " ");
        console.log(`🚀 Found submission button [${btnText}]. Scrolling and clicking...`);
        this.monitor.log(`🚀 [#${ev.id}] Clicking submit button: "${btnText}"`, "info");
        addLog(`Clicked submission button: "${btnText}" with human-like mouse dispatch.`);
        await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(400);

        // Dispatch natural mouse click on submit button
        const box = await submitBtn.boundingBox().catch(() => null);
        if (box && box.width > 0 && box.height > 0) {
          const targetX = box.x + box.width / 2;
          const targetY = box.y + box.height / 2;

          await page.mouse.move(targetX, targetY, { steps: 5 }).catch(() => {});
          await page.waitForTimeout(200);

          await page.mouse.down().catch(() => {});
          await page.waitForTimeout(120);
          await page.mouse.up().catch(() => {});
          console.log("   ✅ Native mouse click dispatched on submit button.");
        } else {
          await submitBtn.click().catch(async () => {
            await submitBtn.click({ force: true }).catch(() => {});
          });
          console.log("   ✅ Standard click dispatched on submit button.");
        }

        // Cloudflare Turnstile & verification modal handling
        console.log("⏳ Watching for Turnstile clearance or server response for up to 25s...");
        for (let s = 1; s <= 25; s++) {
          if (isServerConfirmed || isAlreadyRegisteredServer) {
            console.log(`🎯 Server resolved submission at second ${s}!`);
            break;
          }

          // Instant DOM check for "already registered" toast or confirmation notice
          const currentBody = await page.evaluate(() => document.body ? document.body.innerText : "").catch(() => "");
          if (/already registered|already applied|duplicate entry|이미 등록|이미 신청/i.test(currentBody)) {
            console.log(`🎯 "Already Registered" notification detected on page at second ${s}!`);
            isAlreadyRegisteredServer = true;
            await page.keyboard.press("Escape").catch(() => {});
            break;
          }

          const isConfirmedScreen = /You are registered|Your ticket|Manage Registration|Cancel Registration|You're in|Add to Calendar|See you there|Application Submitted|Approval Pending|Waitlist Joined|You're on the waitlist|등록 완료|신청 완료|참가 확정/i.test(currentBody);
          if (isConfirmedScreen && !/join waitlist|request to join|register/i.test(currentBody.slice(0, 80))) {
            console.log(`🎯 Ticket/Waitlist confirmation detected on page at second ${s}!`);
            isServerConfirmed = true;
            break;
          }

          await page.waitForTimeout(1000);

          // Check if Terms modal popped up after clicking submit
          const acceptedTerms = await this.handleTermsModals(page);
          if (acceptedTerms) {
            console.log("🎯 Accepted event terms during submission! Re-clicking submit button...");
            addLog("Accepted event terms modal during submission.");
            await page.waitForTimeout(500);
            const reSubmitBtn = await this.findSubmitButton(page, hasDialog ? dialog : null);
            if (reSubmitBtn) {
              await reSubmitBtn.click({ force: true }).catch(() => {});
            }
          }

          // Detect if a verification / Turnstile challenge modal is presented
          const isVerifyingModal = await page.evaluate(() => {
            return /Verifying Your Browser|Verify you are human|Checking your browser/i.test(document.body?.innerText || "");
          }).catch(() => false);

          if (isVerifyingModal) {
            console.log("   ⚠️ [Verification Challenge]: 'Verifying Your Browser' challenge is active. Please complete it in the browser window...");
            this.monitor.log(`⚠️ [#${ev.id}] Human verification challenge detected. Awaiting completion in browser window...`, "warn");
            this.monitor.updateCurrentEvent({
              index,
              total,
              eventId: ev.id,
              eventTitle: ev.title,
              eventUrl: ev.url,
              step: "Awaiting human verification challenge in browser...",
              elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
            });

            // Wait up to 45s for the challenge modal to clear or resolve
            for (let waitSec = 0; waitSec < 45; waitSec++) {
              await page.waitForTimeout(1000);
              const stillVerifying = await page.evaluate(() => {
                return /Verifying Your Browser|Verify you are human|Checking your browser/i.test(document.body?.innerText || "");
              }).catch(() => false);

              const token = await page.evaluate(() => {
                const el = document.querySelector("input[name='cf-turnstile-response'], input[name*='turnstile']") as HTMLInputElement;
                return el && el.value ? el.value : null;
              }).catch(() => null);

              if (!stillVerifying || (token && token.length > 20)) {
                console.log("   ✅ Verification challenge cleared! Resuming submission...");
                this.monitor.log(`🛡️ [#${ev.id}] Verification cleared! Finalizing submission...`, "success");
                addLog("Human verification challenge cleared.");
                break;
              }
            }
          }

          const token = await page.evaluate(() => {
            const el = document.querySelector("input[name='cf-turnstile-response'], input[name*='turnstile']") as HTMLInputElement;
            return el && el.value ? el.value : null;
          }).catch(() => null);

          if (token && token.length > 20) {
            console.log("🎯 Turnstile cleared with token! Re-clicking submit button to finalize submission...");
            this.monitor.log(`🛡️ [#${ev.id}] Cloudflare Turnstile cleared! Finalizing submission...`, "success");
            addLog("Cloudflare Turnstile cleared with token. Re-submitting.");
            const finalizeBtn = await this.findSubmitButton(page, hasDialog ? dialog : null);
            if (finalizeBtn) {
              await finalizeBtn.scrollIntoViewIfNeeded().catch(() => {});
              await finalizeBtn.click({ force: true }).catch(() => {});
              await finalizeBtn.evaluate((btn: HTMLElement) => btn.click()).catch(() => {});
            }
            await page.waitForTimeout(2000);

            // Re-check page text immediately after finalize
            const postSubmitText = await page.locator("body").innerText().catch(() => "");
            if (/already registered|already applied|duplicate entry|이미 등록|이미 신청/i.test(postSubmitText)) {
              console.log("🎯 Already registered detected after token submission!");
              isAlreadyRegisteredServer = true;
              break;
            }
            if (/You are registered|Your ticket|Manage Registration|Application Submitted|Waitlist Joined|You're on the waitlist|등록 완료|신청 완료|참가 확정/i.test(postSubmitText)) {
              console.log("🎯 Confirmation reached after token submission!");
              isServerConfirmed = true;
              break;
            }
            break;
          }

          // Check if dialog closed (only if a modal was actually opened)
          if (hasDialog) {
            const isModalOpen = await dialog.isVisible().catch(() => false);
            if (!isModalOpen) {
              console.log("🎯 Modal dismissed!");
              break;
            }
          }
        }
      } else if (!isSingleClickRSVP) {
        console.log("⚠️ No submit button found with standard selector.");
        addLog("No submit button found with standard selector.");
      }

      await page.waitForTimeout(1000);

      // 6. STRICT POST-SUBMISSION VERIFICATION (0 Tolerance for False Successes)
      const postBodyText = await page.locator("body").innerText().catch(() => "");
      const isAlready = isAlreadyRegisteredServer || /already registered|already applied|duplicate entry|이미 등록|이미 신청/i.test(postBodyText);

      // If already registered or confirmed, dismiss any remaining modal so the screen is clean
      if (isAlready || isServerConfirmed) {
        await page.keyboard.press("Escape").catch(() => {});
        await page.locator("button[aria-label='Close'], button.lux-modal-close, button:has-text('✕')").first().click().catch(() => {});
      }

      const isModalStillOpen = hasDialog && (await dialog.isVisible().catch(() => false));
      const errTexts = await page.locator("text='This field is required'").all();
      let visibleErrors = 0;
      for (const err of errTexts) {
        if (await err.isVisible().catch(() => false)) visibleErrors++;
      }

      const isConfirmedTicket =
        !isModalStillOpen &&
        /You are registered|Your ticket|Manage Registration|Cancel Registration|You're in|Add to Calendar|See you there|등록 완료|신청 완료|참가 확정|내 티켓/i.test(postBodyText);

      const isWaitlisted =
        !isModalStillOpen &&
        /Application Submitted|Approval Pending|Awaiting Approval|Waitlist Joined|You're on the waitlist|You are on the waitlist|Waitlist|Under Review|승인 대기|대기자 등록|대기자 명단|접수 완료/i.test(postBodyText);

      if (isServerConfirmed || isAlready || isConfirmedTicket) {
        result.status = "confirmed_success";
        if (isAlready) result.alreadyRegistered = true;
        this.monitor.log(`✅ [#${ev.id}] Confirmed Success: ${ev.title}`, "success");
        console.log(`✅ [CONFIRMED SUCCESS]: Event #${ev.id} registered successfully!`);
        addLog(`Confirmed Success: ${ev.title}`);
      } else if (isWaitlisted) {
        result.status = "waitlist_joined";
        this.monitor.log(`⏳ [#${ev.id}] Waitlist Joined / Approval Pending: ${ev.title}`, "warn");
        console.log(`⏳ [WAITLIST JOINED]: Event #${ev.id} application submitted.`);
        addLog(`Waitlist Joined: ${ev.title}`);
      } else if (visibleErrors > 0 && isModalStillOpen) {
        result.status = "failed";
        result.failureReason = `Form validation incomplete: ${visibleErrors} required field(s) were missing or unselected.`;
        this.monitor.log(`❌ [#${ev.id}] Incomplete: ${result.failureReason}`, "error");
        console.log(`❌ [SUBMISSION FAILED]: Event #${ev.id} blocked by validation errors.`);
        addLog(`Failed: Form validation incomplete (${visibleErrors} fields unselected)`);
      } else {
        result.status = "failed";
        result.failureReason = isModalStillOpen ? "Modal remained open without server confirmation" : "No ticket confirmation received";
        this.monitor.log(`❌ [#${ev.id}] Failed: ${result.failureReason}`, "error");
        console.log(`❌ [SUBMISSION FAILED]: Event #${ev.id} did not complete.`);
        addLog(`Failed: ${result.failureReason}`);
      }
    } catch (err: any) {
      console.error(`💥 Error automating event #${ev.id}:`, err.message);
      result.status = "failed";
      result.failureReason = err.message;
      this.monitor.log(`💥 [#${ev.id}] Exception: ${err.message}`, "error");
      addLog(`Exception: ${err.message}`);
    } finally {
      page.off("response", responseHandler);
    }

    result.durationSeconds = Math.round((Date.now() - startTime) / 1000);
    return result;
  }

  private async extractAllFields(page: Page, dialog: any): Promise<FormFieldInfo[]> {
    // Look for all interactive inputs: text, comboboxes, custom select triggers, native selects, checkboxes
    const rawElements = await dialog
      .locator("input:not([type='hidden']), textarea, select, [role='combobox'], [role='checkbox'], [aria-haspopup='listbox'], button[data-state]")
      .all();

    const fields: FormFieldInfo[] = [];

    for (const el of rawElements) {
      if (!(await el.isVisible().catch(() => false))) {
        const hasVisibleParent = await el.evaluate((node: any) => {
          const p = node.closest("label, [role='checkbox'], div");
          return p && p.offsetWidth > 0 && p.offsetHeight > 0;
        }).catch(() => false);
        if (!hasVisibleParent) continue;
      }

      const info = await el.evaluate((node: any) => {
        if (node.classList && node.classList.contains("ticket-type-btn")) return null;
        if (node.closest && node.closest(".ticket-type-btn")) return null;
        if (node.tagName === "BUTTON" && node.closest(".checkbox-label, .lux-checkbox") && node.getAttribute("role") !== "checkbox") return null;

        let text = "";
        if (node.getAttribute("aria-labelledby")) {
          const lbl = document.getElementById(node.getAttribute("aria-labelledby"));
          if (lbl) text = lbl.innerText;
        }
        if (!text && node.id) {
          const lbl = document.querySelector(`label[for="${node.id}"]`) as HTMLElement;
          if (lbl) text = lbl.innerText;
        }
        if (!text) {
          const wrapper = node.closest(".lux-input-wrapper, label");
          if (wrapper) {
            const lbl = wrapper.querySelector("label, .lux-input-label");
            if (lbl) text = (lbl as HTMLElement).innerText;
          }
        }
        if (!text) {
          let cur = node.parentElement;
          for (let i = 0; i < 5 && cur; i++) {
            if (cur.tagName === "LABEL") {
              text = cur.innerText;
              break;
            }
            const prev = cur.previousElementSibling;
            if (prev && (prev.tagName === "LABEL" || prev.tagName === "SPAN" || prev.tagName === "P")) {
              text = (prev as HTMLElement).innerText;
              break;
            }
            cur = cur.parentElement;
          }
        }

        let req = node.required || node.getAttribute("aria-required") === "true";
        if (!req && text && /[\*]|required|필수/i.test(text)) req = true;

        const isCb =
          node.getAttribute("role") === "combobox" ||
          node.getAttribute("aria-haspopup") === "listbox" ||
          (node.getAttribute("placeholder") || "").toLowerCase().includes("select") ||
          node.tagName === "SELECT" ||
          node.hasAttribute("data-radix-collection-item");

        const isCheckbox =
          (node.type || "").toLowerCase() === "checkbox" ||
          node.getAttribute("role") === "checkbox" ||
          node.classList?.contains("checkbox") ||
          node.closest?.(".lux-checkbox, .checkbox-label") !== null;

        let opts: string[] = [];
        if (node.tagName === "SELECT") {
          opts = Array.from(node.options).map((o: any) => (o.text || o.value || "").trim());
        }

        return {
          id: node.id || "",
          tag: node.tagName.toLowerCase(),
          type: isCheckbox ? "checkbox" : (node.type || "").toLowerCase(),
          name: node.getAttribute("name") || "",
          placeholder: node.getAttribute("placeholder") || "",
          label: (text || "").replace(/\n+/g, " ").trim(),
          isRequired: !!req,
          isCombobox: isCb,
          options: opts,
        };
      });

      if (!info) continue;

      fields.push({
        id: info.id,
        locator: el,
        tag: info.tag,
        type: info.type,
        name: info.name,
        placeholder: info.placeholder,
        label: info.label || info.placeholder || info.name || "Field",
        isRequired: info.isRequired,
        isCombobox: info.isCombobox,
        options: info.options,
      });
    }

    return fields;
  }

  private getDynamicLocator(page: Page, f: FormFieldInfo): any {
    if (f.id) {
      const byId = page.locator(`#${f.id}`);
      return byId;
    }
    if (f.name) {
      const byName = page.locator(`[name="${f.name}"]`);
      return byName;
    }
    return f.locator;
  }

  private async fillField(page: Page, f: FormFieldInfo, ev: EventItem): Promise<string> {
    const targetLocator = this.getDynamicLocator(page, f);

    // 1. Dropdown / Combobox
    if (f.isCombobox || f.tag === "select") {
      await targetLocator.scrollIntoViewIfNeeded().catch(() => {});
      await targetLocator.click({ force: true }).catch(() => {});
      await page.waitForTimeout(400);

      // Wait for Radix listbox options portal to mount
      await page.waitForSelector("[role='option'], [data-radix-collection-item], div[cmdk-item], .lux-option", { timeout: 2000 }).catch(() => {});

      const optionElements = await page.locator("[role='option'], [data-radix-collection-item], div[cmdk-item], .lux-option").all();
      const availableOptions: { element: any; text: string }[] = [];

      for (const optEl of optionElements) {
        if (await optEl.isVisible().catch(() => false)) {
          const txt = (await optEl.innerText().catch(() => "")).trim();
          if (txt) availableOptions.push({ element: optEl, text: txt });
        }
      }

      const optTexts = availableOptions.map(o => o.text);
      console.log(`   📋 Dropdown [${f.label.slice(0, 30)}] has ${optTexts.length} options:`, optTexts.slice(0, 6));

      const res = resolveFieldValue(
        {
          label: f.label,
          placeholder: f.placeholder,
          nameAttr: f.name,
          type: "select",
          options: optTexts.length > 0 ? optTexts : f.options,
          isRequired: f.isRequired,
        },
        this.attendee,
        { title: ev.title, url: ev.url }
      );

      const targetValue = res.value || (optTexts.length > 0 ? optTexts[0] : "None");

      // Match target option in list
      let chosen = availableOptions.find(o => o.text.toLowerCase() === targetValue.toLowerCase());
      if (!chosen) {
        chosen = availableOptions.find(
          o => o.text.toLowerCase().includes(targetValue.toLowerCase()) || targetValue.toLowerCase().includes(o.text.toLowerCase())
        );
      }
      // Guaranteed safe fallback: pick option 0 if required
      if (!chosen && availableOptions.length > 0 && f.isRequired) {
        chosen = availableOptions[0];
      }

      if (chosen) {
        console.log(`   ✅ Selected option: "${chosen.text}"`);
        try {
          await chosen.element.click({ timeout: 2000 });
        } catch {
          await chosen.element.click({ force: true }).catch(() => {});
        }
        await page.waitForTimeout(400);

        // If the combobox menu remains open (e.g. multi-select / tag picker), close it cleanly
        const stillOpen = await page.evaluate(() => {
          const pop = document.querySelector(
            "[data-floating-ui-portal] .lux-menu, [role='listbox']:not([aria-hidden='true']), .lux-menu:not([aria-hidden='true']), [cmdk-root]:not([aria-hidden='true'])"
          );
          return !!(pop && (pop as HTMLElement).offsetWidth > 0 && (pop as HTMLElement).offsetHeight > 0);
        }).catch(() => false);

        if (stillOpen) {
          console.log(`   🧹 Multi-select menu still open; dismissing popover cleanly...`);
          await this.closeOpenDropdownMenu(page);
        }

        f.valueFilled = chosen.text;
        return chosen.text;
      } else {
        await this.closeOpenDropdownMenu(page);
        f.valueFilled = "None";
        return "None";
      }
    }

    // 2. Checkboxes (terms, consent, marketing)
    if (f.type === "checkbox") {
      let isChecked = await targetLocator.isChecked().catch(() => false);
      if (!isChecked) {
        // Try clicking directly or on its container/label
        await targetLocator.click({ force: true }).catch(async () => {
          await targetLocator.evaluate((el: any) => {
            const clickable = el.closest("label, .lux-checkbox, [role='checkbox'], span.checkbox-icon") || el;
            clickable.click();
          }).catch(() => {});
        });

        // Pacing & modal animation wait
        await page.waitForTimeout(400);

        // Check if Event Terms modal appeared and accept it
        await this.handleTermsModals(page);

        isChecked = await targetLocator.isChecked().catch(() => false);
      }

      // If still not checked, try clicking the label or terms button
      if (!isChecked) {
        const labelOrTermsBtn = await targetLocator.evaluateHandle((el: any) => {
          const wrapper = el.closest("label, .checkbox-label, div");
          const termsBtn = wrapper?.querySelector("button, a");
          return termsBtn || wrapper || el;
        }).catch(() => null);

        if (labelOrTermsBtn) {
          await (labelOrTermsBtn as any).click().catch(() => {});
          await page.waitForTimeout(400);
          await this.handleTermsModals(page);
          isChecked = await targetLocator.isChecked().catch(() => false);
        }
      }

      // Final fallback: DOM force check if not checked
      if (!isChecked) {
        await targetLocator.evaluate((el: any) => {
          const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked");
          if (desc && desc.set) desc.set.call(el, true);
          else el.checked = true;
          el.setAttribute("aria-checked", "true");
          el.dispatchEvent(new Event("click", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }).catch(() => {});
        await page.waitForTimeout(200);
        await this.handleTermsModals(page);
      }

      console.log(`   ☑️ Checked [${f.label.slice(0, 30)}]`);
      return "true";
    }

    // 3. Text, Email, Tel, URL, Textarea
    const res = resolveFieldValue(
      {
        label: f.label,
        placeholder: f.placeholder,
        nameAttr: f.name,
        type: f.type,
        isRequired: f.isRequired,
      },
      this.attendee,
      { title: ev.title, url: ev.url }
    );

    let val = res.value;
    if (f.isRequired && (!val || val.trim() === "")) {
      val = "None"; // User preference: fallback to "None" for required fields without data
    }

    if (val) {
      await targetLocator.scrollIntoViewIfNeeded().catch(() => {});
      await targetLocator.focus().catch(() => {});
      await targetLocator.fill(val).catch(() => {});
      console.log(`   ✍️ Filled [${f.label.slice(0, 25)}]: "${val.length > 20 ? val.slice(0, 18) + '...' : val}"`);
    }

    return val;
  }

  private async verifyAndCompleteRequiredFields(
    page: Page,
    dialog: any,
    fields: FormFieldInfo[],
    ev: EventItem
  ): Promise<void> {
    for (const f of fields) {
      const targetLocator = this.getDynamicLocator(page, f);
      if (f.isCombobox) {
        if (f.isRequired) {
          const isFulfilled = await targetLocator.evaluate((node: any) => {
            if (node.value && node.value.trim().length > 0 && !node.value.toLowerCase().includes("select")) return true;
            const txt = (node.innerText || "").trim();
            if (txt && !txt.toLowerCase().includes("select") && !/^select\s*(one|all|any)?/i.test(txt)) return true;
            const wrapper = node.closest(".lux-menu-trigger-wrapper, .select-input-wrapper, .lux-input-wrapper, div") || node;
            const tags = wrapper.querySelectorAll(".lux-tag, [class*='badge'], [class*='tag'], [class*='pill'], [class*='chip'], button");
            if (tags.length > 0) return true;
            const fullText = (wrapper.innerText || "").trim();
            const lines = fullText.split("\n").map((l: string) => l.trim()).filter((l: string) => l && !l.includes("?") && !l.toLowerCase().includes("select"));
            if (lines.length > 0) return true;
            return false;
          }).catch(() => false);

          if (!isFulfilled && !f.valueFilled) {
            console.log(`   ⚠️ [Pre-Flight Warning]: Required combobox [${f.label}] was unfulfilled. Attempting recovery...`);
            await this.fillField(page, f, ev);
          }
        }
      } else if (f.type === "checkbox") {
        const isTermsOrConsent = /agree|term|consent|약관|동의|policy|privacy/i.test(f.label);
        if (f.isRequired || isTermsOrConsent) {
          const isChecked = await targetLocator.isChecked({ timeout: 1000 }).catch(() => false);
          if (!isChecked) {
            console.log(`   ⚠️ [Pre-Flight Warning]: Checkbox [${f.label.slice(0, 30)}] was unchecked. Checking...`);
            await this.fillField(page, f, ev);
          }
        }
      }
    }

    // Check if any "Event Terms" modal is currently lingering open
    await this.handleTermsModals(page);

    // Check if there is an unchecked terms checkbox and explicit error message
    const hasUncheckedTerms = await page.evaluate(() => {
      const unchecked = document.querySelector("input[type='checkbox']:not(:checked), [role='checkbox'][aria-checked='false']");
      return !!unchecked;
    }).catch(() => false);

    if (hasUncheckedTerms) {
      const explicitError = page.locator(".text-danger, .error, [role='alert'], .text-red-500").filter({ hasText: /agree to the event terms|must agree/i }).first();
      if ((await explicitError.count().catch(() => 0)) > 0 && (await explicitError.isVisible().catch(() => false))) {
        console.log(`   ⚠️ [Pre-Flight Warning]: Explicit terms error detected on unchecked box! Resolving...`);
        const termsCb = page.locator("input[type='checkbox']:not(:checked), [role='checkbox'][aria-checked='false']").first();
        if ((await termsCb.count().catch(() => 0)) > 0) {
          await termsCb.click({ force: true }).catch(() => {});
          await page.waitForTimeout(400);
          await this.handleTermsModals(page);
        }
      }
    }
  }

  private async handleTermsModals(page: Page): Promise<boolean> {
    const termsModalSelectors = [
      "[role='dialog']:has-text('Event Terms')",
      ".lux-modal:has-text('Event Terms')",
      "[role='dialog']:has-text('Terms & Conditions')",
      "[role='dialog']:has-text('Terms and Conditions')",
      "div:has-text('Event Terms'):has(button:has-text('Sign & Accept'))",
      "div:has-text('Event Terms'):has(button:has-text('Accept'))",
    ];

    let foundModal: any = null;
    for (const sel of termsModalSelectors) {
      const modal = page.locator(sel).first();
      if ((await modal.count().catch(() => 0)) > 0 && (await modal.isVisible().catch(() => false))) {
        foundModal = modal;
        break;
      }
    }

    if (foundModal) {
      console.log(`   📜 "Event Terms" modal detected! Inspecting digital signature requirement...`);
      this.monitor.log(`📜 Detected Event Terms modal. Checking signature input...`, "info");

      // Check if signature input exists (textarea / input / .lux-naked-input)
      const sigInput = foundModal.locator("textarea, input[type='text'], .lux-naked-input, [placeholder*='Smith' i]").first();
      if ((await sigInput.count().catch(() => 0)) > 0 && (await sigInput.isVisible().catch(() => false))) {
        const curVal = await sigInput.inputValue().catch(() => "");
        if (!curVal || curVal.trim() === "") {
          console.log(`   ✍️ Signing terms waiver with attendee legal name: "${this.attendee.name}"...`);
          await sigInput.focus().catch(() => {});
          await sigInput.fill(this.attendee.name).catch(() => {});
          await page.waitForTimeout(300);
        }
      }

      // Check for Sign & Accept or Accept button inside modal
      const modalAcceptBtn = foundModal.locator(
        "button:has-text('Sign & Accept'), button:has-text('Sign and Accept'), button:has-text('Accept Terms'), button:has-text('Accept & Continue'), button:has-text('Agree & Continue'), button:has-text('Accept'), button:has-text('I Agree'), button:has-text('Agree')"
      ).first();

      if ((await modalAcceptBtn.count().catch(() => 0)) > 0 && (await modalAcceptBtn.isVisible().catch(() => false))) {
        const btnText = (await modalAcceptBtn.innerText().catch(() => "")).trim();
        console.log(`   ✅ Clicking "${btnText}" in Event Terms modal...`);
        await modalAcceptBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(600);
        return true;
      }
    }

    // Generic fallback for any other terms accept buttons on page
    const acceptSelectors = [
      "button:has-text('Sign & Accept')",
      "button:has-text('Sign and Accept')",
      "button:has-text('Accept Terms')",
      "button:has-text('Accept terms')",
      "button:has-text('Accept & Continue')",
      "button:has-text('Agree & Continue')",
      "button:has-text('Accept')",
      "button:has-text('I Agree')",
      "button:has-text('Agree')",
      "button:has-text('동의')",
      "button:has-text('약관 동의')",
      ".lux-modal button.primary:has-text('Accept')",
      "[role='dialog'] button:has-text('Accept')",
    ];

    for (const sel of acceptSelectors) {
      try {
        const btn = page.locator(sel).first();
        if ((await btn.count().catch(() => 0)) > 0 && (await btn.isVisible().catch(() => false))) {
          const text = await btn.innerText().catch(() => "");
          console.log(`   📜 Terms accept button detected! Clicking "${text.trim() || sel}"...`);
          await btn.click({ force: true }).catch(() => {});
          await page.waitForTimeout(600);
          return true;
        }
      } catch (e) {}
    }

    return false;
  }

  private async closeOpenDropdownMenu(page: Page): Promise<void> {
    const isMenuOpen = await page.evaluate(() => {
      const pop = document.querySelector(
        "[data-floating-ui-portal] .lux-menu:not([aria-hidden='true']), [role='listbox']:not([aria-hidden='true']), [data-radix-select-content][data-state='open'], .lux-menu:not([aria-hidden='true']), [cmdk-root]:not([aria-hidden='true'])"
      );
      return !!(pop && (pop as HTMLElement).offsetWidth > 0 && (pop as HTMLElement).offsetHeight > 0);
    }).catch(() => false);

    if (isMenuOpen) {
      console.log(`   🧹 Soft-closing lingering dropdown menu without closing modal...`);

      // 1. If Floating UI portal overlay exists, click it (standard Floating UI dismiss)
      const portalOverlay = page.locator("[data-floating-ui-portal] .lux-overlay").first();
      if ((await portalOverlay.count().catch(() => 0)) > 0 && (await portalOverlay.isVisible().catch(() => false))) {
        await portalOverlay.click({ force: true }).catch(() => {});
        await page.waitForTimeout(300);
      } else {
        // 2. Safe click on modal/form header to blur popover
        const modalHeader = page.locator("[role='dialog'] h1, [role='dialog'] h2, [role='dialog'] .lux-modal-header, .lux-modal h3, .lux-modal-title, .form-header").first();
        if ((await modalHeader.count().catch(() => 0)) > 0 && (await modalHeader.isVisible().catch(() => false))) {
          await modalHeader.click({ force: true }).catch(() => {});
        } else {
          // 3. Fallback: mouse click on margin (10, 10)
          await page.mouse.click(10, 10).catch(() => {});
        }
        await page.waitForTimeout(300);
      }
    }
  }

  private async handleTicketSelection(page: Page, container?: any): Promise<boolean> {
    const root = container || page;

    // 1. Multi-ticket counter buttons (e.g. .ticket-type-btn.multi)
    const multiTickets = await root.locator(".ticket-type-btn.multi").all();
    if (multiTickets.length > 0) {
      let anySelected = false;
      for (const mt of multiTickets) {
        const countText = (await mt.locator(".count").innerText().catch(() => "0")).trim();
        if (countText !== "0" && countText !== "") {
          anySelected = true;
          break;
        }
      }

      if (!anySelected) {
        console.log("   🎟️ Selecting 1 ticket for multi-ticket option...");
        for (const mt of multiTickets) {
          const isDisabled = await mt.getAttribute("disabled");
          const text = await mt.innerText().catch(() => "");
          if (!isDisabled && !/sold out|sales ended|registration closed/i.test(text)) {
            const plus = mt.locator(".count-button:not(.disabled)").last();
            if ((await plus.count().catch(() => 0)) > 0) {
              await plus.click({ force: true }).catch(() => {});
            } else {
              await mt.click({ force: true }).catch(() => {});
            }
            await page.waitForTimeout(400);
            return true;
          }
        }
      }
    }

    // 2. Single-select ticket buttons (e.g. button.ticket-type-btn:not(.multi))
    const singleTickets = await root.locator("button.ticket-type-btn:not(.multi)").all();
    if (singleTickets.length > 0) {
      const hasSelected = (await root.locator("button.ticket-type-btn.selected").count().catch(() => 0)) > 0;
      if (!hasSelected) {
        console.log("   🎟️ Selecting first available ticket type...");
        for (const st of singleTickets) {
          const isDisabled = await st.getAttribute("disabled");
          const text = await st.innerText().catch(() => "");
          if (!isDisabled && !/sold out|sales ended|registration closed/i.test(text)) {
            await st.click({ force: true }).catch(() => {});
            await page.waitForTimeout(400);
            return true;
          }
        }
      }
    }

    return false;
  }

  private async findRegistrationButton(page: Page): Promise<any | null> {
    const actionSelectors = [
      "button.variant-color-primary:not(.ticket-type-btn):not([role='combobox'])",
      "button.lux-button.brand:not(.ticket-type-btn):not([role='combobox'])",
      "button.brand:not([role='combobox']):not(.ticket-type-btn)",
      "button:not(.ticket-type-btn):not([role='combobox']):has-text('Request to Join')",
      "button:not(.ticket-type-btn):not([role='combobox']):has-text('Register')",
      "button:not(.ticket-type-btn):not([role='combobox']):has-text('RSVP')",
      "button:not(.ticket-type-btn):not([role='combobox']):has-text('Join Event')",
      "button:not(.ticket-type-btn):not([role='combobox']):has-text('Apply to Attend')",
      "button:not(.ticket-type-btn):not([role='combobox']):has-text('Join Waitlist')",
      "button:not(.ticket-type-btn):not([role='combobox']):has-text('Get Tickets')",
      "button:not(.ticket-type-btn):not([role='combobox']):has-text('Apply')",
      "a.btn:not(.ticket-type-btn):has-text('Register')",
      "a.btn:not(.ticket-type-btn):has-text('Request to Join')",
      "a.btn:not(.ticket-type-btn):has-text('RSVP')",
      "a.btn:not(.ticket-type-btn):has-text('Join Waitlist')",
      "button:has-text('참가 신청')",
      "button:has-text('신청하기')",
      "button:has-text('등록')",
    ];

    for (const sel of actionSelectors) {
      const btn = page.locator(sel).first();
      if ((await btn.count().catch(() => 0)) > 0 && (await btn.isVisible().catch(() => false))) {
        return btn;
      }
    }
    return null;
  }

  private async findSubmitButton(page: Page, dialog: any): Promise<any | null> {
    const selectors = [
      "button[type='submit']:not(.ticket-type-btn)",
      "button.variant-color-brand:not(.ticket-type-btn)",
      "button.variant-color-primary:not(.ticket-type-btn)",
      "button.lux-button.brand:not(.ticket-type-btn)",
      "button.brand:not([role='combobox']):not(.ticket-type-btn)",
      ".lux-collapse.shown button:not(.ticket-type-btn)",
      "button:not(.ticket-type-btn):not([role='combobox']):has-text('Request to Join')",
      "button:not(.ticket-type-btn):not([role='combobox']):has-text('Register')",
      "button:not(.ticket-type-btn):not([role='combobox']):has-text('RSVP')",
      "button:not(.ticket-type-btn):not([role='combobox']):has-text('Submit')",
      "button:not(.ticket-type-btn):not([role='combobox']):has-text('Join Waitlist')",
      "button:not(.ticket-type-btn):not([role='combobox']):has-text('Apply to Join')",
      "button:not(.ticket-type-btn):not([role='combobox']):has-text('Apply to Attend')",
      "button:not(.ticket-type-btn):not([role='combobox']):has-text('Apply')",
      "button:not(.ticket-type-btn):not([role='combobox']):has-text('Get Tickets')",
      "button:not(.ticket-type-btn):has-text('참가 신청')",
      "button:not(.ticket-type-btn):has-text('신청하기')",
      "button:not(.ticket-type-btn):has-text('등록')",
      "button:not(.ticket-type-btn):has-text('제출')",
      "button:not(.ticket-type-btn):has-text('다음')",
      "button:not(.ticket-type-btn):has-text('Next')",
      "button:not(.ticket-type-btn):has-text('Continue')",
    ];

    if (dialog && (await dialog.count().catch(() => 0)) > 0) {
      for (const sel of selectors) {
        const btn = dialog.locator(sel).last();
        if ((await btn.count().catch(() => 0)) > 0 && (await btn.isVisible().catch(() => false))) {
          return btn;
        }
      }
    }

    for (const sel of selectors) {
      const btn = page.locator(`[role='dialog'] ${sel}, form ${sel}, .lux-modal ${sel}`).last();
      if ((await btn.count().catch(() => 0)) > 0 && (await btn.isVisible().catch(() => false))) {
        return btn;
      }
    }

    for (const sel of selectors) {
      const btn = page.locator(sel).last();
      if ((await btn.count().catch(() => 0)) > 0 && (await btn.isVisible().catch(() => false))) {
        return btn;
      }
    }

    return null;
  }
}

