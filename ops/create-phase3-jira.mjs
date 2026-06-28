#!/usr/bin/env node
// Create the Phase-3 backlog in Jira (Epic → Stories → Sub-tasks) via the REST API using the
// Basic-auth API token from the ENVIRONMENT (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN). The token
// is read from env at runtime — never hardcoded, never printed. Use where those are set, e.g. the VM:
//
//   cd ~/loopkeeper && git pull
//   set -a; . deploy/loopkeeper.env; set +a            # load JIRA_* from the existing env file
//   DRY=1 node ops/create-phase3-jira.mjs              # preview (creates nothing)
//   node ops/create-phase3-jira.mjs                    # create for real
//
// Needs Node 18+ (global fetch). Idempotency: aborts if the Epic already exists. Adapts to
// team- vs company-managed projects (resolves the actual Epic/Story/Sub-task type names).

const BASE = process.env.JIRA_BASE_URL;
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT = process.env.JIRA_PROJECT_KEY || "KAN";
const ASSIGNEE = process.env.JIRA_ASSIGNEE_ID || "5b95fe87349c1c1df9354f02"; // Sandip
const DRY = process.env.DRY === "1";

if (!BASE || !EMAIL || !TOKEN) {
  console.error("Missing JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN in env. Source your env file first:");
  console.error("  set -a; . deploy/loopkeeper.env; set +a");
  process.exit(1);
}

const headers = {
  authorization: "Basic " + Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64"),
  "content-type": "application/json",
  accept: "application/json",
};

async function api(method, path, body) {
  const res = await fetch(`${BASE.replace(/\/$/, "")}/rest/api/3${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${typeof json === "string" ? json.slice(0, 300) : JSON.stringify(json)}`);
  return json;
}

// Render plain text (one paragraph per non-empty line) to a minimal ADF doc.
function adf(text) {
  const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0);
  return { type: "doc", version: 1, content: lines.map((l) => ({ type: "paragraph", content: [{ type: "text", text: l }] })) };
}

async function resolveTypes() {
  const meta = await api("GET", `/issue/createmeta?projectKeys=${PROJECT}&expand=projects.issuetypes`);
  const proj = meta.projects?.[0];
  if (!proj) throw new Error(`Project ${PROJECT} not visible to this account`);
  const types = proj.issuetypes;
  const find = (re) => types.find((t) => re.test(t.name))?.name;
  return {
    epic: find(/^epic$/i) || "Epic",
    story: find(/^story$/i) || find(/^task$/i) || "Task",
    sub: types.find((t) => t.subtask)?.name || "Subtask",
    available: types.map((t) => t.name),
  };
}

async function create(summary, issueType, descr, labels, parentKey) {
  if (DRY) { console.log(`[dry] ${issueType}: ${summary}${parentKey ? ` (parent ${parentKey})` : ""}`); return `DRY-${summary.slice(0, 4)}`; }
  const fields = {
    project: { key: PROJECT },
    summary,
    issuetype: { name: issueType },
    description: adf(descr),
    labels,
    assignee: { id: ASSIGNEE },
  };
  if (parentKey) fields.parent = { key: parentKey };
  const res = await api("POST", "/issue", { fields });
  console.log(`created ${res.key}  ${issueType}: ${summary}`);
  return res.key;
}

const L = ["phase-3", "engineering"];
const BACKLOG = {
  epic: {
    summary: "Phase 3 — Engineering UX, Control & Insights",
    labels: L,
    descr:
      "Phase 2 shipped the full plan->deploy pipeline (FR-1..25). Phase 3 closes the trust/control/visibility gaps that decide whether the operator can confidently drive engineering from the phone, and expands what a task can be: cancel/stop, live agent feed, in-app diff review, CI checks, cost & throughput insights, ad-hoc (non-Jira) tasks.\nOut of scope (tracked separately as the deferred D1 story): multi-repo / parallel execution.",
  },
  stories: [
    {
      summary: "Foundation: agent-run pid + log-path plumbing",
      labels: ["phase-3", "backend", "foundation"],
      descr:
        "Cancel needs the running agent's OS pid; the live feed needs its log path - both recorded while the run is live. Today spawn never exposes the child, the runner never returns logPath, and eng_agent_runs has no pid column.\nAcceptance criteria:\n- pid + logPath persisted at run start\n- existing test suite stays green (FakeAgentRunner updated for logPath/onStart)",
      tasks: [
        { summary: "Backend: expose child pid + thread pid/logPath runner->store->orchestrator", descr: "spawn.onSpawn(child) + detached process group; AgentRunResult.logPath; AgentRunArgs.onStart; eng_agent_runs.pid column; markAgentRunStarted / runningAgentRunForTask; thread the 3 orchestrator run sites (#handlePlan / #handleDevTest / #handleAddressComments)." },
      ],
    },
    {
      summary: "Cancel / stop a running task",
      labels: ["phase-3", "backend", "ios", "control"],
      descr:
        "No off-switch today; a wrong/runaway run burns budget until it exits.\nAcceptance criteria:\n- POST /tasks/:id/cancel (assignee-gated) cancels jobs + moves task to blocked (recoverable, reuses retry UI)\n- worker cancel-watcher kills the agent process-group via the recorded pid\n- retry recovers\n- iOS [stop] visible while running\nDepends on: Foundation.",
      tasks: [
        { summary: "Backend: cancel route + worker cancel-watcher (process-group kill)", descr: "POST /tasks/:id/cancel using cancelJobsForTask + applyTransition to blocked; worker tracks the in-flight job and kills the recorded pid group (isJobCancelled + process.kill(-pid))." },
        { summary: "iOS: [stop] button + APIClient.cancelTask + AppModel", descr: "Red [stop] action in TaskWorkspaceView while task.isRunning; APIClient.cancelTask(id); AppModel.cancelTask." },
      ],
    },
    {
      summary: "Live agent activity feed",
      labels: ["phase-3", "backend", "ios", "observability"],
      descr:
        "The agent is a black box - only stage/status is visible today.\nAcceptance criteria:\n- GET /tasks/:id/activity?offset tails the redacted jsonl via a byte cursor\n- iOS shows a live monospaced feed of tool/text/result lines while running\nDepends on: Foundation.",
      tasks: [
        { summary: "Backend: extract pure stream-parse + GET /tasks/:id/activity (offset tail)", descr: "Extract claude-runner.#consume into a pure stream-parse.ts; activity endpoint reads the run's log_path off the shared volume from an offset and returns condensed events + nextOffset." },
        { summary: "iOS: live feed block with byte-cursor polling", descr: "Collapsible # live monospaced block appending activity lines on the existing 3s poll loop; cursor in @State." },
      ],
    },
    {
      summary: "In-app diff viewer (PR + merge gates)",
      labels: ["phase-3", "backend", "ios", "review"],
      descr:
        "The review gate shows a file count + a GitHub link - reviewing blind.\nAcceptance criteria:\n- GET /tasks/:id/diff returns parsed per-file hunks (PR diff if created, compare endpoint if proposed), redacted & size-capped\n- iOS DiffView with +/- coloring + open-on-GitHub fallback\n- expander in pr/merge/review gates",
      tasks: [
        { summary: "Backend: GithubPort.getDiff + diff-parse + GET /tasks/:id/diff", descr: "Add #getRaw + getDiff to RestGithubClient (PR .diff or compare endpoint); pure diff-parse.ts; route redacts + size-caps." },
        { summary: "iOS: DiffView + gate expanders", descr: "DiffView.swift terminal-style per-file disclosure; [view diff] expander in prGate/mergeGate/reviewGate." },
      ],
    },
    {
      summary: "Engineering insights & per-task cost",
      labels: ["phase-3", "backend", "ios", "insights"],
      descr:
        "Reminders have Insights/Standup/Brag; engineering has none though the data exists.\nAcceptance criteria:\n- GET /eng/stats (shipped, in-flight, median time-to-PR/merge, review rounds, $ spend 7/30d, byWeek), built purely (mirror src/stats.ts)\n- iOS EngInsightsView (cloned from InsightsView) from the actions menu\n- per-task $ in the workspace meta line\nNote: if usdCents is 0 under subscription OAuth, surface turns/iterations and label cost 'n/a on subscription'.",
      tasks: [
        { summary: "Backend: eng-stats + GET /eng/stats + allEvents()/allRuns() helpers", descr: "Pure buildEngStats over tasks/events/runs; route; store aggregate reads." },
        { summary: "iOS: EngInsightsView + cost in workspace meta", descr: "Clone InsightsView (List/Section/by-week bars); reach from ContentView actions menu; show $X.XX in TaskWorkspaceView meta." },
      ],
    },
    {
      summary: "Ad-hoc / non-Jira tasks",
      labels: ["phase-3", "backend", "ios", "intake"],
      descr:
        "Every task must be a Jira ticket; no ad-hoc work or reminder->task bridge.\nAcceptance criteria:\n- createLocal (synthetic LOCAL-<uuid> key, assignee=self) runs the same pipeline\n- POST /tasks (free-text)\n- POST /loops/:id/to-task promotes a reminder\n- jira-sync never touches LOCAL- keys; origin inferred from key prefix (no migration)",
      tasks: [
        { summary: "Backend: createLocal + POST /tasks + POST /loops/:id/to-task", descr: "createLocal store method modeled on upsertFromJira with a LOCAL- key + self assignee; free-text and loop-promotion routes (fail-closed without selfAccountId)." },
        { summary: "iOS: compose sheet + send-to-engineering loop action", descr: "+ new task in the tasks header; 'send to engineering' in the loop row context menu." },
      ],
    },
    {
      summary: "CI checks in-app",
      labels: ["phase-3", "backend", "ios", "ci"],
      descr:
        "No in-app signal whether CI is green before merge.\nAcceptance criteria:\n- getChecks(repo, headSha) folded into PrArtifact.checks via pr-monitor; head sha added to PrState\n- iOS checks row (pass/fail/pending) in review/merge gates + advisory warning on merge when failing\n- PAT needs checks:read",
      tasks: [
        { summary: "Backend: getChecks + head sha in PrState + pr-monitor fold + PrArtifact.checks", descr: "GithubPort.getChecks via /commits/{sha}/check-runs; add head sha to getPr/PrState; pr-monitor folds checks; PrArtifact.checks." },
        { summary: "iOS: checks row in review/merge gates", descr: "Checks row (green/red/pending + per-run names) + advisory merge warning when failing." },
      ],
    },
    {
      summary: "Polish & smaller levers",
      labels: ["phase-3", "polish"],
      descr: "Lower-priority wins surfaced by the codebase review.",
      tasks: [
        { summary: "Per-task model selection (opus/sonnet)", descr: "claudeModel is global today; let a task pick its model as a cost/quality lever." },
        { summary: "GitHub connector UI in Settings", descr: "Jira connect exists in Settings; GitHub connect UI is absent." },
        { summary: "Push deep-link opens the specific loop detail", descr: "Today only task-workspace deep-links; reminders open the app but not the loop sheet." },
        { summary: "Surface plan revision history", descr: "Plan revision counter exists but isn't shown in the workspace." },
      ],
    },
    {
      summary: "[Deferred] Multi-repo + parallel execution",
      labels: ["phase-3", "deferred", "scale"],
      descr:
        "Map Jira projects->repos (one GITHUB_REPO today) and enforce/raise ENG_MAX_CONCURRENT. Deferred: directly fights the documented single-writer eng.db invariant - needs a careful read-modify-write audit + per-repo tokens. Pick up when a real 2nd repo / throughput need exists.",
      tasks: [],
    },
  ],
};

(async () => {
  // Idempotency: bail if the Epic already exists (best-effort; tolerates search-endpoint differences).
  const jql = encodeURIComponent(`project = ${PROJECT} AND summary ~ "Phase 3 — Engineering UX"`);
  const found = await api("GET", `/search/jql?jql=${jql}&maxResults=1`).catch(() => api("GET", `/search?jql=${jql}&maxResults=1`).catch(() => ({ issues: [] })));
  if ((found.issues?.length ?? 0) > 0 && !DRY) {
    console.error(`Epic appears to already exist (${found.issues[0].key}). Aborting to avoid duplicates. Use DRY=1 to preview.`);
    process.exit(2);
  }

  const T = await resolveTypes();
  console.log(`Project ${PROJECT}  types -> epic="${T.epic}" story="${T.story}" subtask="${T.sub}"`);
  console.log(`(available types: ${T.available.join(", ")})\n`);

  const epicKey = await create(BACKLOG.epic.summary, T.epic, BACKLOG.epic.descr, BACKLOG.epic.labels, null);
  let stories = 0, tasks = 0;
  for (const s of BACKLOG.stories) {
    let storyKey;
    try {
      storyKey = await create(s.summary, T.story, s.descr, s.labels, epicKey);
    } catch (e) {
      console.warn(`  story-with-parent failed (${e.message}); retrying without parent (link to Epic manually)`);
      storyKey = await create(s.summary, T.story, s.descr, s.labels, null);
    }
    stories += 1;
    for (const t of s.tasks ?? []) {
      try {
        await create(t.summary, T.sub, t.descr, s.labels, storyKey);
        tasks += 1;
      } catch (e) {
        console.warn(`  subtask failed under ${storyKey} (${e.message}); skipping: ${t.summary}`);
      }
    }
  }
  console.log(`\nDone. Epic ${epicKey} + ${stories} stories + ${tasks} sub-tasks.`);
  console.log(`Board/epic: ${BASE.replace(/\/$/, "")}/browse/${epicKey}`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
