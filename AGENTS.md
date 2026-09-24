# autoform — Agent Instructions

## Project
- **Runtime:** node
- **Package Manager:** npm
- **Purpose:** Standalone autonomous event registration engine (Playwright + TypeScript)

## Commands
- **start:** `tsx src/index.ts`
- **run:devishree:** `tsx src/index.ts --person devishree-mohan`
- **run:reset:** `tsx src/index.ts --person devishree-mohan --reset`
- **run:all:** `tsx src/index.ts --all-team`
- **build:** `tsc`

## Architecture
- **engine:** `src/runner.ts`
- **resolver:** `src/resolver.ts`
- **monitor:** `src/monitor.ts`
- **data:** `data/team.json`, `data/events.json`, `data/results.json`

## Guidelines
- Zero external LLM API dependency. 100% deterministic heuristic and semantic fast-path.
- Human pacing: 2s field delay, 5s next-event delay, 2m breather every 50 events.
- Never record false positives: verify ticket confirmation, zero visible validation errors, or server confirmation.
