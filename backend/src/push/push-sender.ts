/**
 * A push notification to deliver. Deliberately minimal — counterpart + due only, **never a
 * counterpart's quote** (those traverse Apple's servers). Full detail is fetched on open.
 */
export interface NudgePayload {
  title: string;
  body: string;
  /** Reminder deep-link target (omitted for engineering pushes). */
  loopId?: string;
  /** Source thread ref for deep-linking (slack `channel:ts` / gmail `threadId:messageId`). */
  threadRef?: string;
  badge?: number;
  /** Engineering deep-link target — the app opens the Task workspace by this id (FR-25). */
  taskId?: string;
  /** The stage the task is at, for the notification category. */
  stage?: string;
}

export interface PushSender {
  send(deviceToken: string, payload: NudgePayload): Promise<void>;
}

/** Records what would have been sent — for tests and the offline nudge demo. */
export class FakePushSender implements PushSender {
  readonly sent: Array<{ token: string; payload: NudgePayload }> = [];
  async send(token: string, payload: NudgePayload): Promise<void> {
    this.sent.push({ token, payload });
  }
}
