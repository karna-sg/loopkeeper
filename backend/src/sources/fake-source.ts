import type { NormalizedMessage } from "../domain/message.ts";
import type { Channel } from "../domain/open-loop.ts";
import type { MessageSource } from "./source.ts";

/** A fixed-list source for tests and the offline scan demo. */
export class FakeSource implements MessageSource {
  readonly channel: Channel;
  readonly #messages: readonly NormalizedMessage[];

  constructor(channel: Channel, messages: readonly NormalizedMessage[]) {
    this.channel = channel;
    this.#messages = messages;
  }

  async fetchRecent({ limit }: { sinceIso: string; limit: number }): Promise<NormalizedMessage[]> {
    return this.#messages.slice(0, limit).filter((m) => m.channel === this.channel);
  }
}
