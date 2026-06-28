#!/usr/bin/env node
// Create ONE LP Story — the id-based-identity + live-fetch + sync-reconciliation fix — under the
// Phase 3 Epic, via the Jira REST API using the Basic-auth token from the ENVIRONMENT. Token is read
// at runtime, never hardcoded/printed. Run where JIRA_* is set, e.g.:
//   cd ~/loopkeeper (or the Mac clone) && set -a; . deploy/loopkeeper.env; set +a; node ops/create-id-fix-ticket.mjs
// Idempotent: skips if a Story with this summary already exists. Finds the Phase-3 Epic by name
// (robust to the KAN->LP rename) and links to it.

const BASE = (process.env.JIRA_BASE_URL || "").replace(/\/$/, "");
const EMAIL = process.env.JIRA_EMAIL, TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT = process.env.JIRA_PROJECT_KEY || "LP";
const ASSIGNEE = process.env.JIRA_ASSIGNEE_ID || "5b95fe87349c1c1df9354f02"; // Sandip
if (!BASE || !EMAIL || !TOKEN) {
  console.error("Missing JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN. Source your env file first: set -a; . deploy/loopkeeper.env; set +a");
  process.exit(1);
}
const H = { authorization: "Basic " + Buffer.from(EMAIL + ":" + TOKEN).toString("base64"), "content-type": "application/json", accept: "application/json" };

async function api(method, path, body) {
  const r = await fetch(BASE + "/rest/api/3" + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${typeof j === "string" ? j.slice(0, 300) : JSON.stringify(j)}`);
  return j;
}
async function search(jql) {
  const q = encodeURIComponent(jql);
  return api("GET", `/search/jql?jql=${q}&maxResults=1`).catch(() => api("GET", `/search?jql=${q}&maxResults=1`).catch(() => ({ issues: [] })));
}
function adf(text) {
  return { type: "doc", version: 1, content: text.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0).map((l) => ({ type: "paragraph", content: [{ type: "text", text: l }] })) };
}

const SUMMARY = "Identity on immutable Jira id + live-fetch metadata + sync reconciliation";
const DESC = `Problem / root cause:
The orchestration cache (eng.db) keys tasks on the Jira KEY (e.g. LP-4), which is MUTABLE — it changes when the project key is renamed (KAN->LP) or an issue is moved between projects. On rename, sync saw the new key as a brand-new issue and inserted a duplicate plan:not_started row, orphaning the original pipeline state. The stale row was never removed because upsertFromJira is insert/update-only and never reconciles. Observed: 30 orphaned KAN-* rows in eng.db after the KAN->LP rename, alongside 28 fresh LP-* rows. Two flaws: (1) identity tied to a mutable field; (2) no reconciliation/prune on sync.

Goal:
Jira is the live source of truth for issue metadata AND the task list. eng.db stores only the immutable Jira issue id + our pipeline state. Renamed / deleted / unassigned / moved issues never linger.

Scope:
- Use the immutable Jira issue id (not the key) as the stable identity for eng_tasks; derive the internal task id from jira_id. Keep jira_key only as a fetched, display-only field.
- Drive "My Jira Tasks" from a live Jira query (assignee = currentUser()); left-join pipeline rows by jira_id. Issues with no pipeline row -> "not started"; pipeline rows whose id is not in the live result -> not shown (and pruned).
- Fetch metadata (title, description, acceptance, labels, key, status, assignee) live from Jira. Any cache is a disposable, id-keyed, short-TTL read-through accelerator — never the source of truth or the identity.
- Reconcile on sync: prune rows whose jira_id is no longer in the assignee set, guarded so in-flight tasks (past plan:not_started) are flagged rather than silently deleted.
- Migration: backfill jira_id on existing rows; de-duplicate any key-vs-id duplicates left by the rename.

Acceptance criteria:
- Renaming the project key (or moving an issue) does NOT create duplicates or orphan pipeline state — the same issue maps to the same row before/after.
- Deleting/unassigning an issue removes it from the app list on the next sync (no ghosts).
- eng_tasks identity + the internal task id derive from the immutable Jira id, not the key.
- The list reflects the live Jira assignee result; shown metadata is current.
- Pipeline state (stage/status/artifacts/session/budget/events) survives a key change.
- Unit tests cover id-based upsert + reconciliation (rename / delete / move) and the list join; existing suite stays green.

Notes:
- Supersedes the smaller "prune stale tasks on sync" idea (LP-26) — fold it in.
- Git branch names embed the key at creation, so existing branches keep old-key names after a rename (harmless; tracked by the stored artifact, not recomputed).`;

(async () => {
  const existing = await search(`project = ${PROJECT} AND summary ~ "Identity on immutable Jira id"`);
  if ((existing.issues?.length ?? 0) > 0) { console.log("Already exists:", existing.issues[0].key, "->", BASE + "/browse/" + existing.issues[0].key); return; }

  let parent = null;
  const epic = await search(`project = ${PROJECT} AND issuetype = Epic AND summary ~ "Phase 3 — Engineering UX"`);
  parent = epic.issues?.[0]?.key ?? null;

  const fields = { project: { key: PROJECT }, issuetype: { name: "Story" }, summary: SUMMARY, description: adf(DESC), labels: ["phase-3", "backend", "data-model"], assignee: { id: ASSIGNEE } };
  if (parent) fields.parent = { key: parent };
  let res;
  try {
    res = await api("POST", "/issue", { fields });
  } catch (e) {
    if (parent) { console.warn(`create-with-parent failed (${e.message}); retrying without parent`); delete fields.parent; res = await api("POST", "/issue", { fields }); }
    else throw e;
  }
  console.log("created", res.key, parent ? "under " + parent : "(no parent — link to the Phase 3 epic manually)");
  console.log(BASE + "/browse/" + res.key);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
