# Queue Deadlock Lifecycle Fix

## TL;DR
> **Summary**: Fix the queue deadlock class by making BullMQ scrape/crawl processors wait for the matching Crawlee job/session to reach a terminal state before BullMQ can complete, with bounded timeout, cleanup, and observability.
> **Deliverables**:
> - A small lifecycle module that tracks per-BullMQ-job Crawlee completion without growing oversized worker files.
> - Worker processors that await scrape/crawl terminal state inside the processor promise, not in `completed` event listeners.
> - Scheduler/execution finalization that stays aligned with `finalizeExecution()`.
> - Regression tests and real worker/API QA proving Playwright/Crawlee progress drains or fails instead of leaving jobs stuck.
> **Effort**: Large
> **Parallel**: YES - 4 waves
> **Critical Path**: Task 1 -> Task 2 -> Task 3 -> Task 5 -> Final Verification

## Context
### Original Request
The user reported that queues previously accumulated hundreds of tasks, then all became stuck, and Playwright stopped automatically processing. They specifically said BullMQ queue completion should also finish the Crawlee queue, and asked whether there is a better, more suitable approach.

### Interview Summary
- No extra user clarification is required.
- Default decision: implement a lifecycle fix, not a one-off cleanup script.
- Better framing: BullMQ should not force-end a shared Crawlee queue. Instead, BullMQ job completion must mean that the Crawlee request(s) belonging to that BullMQ job reached a terminal state or a bounded timeout/cancel path.

### Gap Review (gaps addressed)
- Background research/gap agents were inconclusive before timeout; the plan uses direct repo and installed-package evidence rather than counting agent output as approval.
- Avoid relying on BullMQ `completed` event listeners for execution finalization because BullMQ emits `completed` after `job.moveToCompleted(...)` in `node_modules/.pnpm/bullmq@5.58.6/node_modules/bullmq/dist/cjs/classes/worker.js:516`.
- Avoid dropping or ending the whole per-engine Crawlee queue because `Utils.getQueue()` opens shared queues named `${engine}_queue` in `packages/scrape/src/Utils.ts:95`; dropping one would affect unrelated jobs.
- Because `Worker.ts`, `Base.ts`, `EngineConfigurator.ts`, `Scheduler.ts`, and `Progress.ts` already exceed 250 pure LOC, new logic must be extracted into small modules and existing oversized files should only receive narrow wiring edits.

## Work Objectives
### Core Objective
Make scrape/crawl BullMQ jobs stay active until the Crawlee work for that same job reaches a terminal state, preventing premature BullMQ completion, scheduler false-success, and unbounded queue buildup.

### Deliverables
- `packages/scrape/src/managers/CrawleeJobLifecycle.ts`: per-job waiter/state helper, under 250 pure LOC.
- `packages/scrape/src/__tests__/managers/CrawleeJobLifecycle.test.ts`: RED-first unit tests for terminal, timeout, and cancellation behavior.
- `packages/scrape/src/managers/WorkerJobProcessor.ts`: extracted worker processor logic from `Worker.ts`, under 250 pure LOC.
- Minimal wiring edits in `packages/scrape/src/Worker.ts`, `packages/scrape/src/managers/Worker.ts`, `packages/scrape/src/managers/Progress.ts`, and `packages/libs/src/config.ts`.
- Optional `.env.example` and docker compose env additions for new timeout/concurrency knobs.
- Documentation update under `docs/` explaining BullMQ/Crawlee lifecycle semantics.

### Definition of Done
- RED then GREEN evidence for lifecycle and worker processor tests.
- `pnpm typecheck --filter=@anycrawl/scrape` passes.
- Manual QA starts Redis/Postgres/API/worker locally and proves a Playwright crawl job remains non-completed while Crawlee work is pending and becomes completed/failed only after the lifecycle terminal condition.
- No direct terminal writes to `task_executions` outside `finalizeExecution()`.

### Must Have
- BullMQ processor promise awaits one of: `completed`, `failed`, `cancelled`, or `timeout` for the matching job id.
- `completed` and `failed` scheduled executions are finalized inside the awaited processor path or by a helper it calls, not solely in BullMQ `completed` event listeners.
- Crawl terminal truth continues to use `ProgressManager.tryFinalize()` for counters and result summary.
- Scrape terminal truth uses existing DB/job status updates from `BaseEngine`/`JobManager`/`completedJob`/`failedJob`, but the processor waits for those to become visible.
- Queue mode is backpressured by active BullMQ jobs; it must not instantly complete jobs after enqueue and allow hundreds of cron executions to pile up.
- Skip mode continues to detect `pending`/`running` executions as in `packages/scrape/src/managers/Scheduler.ts:493`.

### Must NOT Have
- Do not call `queue.drop()` or clear the shared per-engine Crawlee queue for a single BullMQ job.
- Do not mark scheduled executions terminal outside `finalizeExecution()`.
- Do not weaken or delete existing tests.
- Do not add `any`, `as any`, `@ts-ignore`, or `@ts-expect-error` in new code.
- Do not refactor unrelated CloakBrowser/cache/billing/template behavior.
- Do not run destructive git commands or revert existing dirty worktree changes.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD / Jest for this repo, using `packages/scrape` test setup.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.omo/evidence/task-{N}-{slug}.{txt,json,log,png}`
- RED evidence must be captured before production edits for every behavior task.
- Manual QA channel: HTTP call and tmux.

## Execution Strategy
### Parallel Execution Waves
Wave 1: Tasks 1, 2, 4
Wave 2: Tasks 3, 5, 6
Wave 3: Tasks 7, 8, 9
Wave 4: Tasks 10, 11, 12, Final Verification

### Dependency Matrix
| Task | Blocks | Blocked By |
| --- | --- | --- |
| 1 | 3, 5, 6, 7 | none |
| 2 | 3, 5 | none |
| 3 | 5, 7, 8 | 1, 2 |
| 4 | 8, 10 | none |
| 5 | 7, 8, 10 | 1, 2, 3 |
| 6 | 7, 8 | 1 |
| 7 | 10, 11 | 1, 3, 5, 6 |
| 8 | 10, 11 | 3, 4, 5, 6 |
| 9 | 10, 11 | none |
| 10 | 12 | 4, 5, 7, 8, 9 |
| 11 | 12 | 7, 8, 9 |
| 12 | Final Verification | 10, 11 |

## TODOs
> Implementation + Test = ONE task. Every task must have references, acceptance criteria, QA scenarios, and commit guidance.

- [ ] 1. Add RED tests for per-job lifecycle waiting

  **What to do**: Create `packages/scrape/src/__tests__/managers/CrawleeJobLifecycle.test.ts` before production code. Test terminal completion, timeout, failed terminal state, and ignoring unrelated jobs. Use fake readers and fake sleeper.
  **Must NOT do**: Do not create production code first. Do not depend on wall-clock sleeps.
  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 3, 5, 6, 7 | Blocked By: none
  **References**:
  - `packages/scrape/src/__tests__/managers/EngineQueue.test.ts:3`
  - `packages/scrape/src/__tests__/managers/Scheduler.lifecycle.test.ts:47`
  - `packages/scrape/src/managers/Queue.ts:167`
  **Acceptance Criteria**:
  - [ ] RED command fails: `pnpm test --filter=@anycrawl/scrape -- --runTestsByPath packages/scrape/src/__tests__/managers/CrawleeJobLifecycle.test.ts`
  - [ ] Evidence saved to `.omo/evidence/task-1-crawlee-lifecycle-red.txt`.
  **QA Scenarios**:
  ```
  Scenario: Unit RED captures missing lifecycle waiter
    Tool: bash
    Steps: pnpm test --filter=@anycrawl/scrape -- --runTestsByPath packages/scrape/src/__tests__/managers/CrawleeJobLifecycle.test.ts
    Expected: Non-zero exit and failure mentions CrawleeJobLifecycle or expected timeout behavior.
    Evidence: .omo/evidence/task-1-crawlee-lifecycle-red.txt

  Scenario: No real queue dependency in lifecycle unit test
    Tool: bash
    Steps: rg -n "new Queue|RequestQueue|IORedis|setTimeout\\(" packages/scrape/src/__tests__/managers/CrawleeJobLifecycle.test.ts
    Expected: No matches except type-only imports if needed.
    Evidence: .omo/evidence/task-1-no-real-queue.txt
  ```
  **Commit**: YES | Message: `test(scrape): capture crawlee job lifecycle wait contract` | Files: `packages/scrape/src/__tests__/managers/CrawleeJobLifecycle.test.ts`

- [ ] 2. Add RED tests for worker processor awaiting Crawlee terminal state

  **What to do**: Create `packages/scrape/src/__tests__/managers/WorkerJobProcessor.test.ts` before production code. Test enqueue, crawl progress seed, wait before resolve, timeout throw, and scheduled execution finalization through `finalizeExecution()`.
  **Must NOT do**: Do not import `packages/scrape/src/Worker.ts` directly because it has top-level side effects.
  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 3, 5 | Blocked By: none
  **References**:
  - `packages/scrape/src/Worker.ts:179`
  - `packages/scrape/src/Worker.ts:259`
  - `packages/scrape/src/Worker.ts:300`
  - `packages/scrape/src/Worker.ts:280`
  **Acceptance Criteria**:
  - [ ] RED command fails: `pnpm test --filter=@anycrawl/scrape -- --runTestsByPath packages/scrape/src/__tests__/managers/WorkerJobProcessor.test.ts`
  - [ ] Evidence saved to `.omo/evidence/task-2-worker-processor-red.txt`.
  **QA Scenarios**:
  ```
  Scenario: Processor RED proves enqueue-only return is forbidden
    Tool: bash
    Steps: pnpm test --filter=@anycrawl/scrape -- --runTestsByPath packages/scrape/src/__tests__/managers/WorkerJobProcessor.test.ts
    Expected: Non-zero exit and failure proves processor does not yet await lifecycle terminal state.
    Evidence: .omo/evidence/task-2-worker-processor-red.txt

  Scenario: Worker.ts remains side-effect free for tests
    Tool: bash
    Steps: rg -n "from \"../../Worker|from '../Worker|src/Worker" packages/scrape/src/__tests__/managers/WorkerJobProcessor.test.ts
    Expected: No matches.
    Evidence: .omo/evidence/task-2-no-worker-import.txt
  ```
  **Commit**: YES | Message: `test(scrape): capture worker processor terminal wait contract` | Files: `packages/scrape/src/__tests__/managers/WorkerJobProcessor.test.ts`

- [ ] 3. Implement `CrawleeJobLifecycle` waiter

  **What to do**: Add `packages/scrape/src/managers/CrawleeJobLifecycle.ts` under 250 pure LOC. Implement injected `waitForJobTerminal`, terminal-state resolution, timeout message, and typed timeout error/result.
  **Must NOT do**: Do not add Redis/Crawlee direct dependency to this helper.
  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: 5, 7, 8 | Blocked By: 1, 2
  **References**:
  - `packages/scrape/src/managers/Queue.ts:191`
  - `packages/scrape/src/managers/Progress.ts:319`
  - `node_modules/.pnpm/bullmq@5.58.6/node_modules/bullmq/dist/cjs/classes/worker.js:516`
  **Acceptance Criteria**:
  - [ ] `pnpm test --filter=@anycrawl/scrape -- --runTestsByPath packages/scrape/src/__tests__/managers/CrawleeJobLifecycle.test.ts` passes.
  - [ ] `awk '!/^[[:space:]]*$/ && !/^[[:space:]]*\\/\\//' packages/scrape/src/managers/CrawleeJobLifecycle.ts | wc -l` prints `250` or less.
  - [ ] Evidence saved to `.omo/evidence/task-3-crawlee-lifecycle-green.txt`.
  **QA Scenarios**:
  ```
  Scenario: Lifecycle waiter goes GREEN
    Tool: bash
    Steps: pnpm test --filter=@anycrawl/scrape -- --runTestsByPath packages/scrape/src/__tests__/managers/CrawleeJobLifecycle.test.ts
    Expected: Exit 0 and lifecycle tests pass.
    Evidence: .omo/evidence/task-3-crawlee-lifecycle-green.txt

  Scenario: New lifecycle module stays small
    Tool: bash
    Steps: awk '!/^[[:space:]]*$/ && !/^[[:space:]]*\/\//' packages/scrape/src/managers/CrawleeJobLifecycle.ts | wc -l
    Expected: Numeric output <= 250.
    Evidence: .omo/evidence/task-3-loc.txt
  ```
  **Commit**: YES | Message: `fix(scrape): add crawlee job lifecycle waiter` | Files: `packages/scrape/src/managers/CrawleeJobLifecycle.ts`, `packages/scrape/src/__tests__/managers/CrawleeJobLifecycle.test.ts`

- [ ] 4. Add typed runtime config for lifecycle timeouts and worker concurrency

  **What to do**: Extend `packages/libs/src/config.ts` with lazy `config.queue` getters for `ANYCRAWL_BULLMQ_WORKER_CONCURRENCY`, `ANYCRAWL_QUEUE_LIFECYCLE_POLL_INTERVAL_MS`, `ANYCRAWL_SCRAPE_LIFECYCLE_TIMEOUT_MS`, and `ANYCRAWL_CRAWL_LIFECYCLE_TIMEOUT_MS`; add tests and `.env.example` docs.
  **Must NOT do**: Do not read env eagerly at import time.
  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 8, 10 | Blocked By: none
  **References**:
  - `packages/libs/src/config.ts:63`
  - `packages/libs/src/config.ts:87`
  - `.env.example:35`
  - `packages/scrape/src/managers/Worker.ts:27`
  **Acceptance Criteria**:
  - [ ] RED test in `packages/libs/src/__tests__/config.test.ts` fails before config changes.
  - [ ] `pnpm test --filter=@anycrawl/libs -- --runTestsByPath packages/libs/src/__tests__/config.test.ts` passes after implementation.
  - [ ] Evidence saved to `.omo/evidence/task-4-config-red.txt` and `.omo/evidence/task-4-config-green.txt`.
  **QA Scenarios**:
  ```
  Scenario: Config getters parse defaults and env overrides
    Tool: bash
    Steps: pnpm test --filter=@anycrawl/libs -- --runTestsByPath packages/libs/src/__tests__/config.test.ts
    Expected: Exit 0 and queue config tests pass.
    Evidence: .omo/evidence/task-4-config-green.txt

  Scenario: Env documentation mentions lifecycle knobs
    Tool: bash
    Steps: rg -n "ANYCRAWL_BULLMQ_WORKER_CONCURRENCY|ANYCRAWL_QUEUE_LIFECYCLE_POLL_INTERVAL_MS|ANYCRAWL_CRAWL_LIFECYCLE_TIMEOUT_MS|ANYCRAWL_SCRAPE_LIFECYCLE_TIMEOUT_MS" .env.example
    Expected: All four env names are present.
    Evidence: .omo/evidence/task-4-env-docs.txt
  ```
  **Commit**: YES | Message: `fix(config): add queue lifecycle runtime settings` | Files: `packages/libs/src/config.ts`, `packages/libs/src/__tests__/config.test.ts`, `.env.example`

- [ ] 5. Extract and implement `WorkerJobProcessor`

  **What to do**: Add `packages/scrape/src/managers/WorkerJobProcessor.ts` under 250 pure LOC. It should export `processEngineJob(job, deps)`, enqueue into Crawlee, seed crawl progress, update job data, await `CrawleeJobLifecycle`, throw on failed/timeout terminal, and finalize scheduled executions idempotently.
  **Must NOT do**: Do not keep scheduled execution terminal state only in `worker.on("completed")`. Do not import top-level `Worker.ts`.
  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: 7, 8, 10 | Blocked By: 1, 2, 3
  **References**:
  - `packages/scrape/src/Worker.ts:179`
  - `packages/scrape/src/Worker.ts:56`
  - `packages/scrape/src/managers/ExecutionLifecycle.ts:45`
  - `packages/scrape/src/Worker.ts:222`
  **Acceptance Criteria**:
  - [ ] `pnpm test --filter=@anycrawl/scrape -- --runTestsByPath packages/scrape/src/__tests__/managers/WorkerJobProcessor.test.ts packages/scrape/src/__tests__/managers/CrawleeJobLifecycle.test.ts` passes.
  - [ ] New module is <= 250 pure LOC.
  - [ ] Evidence saved to `.omo/evidence/task-5-worker-processor-green.txt`.
  **QA Scenarios**:
  ```
  Scenario: Processor awaits terminal state before resolving
    Tool: bash
    Steps: pnpm test --filter=@anycrawl/scrape -- --runTestsByPath packages/scrape/src/__tests__/managers/WorkerJobProcessor.test.ts
    Expected: Exit 0 and test proves pending lifecycle keeps processor promise unresolved until terminal.
    Evidence: .omo/evidence/task-5-worker-processor-green.txt

  Scenario: Processor module stays small
    Tool: bash
    Steps: awk '!/^[[:space:]]*$/ && !/^[[:space:]]*\/\//' packages/scrape/src/managers/WorkerJobProcessor.ts | wc -l
    Expected: Numeric output <= 250.
    Evidence: .omo/evidence/task-5-loc.txt
  ```
  **Commit**: YES | Message: `fix(scrape): await crawlee terminal state in worker processor` | Files: `packages/scrape/src/managers/WorkerJobProcessor.ts`, `packages/scrape/src/__tests__/managers/WorkerJobProcessor.test.ts`

- [ ] 6. Make `QueueManager` expose terminal status consistently

  **What to do**: Update `packages/scrape/src/managers/Queue.ts` narrowly so status readers can distinguish BullMQ state, engine task status, and job data summary while preserving `waitJobDone()` return shape.
  **Must NOT do**: Do not make `waitJobDone()` use unbounded polling.
  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 7, 8 | Blocked By: 1
  **References**:
  - `packages/scrape/src/managers/Queue.ts:167`
  - `packages/scrape/src/managers/Queue.ts:224`
  - `apps/api/src/controllers/v1/ScrapeController.ts:282`
  **Acceptance Criteria**:
  - [ ] Existing scrape controller behavior remains compatible.
  - [ ] New status reader returns enough information for `CrawleeJobLifecycle`.
  - [ ] Lifecycle and worker processor tests pass.
  **QA Scenarios**:
  ```
  Scenario: Backward waitJobDone contract remains
    Tool: bash
    Steps: pnpm test --filter=@anycrawl/scrape -- --runTestsByPath packages/scrape/src/__tests__/managers/WorkerJobProcessor.test.ts
    Expected: Exit 0 and tests assert old job data shape is still returned where used.
    Evidence: .omo/evidence/task-6-queue-contract.txt

  Scenario: Queue status exposes both layers
    Tool: bash
    Steps: rg -n "bullmqState|taskStatus|terminalState" packages/scrape/src/managers/Queue.ts packages/scrape/src/managers/CrawleeJobLifecycle.ts
    Expected: Status naming appears in implementation and tests.
    Evidence: .omo/evidence/task-6-status-fields.txt
  ```
  **Commit**: YES | Message: `fix(scrape): expose queue terminal status for lifecycle waits` | Files: `packages/scrape/src/managers/Queue.ts`, tests if needed

- [ ] 7. Wire `Worker.ts` to the extracted processor and remove premature execution finalization

  **What to do**: Replace inline `runJob()` with `WorkerJobProcessor`. Worker handlers should mark scheduled execution started, set job type, and await `processEngineJob(...)`. Event listeners may log or idempotently fallback, but must not be the only terminal source.
  **Must NOT do**: Do not add substantial logic to `Worker.ts`; reduce or keep pure LOC lower than before.
  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: 10, 11 | Blocked By: 1, 3, 5, 6
  **References**:
  - `packages/scrape/src/Worker.ts:276`
  - `packages/scrape/src/Worker.ts:310`
  - `node_modules/.pnpm/bullmq@5.58.6/node_modules/bullmq/dist/cjs/classes/worker.js:516`
  - `docs/scheduled-task-execution-lifecycle.md`
  **Acceptance Criteria**:
  - [ ] `rg -n "async function runJob|function runJob" packages/scrape/src/Worker.ts` returns no match.
  - [ ] `rg -n "updateExecutionStatus\\(.*completed" packages/scrape/src/Worker.ts` returns no match or only an idempotent fallback path.
  - [ ] Worker processor and scheduler lifecycle tests pass.
  **QA Scenarios**:
  ```
  Scenario: Worker no longer completes BullMQ jobs at enqueue boundary
    Tool: bash
    Steps: rg -n "await runJob\\(|function runJob|async function runJob" packages/scrape/src/Worker.ts
    Expected: No matches.
    Evidence: .omo/evidence/task-7-worker-wiring.txt

  Scenario: Worker lifecycle tests pass after wiring
    Tool: bash
    Steps: pnpm test --filter=@anycrawl/scrape -- --runTestsByPath packages/scrape/src/__tests__/managers/WorkerJobProcessor.test.ts packages/scrape/src/__tests__/managers/Scheduler.lifecycle.test.ts
    Expected: Exit 0.
    Evidence: .omo/evidence/task-7-tests.txt
  ```
  **Commit**: YES | Message: `fix(scrape): wire workers through awaited lifecycle processor` | Files: `packages/scrape/src/Worker.ts`

- [ ] 8. Configure BullMQ worker concurrency and stalled-job behavior

  **What to do**: Update `packages/scrape/src/managers/Worker.ts` to read concurrency from config/deps instead of hard-coded 50. Add tests through a pure `resolveWorkerOptions()` helper if feasible.
  **Must NOT do**: Do not change queue names or BullMQ job IDs.
  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: 10, 11 | Blocked By: 3, 4, 5, 6
  **References**:
  - `packages/scrape/src/managers/Worker.ts:16`
  - `.env.example:35`
  - `docker-compose.pg.yml:25`
  - `docker-compose.pg.yml:27`
  **Acceptance Criteria**:
  - [ ] New tests prove env override and default concurrency.
  - [ ] `rg -n "concurrency: 50" packages/scrape/src/managers/Worker.ts` returns no match.
  - [ ] Worker processor tests pass.
  **QA Scenarios**:
  ```
  Scenario: Worker concurrency no longer hard-coded
    Tool: bash
    Steps: rg -n "concurrency: 50" packages/scrape/src/managers/Worker.ts
    Expected: No matches.
    Evidence: .omo/evidence/task-8-no-hardcoded-concurrency.txt

  Scenario: Concurrency config covered by tests
    Tool: bash
    Steps: pnpm test --filter=@anycrawl/libs -- --runTestsByPath packages/libs/src/__tests__/config.test.ts
    Expected: Exit 0 and queue concurrency tests pass.
    Evidence: .omo/evidence/task-8-config-tests.txt
  ```
  **Commit**: YES | Message: `fix(scrape): make worker concurrency configurable` | Files: `packages/scrape/src/managers/Worker.ts`, related tests/config

- [ ] 9. Add lifecycle observability and stale session diagnostics

  **What to do**: Add low-risk diagnostics for per-engine Crawlee counts, BullMQ counts, lifecycle pending counts, and oldest waiting age. Prefer docs or a small `QueueDiagnostics.ts` module.
  **Must NOT do**: Do not auto-delete jobs unless a timeout terminal path has already marked them failed/cancelled.
  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: 10, 11 | Blocked By: none
  **References**:
  - `packages/scrape/src/Worker.ts:337`
  - `packages/scrape/src/managers/EngineQueue.ts:152`
  - `docs/scheduled-tasks-webhooks-implementation.md`
  **Acceptance Criteria**:
  - [ ] Diagnostics expose BullMQ active/waiting/delayed count, Crawlee pending/handled count, lifecycle waiting count, oldest waiting age.
  - [ ] Docs include non-destructive stuck queue triage.
  - [ ] Evidence saved to `.omo/evidence/task-9-diagnostics.txt`.
  **QA Scenarios**:
  ```
  Scenario: Diagnostics command is non-destructive
    Tool: bash
    Steps: run the documented diagnostics command against local Redis/test setup and capture output.
    Expected: Exit 0 and output includes BullMQ counts and Crawlee counts without deleting jobs.
    Evidence: .omo/evidence/task-9-diagnostics.txt

  Scenario: Docs mention stuck queue triage
    Tool: bash
    Steps: rg -n "stuck|lifecycle|BullMQ|Crawlee|pendingRequestCount|handledRequestCount" docs
    Expected: Matches in updated lifecycle/troubleshooting docs.
    Evidence: .omo/evidence/task-9-docs.txt
  ```
  **Commit**: YES | Message: `docs(scrape): document queue lifecycle diagnostics` | Files: diagnostics module if added, `docs/*`

- [ ] 10. Run API/worker manual QA for real Playwright crawl lifecycle

  **What to do**: Start dependencies/API/Playwright worker in tmux, serve a local two-page test site with one slow endpoint, submit `POST /v1/crawl`, poll status, and capture logs proving no premature terminal state.
  **Must NOT do**: Do not use a browser-less fake for final QA.
  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: 12 | Blocked By: 4, 5, 7, 8, 9
  **References**:
  - `apps/api/src/routers/v1/index.ts:23`
  - `docs/scheduled-tasks-webhooks-implementation.md`
  - `packages/scrape/package.json:9`
  - `packages/scrape/src/engines/Playwright.ts:50`
  **Acceptance Criteria**:
  - [ ] `curl -i -X POST http://localhost:<api-port>/v1/crawl ...` returns successful job creation.
  - [ ] Status polling shows non-terminal before terminal and completed/failed after terminal.
  - [ ] tmux logs show lifecycle wait and terminal transition.
  **QA Scenarios**:
  ```
  Scenario: Playwright crawl reaches terminal only after Crawlee drains
    Tool: HTTP call + tmux
    Steps: tmux new-session -d -s ulw-qa-playwright-worker 'cd /Users/thans/working/AnyCrawl/AnyCrawl/packages/scrape && ANYCRAWL_AVAILABLE_ENGINES=playwright pnpm dev:worker:playwright'; curl -i -X POST http://localhost:8080/v1/crawl -H 'Content-Type: application/json' -d '{"url":"http://127.0.0.1:<site-port>/","engine":"playwright","limit":2,"max_depth":1,"strategy":"same-origin","scrape_options":{"formats":["markdown"],"timeout":30000}}'
    Expected: Create status is 200/201, status polling reaches completed/failed only after worker log shows lifecycle terminal.
    Evidence: .omo/evidence/task-10-http-create.txt, .omo/evidence/task-10-http-status.txt, .omo/evidence/task-10-worker.log

  Scenario: Slow page does not prematurely complete BullMQ job
    Tool: HTTP call + tmux
    Steps: Submit crawl to local slow page and poll status twice before slow response completes.
    Expected: Early status is not completed; final status is completed/failed after timeout or page completion.
    Evidence: .omo/evidence/task-10-slow-status.txt
  ```
  **Commit**: NO | Message: `n/a` | Files: QA evidence only

- [ ] 11. Verify scheduled task queue/skip semantics under lifecycle wait

  **What to do**: Extend tests and manual QA so `skip` sees running execution while the processor waits, `queue` does not finalize until worker terminal, and dispatch failures still use `finalizeExecution()`.
  **Must NOT do**: Do not change documented API semantics for `skip` or `queue`.
  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: 12 | Blocked By: 7, 8, 9
  **References**:
  - `packages/scrape/src/managers/Scheduler.ts:493`
  - `packages/scrape/src/managers/Scheduler.ts:513`
  - `docs/api/scheduled-tasks-api.md`
  - `docs/scheduled-task-execution-lifecycle.md`
  **Acceptance Criteria**:
  - [ ] Add/extend `Scheduler.lifecycle.test.ts` for skip mode with processor-held running execution.
  - [ ] Add/extend tests for queue mode not finalizing until worker terminal.
  - [ ] Manual QA creates a one-minute scheduled Playwright crawl in `skip` mode and proves a second tick is skipped while first run is still running.
  **QA Scenarios**:
  ```
  Scenario: Skip mode skips while lifecycle waiter holds running execution
    Tool: bash
    Steps: pnpm test --filter=@anycrawl/scrape -- --runTestsByPath packages/scrape/src/__tests__/managers/Scheduler.lifecycle.test.ts
    Expected: Exit 0 and test name includes skip/running lifecycle.
    Evidence: .omo/evidence/task-11-scheduler-tests.txt

  Scenario: Scheduled Playwright crawl does not pile up completed false-success executions
    Tool: HTTP call + tmux
    Steps: Create scheduled task with cron "* * * * *", engine playwright, concurrency_mode skip, slow local URL; capture worker/API logs over two ticks.
    Expected: One execution running, next tick skipped, no completed execution until lifecycle terminal.
    Evidence: .omo/evidence/task-11-scheduled-skip.log
  ```
  **Commit**: YES | Message: `test(scrape): cover scheduler lifecycle backpressure` | Files: `packages/scrape/src/__tests__/managers/Scheduler.lifecycle.test.ts`, supporting code if needed

- [ ] 12. Update docs with final lifecycle model

  **What to do**: Update `docs/scheduled-task-execution-lifecycle.md` and `docs/scheduled-tasks-webhooks-implementation.md` with synchronized terminal model, shared queue warning, event-listener limitation, env vars, and stuck queue triage.
  **Must NOT do**: Do not mark future/unimplemented features as complete unless implemented.
  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: Final Verification | Blocked By: 10, 11
  **References**:
  - `docs/scheduled-task-execution-lifecycle.md`
  - `docs/scheduled-tasks-webhooks-implementation.md`
  - `AGENTS.md`
  **Acceptance Criteria**:
  - [ ] Docs explicitly say BullMQ and Crawlee terminal states are synchronized by the worker processor.
  - [ ] Docs list all new env vars.
  - [ ] Docs include a stuck queue triage checklist.
  **QA Scenarios**:
  ```
  Scenario: Lifecycle docs contain synchronized terminal model
    Tool: bash
    Steps: rg -n "BullMQ.*Crawlee|Crawlee.*BullMQ|terminal|lifecycle|shared per-engine" docs/scheduled-task-execution-lifecycle.md docs/scheduled-tasks-webhooks-implementation.md
    Expected: Matches show the new model and warnings.
    Evidence: .omo/evidence/task-12-docs.txt

  Scenario: Docs do not reference unimplemented destructive cleanup
    Tool: bash
    Steps: rg -n "drop\\(|obliterate|flushall|delete.*queue" docs/scheduled-task-execution-lifecycle.md docs/scheduled-tasks-webhooks-implementation.md
    Expected: No destructive cleanup guidance, or only explicit "do not" warnings.
    Evidence: .omo/evidence/task-12-no-destructive-docs.txt
  ```
  **Commit**: YES | Message: `docs(scrape): clarify bullmq crawlee lifecycle` | Files: `docs/scheduled-task-execution-lifecycle.md`, `docs/scheduled-tasks-webhooks-implementation.md`

## Final Verification Wave
- [ ] F1. Plan Compliance Audit: verify every task acceptance criterion has evidence under `.omo/evidence/`.
- [ ] F2. Code Quality Review: run LSP diagnostics, pure LOC checks, and `pnpm typecheck --filter=@anycrawl/scrape`.
- [ ] F3. Real Manual QA: run Task 10 and Task 11 through HTTP/tmux and capture cleanup receipts.
- [ ] F4. Scope Fidelity Check: confirm no unrelated cache/billing/template/CloakBrowser behavior changed.

## Commit Strategy
- Do not commit unless user has authorized commits.
- Suggested commits are listed per task.
- Each commit must pass its task tests before being created.
- Final implementation response must mention dirty pre-existing worktree state and that unrelated existing changes were not reverted.

## Success Criteria
- BullMQ scrape/crawl jobs do not complete at enqueue time.
- Crawlee per-job terminal state gates BullMQ processor completion.
- Scheduled execution terminal updates still go through `finalizeExecution()`.
- `skip` and `queue` modes preserve documented semantics while gaining real backpressure.
- Playwright worker manual QA proves no premature completion and no stuck auto-processing for the tested scenario.
- Docs consulted list is included in the final implementation response.

## Docs Consulted
- `AGENTS.md`
- `docs/ai-config.md`
- `docs/api/scheduled-tasks-api.md`
- `docs/api/search-scrape-credits-and-templates.md`
- `docs/api/webhooks-api.md`
- `docs/bandwidth-tracking-complete.md`
- `docs/cache.md`
- `docs/database-migration-docker.md`
- `docs/jest-config-guide.md`
- `docs/jest-known-issues.md`
- `docs/quickstart-scheduled-tasks-webhooks.md`
- `docs/README-scheduled-tasks-webhooks.md`
- `docs/README.md`
- `docs/scheduled-task-execution-lifecycle.md`
- `docs/scheduled-tasks-webhooks-implementation.md`
- `docs/template-tutorial.md`
