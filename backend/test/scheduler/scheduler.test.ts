import { describe, expect, it } from "vitest";
import { Scheduler } from "../../src/scheduler/scheduler.ts";

const T = 1_000_000; // a realistic-ish base instant

describe("Scheduler", () => {
  it("runs a job once its interval has elapsed", async () => {
    let runs = 0;
    const s = new Scheduler();
    s.add({ name: "j", intervalMs: 1000, run: async () => { runs += 1; } });
    expect(await s.tick(T)).toEqual(["j"]); // first tick: T - 0 >= interval
    expect(runs).toBe(1);
    expect(await s.tick(T + 999)).toEqual([]); // too soon
    expect(await s.tick(T + 1000)).toEqual(["j"]); // due again
    expect(runs).toBe(2);
  });

  it("ignores disabled jobs (interval <= 0)", () => {
    const s = new Scheduler();
    s.add({ name: "off", intervalMs: 0, run: async () => {} });
    expect(s.jobNames).toEqual([]);
  });

  it("isolates a throwing job and still runs the others", async () => {
    const errors: string[] = [];
    let okRuns = 0;
    const s = new Scheduler((name) => errors.push(name));
    s.add({ name: "bad", intervalMs: 1, run: async () => { throw new Error("boom"); } });
    s.add({ name: "good", intervalMs: 1, run: async () => { okRuns += 1; } });
    expect(await s.tick(T)).toEqual(["bad", "good"]);
    expect(errors).toEqual(["bad"]);
    expect(okRuns).toBe(1);
  });

  it("start() is a no-op when there are no enabled jobs", () => {
    expect(new Scheduler().start()).toBe(false);
  });
});
