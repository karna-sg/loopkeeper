import { describe, expect, it } from "vitest";
import { normalizeSlackText } from "../../src/sources/slack-source.ts";

describe("normalizeSlackText", () => {
  it("turns broadcast tokens into readable @channel/@here/@everyone", () => {
    expect(normalizeSlackText("<!channel> finish the training by Friday")).toBe("@channel finish the training by Friday");
    expect(normalizeSlackText("<!here> please fill the form")).toBe("@here please fill the form");
    expect(normalizeSlackText("<!everyone> standup now")).toBe("@everyone standup now");
  });

  it("resolves user + channel mentions and links", () => {
    expect(normalizeSlackText("hey <@U123|priya> see <#C9|general>")).toBe("hey @priya see #general");
    expect(normalizeSlackText("<@U123> ping")).toBe("@user ping");
    expect(normalizeSlackText("doc <https://x.com|here>")).toBe("doc here");
  });

  it("unescapes HTML entities", () => {
    expect(normalizeSlackText("A &amp; B &lt;3")).toBe("A & B <3");
  });
});
