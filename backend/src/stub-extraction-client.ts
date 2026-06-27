import type { ExtractedLoop } from "./domain/open-loop.ts";
import type { ExtractionClient, ExtractionInput } from "./extractor.ts";

/**
 * A deterministic, offline {@link ExtractionClient} backed by a fixed map of
 * sourceRef → extracted loops. Used by the Phase-0 runner (no API key needed) and by
 * tests, so the orchestration can be exercised without the network.
 */
export class StubExtractionClient implements ExtractionClient {
  readonly #bySourceRef: Readonly<Record<string, readonly ExtractedLoop[]>>;

  constructor(bySourceRef: Readonly<Record<string, readonly ExtractedLoop[]>>) {
    this.#bySourceRef = bySourceRef;
  }

  async extract({ message }: ExtractionInput): Promise<ExtractedLoop[]> {
    return [...(this.#bySourceRef[message.sourceRef] ?? [])];
  }
}
