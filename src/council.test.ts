import { describe, expect, test } from "bun:test";
import { deAnonymize, extractTldr } from "./council.js";

describe("extractTldr", () => {
  test("extracts all three tiers and strips the block from the body", () => {
    const adjudication = `TLDR-ONE: Barter one fixed weekly venue.
TLDR-TWO: Ritual beats reach for a $0 launch. The flip is a cash-first KPI.
TLDR-THREE:
- Decision: fixed venue barter
- Flip: cash KPI → rotate as prospecting
END-TLDR

## Verdict on Each Position
MEMBER-A holds up.`;

    const { tldr, body } = extractTldr(adjudication);
    expect(tldr.one).toBe("Barter one fixed weekly venue.");
    expect(tldr.two).toContain("Ritual beats reach");
    expect(tldr.three).toContain("- Decision: fixed venue barter");
    expect(body.startsWith("## Verdict on Each Position")).toBe(true);
    expect(body).not.toContain("END-TLDR");
    expect(body).not.toContain("TLDR-ONE");
  });

  test("tolerates bold-wrapped markers", () => {
    const adjudication = `**TLDR-ONE:** The answer.
**TLDR-TWO:** The gist of it, with a why.
**TLDR-THREE:**
- bullet one
- bullet two
**END-TLDR**

## Verdict on Each Position
Body.`;

    const { tldr, body } = extractTldr(adjudication);
    expect(tldr.one).toBe("The answer.");
    expect(tldr.two).toContain("gist");
    expect(tldr.three).toContain("bullet two");
    expect(body).toContain("## Verdict on Each Position");
    expect(body).not.toContain("TLDR-TWO");
  });

  test("tolerates a preamble before the block", () => {
    const adjudication = `Here is my adjudication.

TLDR-ONE: Short answer.
TLDR-TWO: Longer answer with reasoning.
TLDR-THREE:
- a
- b
END-TLDR

## Verdict on Each Position
Rest.`;

    const { tldr, body } = extractTldr(adjudication);
    expect(tldr.one).toBe("Short answer.");
    expect(body).toContain("Here is my adjudication.");
    expect(body).toContain("## Verdict on Each Position");
    expect(body).not.toContain("TLDR-ONE");
  });

  test("failure-open: missing markers → first substantive non-heading line, body untouched", () => {
    const adjudication = `## Verdict on Each Position
The council largely agreed that a fixed venue wins on habit formation.
More detail follows.`;

    const { tldr, body } = extractTldr(adjudication);
    expect(body).toBe(adjudication);
    expect(tldr.one).toBe(
      "The council largely agreed that a fixed venue wins on habit formation.",
    );
    expect(tldr.two).toBeUndefined();
    expect(tldr.three).toBeUndefined();
  });

  test("failure-open: partial block (no END-TLDR) falls back rather than mangling", () => {
    const adjudication = `TLDR-ONE: An answer without the rest of the contract honored.
## Verdict on Each Position
Body text that is definitely long enough to qualify as substantive.`;

    const { tldr, body } = extractTldr(adjudication);
    expect(body).toBe(adjudication);
    expect(tldr.one).toBeDefined();
  });
});

describe("deAnonymize", () => {
  const map = new Map([
    ["MEMBER-A", "Claude"],
    ["MEMBER-B", "Nova"],
    ["MEMBER-C", "Kai"],
  ]);

  test("replaces label variants case-insensitively, including possessives", () => {
    const text = "MEMBER-A said X. member b's view differed. Member-C agreed with Member A.";
    const out = deAnonymize(text, map);
    expect(out).toBe("Claude said X. Nova's view differed. Kai agreed with Claude.");
  });

  test("leaves unrelated words alone", () => {
    const out = deAnonymize("Remember: membership matters. MEMBERSHIP-A is not a label.", map);
    expect(out).toContain("membership matters");
    expect(out).toContain("MEMBERSHIP-A");
  });
});
