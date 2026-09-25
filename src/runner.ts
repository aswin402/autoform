import { chromium, BrowserContext, Page } from "playwright";
import fs from "fs";
import path from "path";
import { Attendee, EventItem, EventResult, FieldRecord, RunnerOptions } from "./types.js";
import { resolveFieldValue } from "./resolver.js";
import { MonitorServer } from "./monitor.js";

interface FormFieldInfo {
  locator: any;
  tag: string;
  type: string;
  name: string;
  placeholder: string;
  label: string;
  isRequired: boolean;
  isCombobox: boolean;
  options?: string[];
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
    } else {
      const saved = this.monitor.getState();
      if (typeof saved.lastProcessedIndex === "number" && saved.lastProcessedIndex >= 0) {
        startIndex = saved.lastProcessedIndex + 1;
        this.monitor.log(`⏩ Auto-resuming saved progress: starting at Event #${startIndex + 1}/${this.events.length} (${startIndex} previously completed/attempted).`, "info");
      } else if (saved.stats.totalAttempted > 0) {
        startIndex = saved.stats.totalAttempted;
        this.monitor.log(`⏩ Auto-resuming from attempted count: starting at Event #${startIndex + 1}/${this.events.length}.`, "info");
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

      // STAGE 1: Pre-Check (Already Registered on Page Load)
      const pageText = await page.locator("body").innerText().catch(() => "");
      const isAlreadyOnPage = /You are registered|Your ticket|Manage Registration|Cancel Registration|You're going|Ticket: /i.test(pageText);

      if (isAlreadyOnPage) {
        console.log(`🎯 [PRE-CHECK: ALREADY REGISTERED]: Attendee is already registered for this event.`);
        this.monitor.log(`🎯 [#${ev.id}] Already Registered: ${ev.title}`, "success");
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
        result.status = "failed";
        result.failureReason = "Event sold out or registration closed";
        page.off("response", responseHandler);
        return result;
      }

      // 2. Open Registration Form
      this.monitor.updateCurrentEvent({
        index,
        total,
        eventId: ev.id,
        eventTitle: ev.title,
        eventUrl: ev.url,
        step: "Opening registration modal...",
        elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
      });

      const registerBtn = page
        .locator(
          "button:has-text('Register'), button:has-text('Request to Join'), button:has-text('RSVP'), button:has-text('Join Event'), button:has-text('Apply to Attend'), button:has-text('Join Waitlist'), a:has-text('Register')"
        )
        .first();

      if ((await registerBtn.count()) > 0 && (await registerBtn.isVisible().catch(() => false))) {
        await registerBtn.click({ force: true });
        await page.waitForTimeout(1500);
      }

      // STAGE 2: In-Modal Already Registered Check
      const modalText = await page.locator("[role='dialog'], form, .lux-modal").innerText().catch(() => "");
      if (/already registered|already applied|duplicate entry/i.test(modalText)) {
        console.log(`🎯 [MODAL: ALREADY REGISTERED]: Modal indicates attendee has already registered.`);
        this.monitor.log(`🎯 [#${ev.id}] Already Registered (Notice): ${ev.title}`, "success");
        result.status = "confirmed_success";
        result.alreadyRegistered = true;
        await page.keyboard.press("Escape").catch(() => {});
        page.off("response", responseHandler);
        return result;
      }

      // 3. Scan & Extract Form Fields
      const dialog = page.locator("[role='dialog'], form, .lux-modal").first();
      const hasDialog = (await dialog.count()) > 0;

      if (!hasDialog) {
        console.log("ℹ️ Single-click RSVP action (no complex form).");
      } else {
        const fields = await this.extractAllFields(page, dialog);
        console.log(`📋 Detected ${fields.length} interactive form fields.`);

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

          // 2.0s human delay per field (per user rule)
          await page.waitForTimeout(this.options.fieldDelayMs || 2000);
        }

        // PRE-FLIGHT CHECK: Ensure NO required dropdown or field is left blank before submitting!
        await this.verifyAndCompleteRequiredFields(page, dialog, fields, ev);
      }

      // 4. Click Submit Button
      this.monitor.updateCurrentEvent({
        index,
        total,
        eventId: ev.id,
        eventTitle: ev.title,
        eventUrl: ev.url,
        step: "Submitting registration form...",
        elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
      });

      // Ensure any ticket type is selected if unselected
      if (hasDialog) {
        const unselectedTickets = dialog.locator("button.ticket-type-btn:not(.selected)").first();
        const hasSelectedTicket = (await dialog.locator("button.ticket-type-btn.selected").count().catch(() => 0)) > 0;
        if (!hasSelectedTicket && (await unselectedTickets.count().catch(() => 0)) > 0) {
          console.log("   🎟️ Selecting first available ticket type...");
          await unselectedTickets.click({ force: true }).catch(() => {});
          await page.waitForTimeout(400);
        }
      }

      // Ensure any stray open dropdown popover is dismissed cleanly without closing dialog
      await page.evaluate(() => {
        const listbox = document.querySelector("[role='listbox'], .lux-menu-wrapper, [data-floating-ui-portal] [role='option']");
        if (listbox) {
          const stopper = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              e.stopImmediatePropagation();
            }
          };
          window.addEventListener("keydown", stopper, { capture: true, once: true });
          listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
        }
      }).catch(() => {});
      await page.waitForTimeout(200);

      // Locate submit action button (checking dialog first, then page)
      const submitBtn = await this.findSubmitButton(page, hasDialog ? dialog : null);

      if (submitBtn) {
        const btnText = (await submitBtn.innerText().catch(() => "")).replace(/\n/g, " ");
        console.log(`🚀 Found submission button [${btnText}]. Scrolling and clicking...`);
        this.monitor.log(`🚀 [#${ev.id}] Clicking submit button: "${btnText}"`, "info");
        await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(400);

        // Click with Playwright click AND DOM click fallback
        let clicked = false;
        try {
          await submitBtn.click({ force: true, timeout: 5000 });
          clicked = true;
          console.log("   ✅ Playwright click dispatched.");
        } catch (e: any) {
          console.log("   Standard click failed, executing direct DOM click dispatch...");
        }

        await submitBtn.evaluate((btn: HTMLElement) => {
          btn.focus();
          btn.click();
          btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          if ((btn as any).form) {
            (btn as any).form.requestSubmit();
          }
        }).catch(() => {});

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

          // Check if interactive Cloudflare Turnstile checkbox exists
          for (const f of page.frames()) {
            if (f.url().includes("challenges.cloudflare.com")) {
              try {
                const cb = f.locator("input[type='checkbox'], span.mark, #challenge-stage, div.cb-lb, #checkbox").first();
                if ((await cb.count().catch(() => 0)) > 0 && (await cb.isVisible({ timeout: 500 }).catch(() => false))) {
                  console.log("   👆 Interactive Cloudflare Turnstile checkbox detected! Clicking...");
                  this.monitor.log(`🛡️ [#${ev.id}] Clicking Cloudflare Turnstile verification checkbox...`, "pacing");
                  await cb.click({ force: true, timeout: 1000 }).catch(() => {});
                }
              } catch (e) {}
            }
          }

          const token = await page.evaluate(() => {
            const el = document.querySelector("input[name='cf-turnstile-response'], input[name*='turnstile']") as HTMLInputElement;
            return el && el.value ? el.value : null;
          }).catch(() => null);

          if (token && token.length > 20) {
            console.log("🎯 Turnstile cleared with token! Re-clicking submit button to finalize submission...");
            this.monitor.log(`🛡️ [#${ev.id}] Cloudflare Turnstile cleared! Finalizing submission...`, "success");
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

          // Check if dialog closed
          const isModalOpen = hasDialog && (await dialog.isVisible().catch(() => false));
          if (!isModalOpen) {
            console.log("🎯 Modal dismissed!");
            break;
          }
        }
      } else {
        console.log("⚠️ No submit button found with standard selector.");
      }

      await page.waitForTimeout(1000);

      // 5. STRICT POST-SUBMISSION VERIFICATION (0 Tolerance for False Successes)
      const postBodyText = await page.locator("body").innerText().catch(() => "");
      const isAlready = isAlreadyRegisteredServer || /already registered|already applied|duplicate entry|이미 등록|이미 신청/i.test(postBodyText);

      // If already registered or confirmed, dismiss any remaining modal so the screen is clean
      if (isAlready || isServerConfirmed) {
        await page.keyboard.press("Escape").catch(() => {});
        await page.locator("button[aria-label='Close'], button.lux-modal-close, button:has-text('✕')").first().click().catch(() => {});
      }

      const isModalStillOpen = await dialog.isVisible().catch(() => false);
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
      } else if (isWaitlisted) {
        result.status = "waitlist_joined";
        this.monitor.log(`⏳ [#${ev.id}] Waitlist Joined / Approval Pending: ${ev.title}`, "warn");
        console.log(`⏳ [WAITLIST JOINED]: Event #${ev.id} application submitted.`);
      } else if (visibleErrors > 0 && isModalStillOpen) {
        result.status = "failed";
        result.failureReason = `Form validation incomplete: ${visibleErrors} required field(s) were missing or unselected.`;
        this.monitor.log(`❌ [#${ev.id}] Incomplete: ${result.failureReason}`, "error");
        console.log(`❌ [SUBMISSION FAILED]: Event #${ev.id} blocked by validation errors.`);
      } else {
        result.status = "failed";
        result.failureReason = isModalStillOpen ? "Modal remained open without server confirmation" : "No ticket confirmation received";
        this.monitor.log(`❌ [#${ev.id}] Failed: ${result.failureReason}`, "error");
        console.log(`❌ [SUBMISSION FAILED]: Event #${ev.id} did not complete.`);
      }
    } catch (err: any) {
      console.error(`💥 Error automating event #${ev.id}:`, err.message);
      result.status = "failed";
      result.failureReason = err.message;
      this.monitor.log(`💥 [#${ev.id}] Exception: ${err.message}`, "error");
    } finally {
      page.off("response", responseHandler);
    }

    result.durationSeconds = Math.round((Date.now() - startTime) / 1000);
    return result;
  }

  private async extractAllFields(page: Page, dialog: any): Promise<FormFieldInfo[]> {
    // Look for all interactive inputs: text, comboboxes, custom select triggers, native selects, checkboxes
    const rawElements = await dialog
      .locator("input:not([type='hidden']), textarea, select, [role='combobox'], [aria-haspopup='listbox'], button[data-state]")
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

        let opts: string[] = [];
        if (node.tagName === "SELECT") {
          opts = Array.from(node.options).map((o: any) => (o.text || o.value || "").trim());
        }

        return {
          tag: node.tagName.toLowerCase(),
          type: (node.type || "").toLowerCase(),
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

  private async fillField(page: Page, f: FormFieldInfo, ev: EventItem): Promise<string> {
    // 1. Dropdown / Combobox
    if (f.isCombobox || f.tag === "select") {
      await f.locator.scrollIntoViewIfNeeded().catch(() => {});
      await f.locator.click({ force: true }).catch(() => {});
      await page.waitForTimeout(400);

      // Wait for Radix listbox options portal to mount
      await page.waitForSelector("[role='option'], [data-radix-collection-item], div[cmdk-item], .lux-option", { timeout: 800 }).catch(() => {});

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
        await page.waitForTimeout(300);

        // ENSURE DROPDOWN IS CLOSED: If popover is still open, close it cleanly
        const isPopoverStillOpen = await page.evaluate(() => {
          const pop = document.querySelector("[role='listbox'], [data-radix-popper-content-wrapper], .lux-menu-wrapper");
          return pop && (pop as HTMLElement).offsetWidth > 0 && (pop as HTMLElement).offsetHeight > 0;
        }).catch(() => false);

        if (isPopoverStillOpen) {
          console.log(`   🧹 Auto-closing open dropdown menu...`);
          await page.evaluate(() => {
            const listbox = document.querySelector("[role='listbox'], .lux-menu-wrapper, [data-floating-ui-portal] [role='option']");
            if (listbox) {
              const stopper = (e: KeyboardEvent) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  e.stopImmediatePropagation();
                }
              };
              window.addEventListener("keydown", stopper, { capture: true, once: true });
              listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
            }
          }).catch(() => {});
          await page.waitForTimeout(200);
        }

        return chosen.text;
      } else {
        await page.evaluate(() => {
          const listbox = document.querySelector("[role='listbox'], .lux-menu-wrapper, [data-floating-ui-portal] [role='option']");
          if (listbox) {
            const stopper = (e: KeyboardEvent) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                e.stopImmediatePropagation();
              }
            };
            window.addEventListener("keydown", stopper, { capture: true, once: true });
            listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
          }
        }).catch(() => {});
        return "None";
      }
    }

    // 2. Checkboxes (terms, consent, marketing)
    if (f.type === "checkbox") {
      let isChecked = await f.locator.isChecked().catch(() => false);
      if (!isChecked) {
        await f.locator.click({ force: true }).catch(() => {});
        await page.waitForTimeout(100);
        isChecked = await f.locator.isChecked().catch(() => false);
      }
      if (!isChecked) {
        // Force checked via DOM dispatch
        await f.locator.evaluate((el: any) => {
          const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked");
          if (desc && desc.set) desc.set.call(el, true);
          else el.checked = true;
          el.setAttribute("aria-checked", "true");
          el.dispatchEvent(new Event("click", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }).catch(() => {});
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
      await f.locator.scrollIntoViewIfNeeded().catch(() => {});
      await f.locator.focus().catch(() => {});
      await f.locator.fill(val).catch(() => {});
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
      if (!f.isRequired) continue;

      if (f.isCombobox) {
        const val = await f.locator.evaluate((node: any) => node.value || node.innerText || "").catch(() => "");
        if (!val || val.toLowerCase().includes("select")) {
          console.log(`   ⚠️ [Pre-Flight Warning]: Required combobox [${f.label}] was unfulfilled. Attempting recovery...`);
          await this.fillField(page, f, ev);
        }
      } else if (f.type !== "checkbox") {
        const val = await f.locator.inputValue().catch(() => "");
        if (!val || val.trim() === "") {
          console.log(`   ⚠️ [Pre-Flight Warning]: Required input [${f.label}] is blank. Filling with "None"...`);
          await f.locator.fill("None").catch(() => {});
        }
      }
    }
  }

  private async findSubmitButton(page: Page, dialog: any): Promise<any | null> {
    const selectors = [
      "button[type='submit']",
      "button.variant-color-brand",
      "button.lux-button.brand",
      "button.brand:not([role='combobox'])",
      ".lux-collapse.shown button",
      "button:has-text('Request to Join')",
      "button:has-text('Register')",
      "button:has-text('RSVP')",
      "button:has-text('Submit')",
      "button:has-text('Join Waitlist')",
      "button:has-text('Apply to Join')",
      "button:has-text('Apply to Attend')",
      "button:has-text('Apply')",
      "button:has-text('Get Tickets')",
      "button:has-text('참가 신청')",
      "button:has-text('신청하기')",
      "button:has-text('등록')",
      "button:has-text('제출')",
      "button:has-text('다음')",
      "button:has-text('Next')",
      "button:has-text('Continue')",
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

