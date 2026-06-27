import type { EngStore } from "../store/eng-store.ts";
import type { PushSender, NudgePayload } from "../push/push-sender.ts";
import type { EngTask } from "../domain/eng-task.ts";
import { needsHuman } from "./state-machine.ts";

/** Title/body for a task that needs human action (FR-25). Never includes secret-shaped detail. */
function message(task: EngTask): { title: string; body: string } {
  const tag = task.jiraKey;
  if (task.status === "blocked") return { title: `Task needs attention · ${tag}`, body: task.lastError ?? task.title };
  switch (`${task.stage}:${task.status}`) {
    case "plan:completed_unapproved":
      return { title: `Plan ready · ${tag}`, body: task.title };
    case "pr:proposed":
      return { title: `PR ready to open · ${tag}`, body: task.artifacts.pr?.title ?? task.title };
    case "review:comments_received":
      return { title: `Review comments · ${tag}`, body: task.title };
    case "merge:ready":
      return { title: `Ready to merge · ${tag}`, body: task.title };
    case "deploy:failed":
      return { title: `Deploy failed · ${tag}`, body: task.title };
    default:
      return { title: `Action needed · ${tag}`, body: task.title };
  }
}

/**
 * Pushes a notification when a task reaches a "needs a human" state, deep-linking by taskId. Fires
 * once per distinct status (tracked via `lastNotifiedStatus`) so it never storms. Reuses the
 * existing APNs sender + device registry. Runs as an api-side scheduler job.
 */
export class EngNotifier {
  readonly #engStore: EngStore;
  readonly #push: PushSender;
  readonly #deviceTokens: () => string[];

  constructor(engStore: EngStore, push: PushSender, deviceTokens: () => string[]) {
    this.#engStore = engStore;
    this.#push = push;
    this.#deviceTokens = deviceTokens;
  }

  async run(): Promise<{ sent: number; tasks: number }> {
    const tasks = this.#engStore.list({ needsHuman: true });
    const tokens = this.#deviceTokens();
    let sent = 0;
    for (const task of tasks) {
      if (!needsHuman({ stage: task.stage, status: task.status })) continue;
      const key = `${task.stage}:${task.status}`;
      if (task.lastNotifiedStatus === key) continue;
      const { title, body } = message(task);
      const payload: NudgePayload = { title, body, taskId: task.id, stage: task.stage };
      for (const token of tokens) {
        await this.#push.send(token, payload);
        sent += 1;
      }
      this.#engStore.setLastNotified(task.id, key);
    }
    return { sent, tasks: tasks.length };
  }
}
