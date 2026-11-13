import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  ask,
  askClaudeCli,
  askGeminiCli,
  deAnonymize,
  extractTldr,
  runCouncil,
  type Member,
  type Reply,
} from "./council.js";

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

// Spawn resolves the binary from the PATH inside the env object these seats
// copy out of process.env. Bun.which(name) without a PATH option keeps the
// startup PATH and still finds a real binary, so the check below passes the
// same directory the spawn will search. Tests that share this helper cannot
// overlap: a restore in one would put the real claude or gemini back on PATH
// while the other is still spawning.
let cliPathQueue: Promise<void> = Promise.resolve();

function withCommandMissingFromPath<T>(command: string, body: () => Promise<T>): Promise<T> {
  const previous = cliPathQueue;
  let release: () => void = () => {};
  cliPathQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  return previous.then(async () => {
    const savedPath = process.env.PATH;
    let dir: string | undefined;
    try {
      dir = mkdtempSync(join(tmpdir(), "council-nopath-"));
      process.env.PATH = dir;
      expect(Bun.which(command, { PATH: dir })).toBeNull();
      return await body();
    } finally {
      try {
        if (savedPath === undefined) delete process.env.PATH;
        else process.env.PATH = savedPath;
        if (dir) rmSync(dir, { recursive: true, force: true });
      } finally {
        release();
      }
    }
  });
}

function seat(
  chain: Member["chain"],
  opts?: { name?: string; role?: Member["role"] },
): Member {
  return {
    name: opts?.name ?? "Probe",
    role: opts?.role ?? "debater",
    route: "test double",
    personality: "test double",
    chain,
  };
}

describe.serial("missing claude or gemini command", () => {
  test("askClaudeCli resolves an error reply when claude is not on PATH", async () => {
    // source: Door 17. Bun.spawn ENOENT for claude must be an unavailable reply, not a thrown error.
    const reply = await withCommandMissingFromPath("claude", () =>
      askClaudeCli("claude-opus-4-8", "ping"),
    );
    expect(reply.text).toBe("");
    expect(reply.via).toBe("sub:claude");
    expect(reply.error?.startsWith("claude cli not found or could not start: ")).toBe(true);
    expect((reply.error ?? "").length).toBeGreaterThan(
      "claude cli not found or could not start: ".length,
    );
  }, 2_000);

  test("askGeminiCli resolves an error reply when gemini is not on PATH", async () => {
    // source: Door 17. Bun.spawn ENOENT for gemini must be an unavailable reply, not a thrown error.
    const reply = await withCommandMissingFromPath("gemini", () =>
      askGeminiCli("gemini-test", "ping"),
    );
    expect(reply.text).toBe("");
    expect(reply.via).toBe("sub:gemini");
    expect(reply.error?.startsWith("gemini cli not found or could not start: ")).toBe(true);
    expect((reply.error ?? "").length).toBeGreaterThan(
      "gemini cli not found or could not start: ".length,
    );
  }, 2_000);
});

describe("ask chain when a step throws or rejects", () => {
  test("ask returns the next reply when an earlier step throws", async () => {
    // source: Door 17. A throwing chain step is a failed reply, and ask continues.
    const second: Reply = { text: "ok" };
    const reply = await ask(
      seat([
        () => {
          throw new Error("first step exploded");
        },
        () => Promise.resolve(second),
      ]),
      "question",
      new Map(),
    );
    expect(reply).toEqual(second);
  });

  test("ask resolves an error reply when the only step throws", async () => {
    // source: Door 17. A chain whose only step throws returns an error reply capped at 200 characters.
    const boom = `step failed ${"x".repeat(240)}`;
    const reply = await ask(
      seat([
        () => {
          throw new Error(boom);
        },
      ]),
      "question",
      new Map(),
    );
    expect(reply.text).toBe("");
    expect(reply.error).toBe(boom.slice(0, 200));
  });

  test("ask returns the next reply when an earlier step rejects", async () => {
    // source: Door 17. A rejected chain step is a failed reply, and ask continues.
    const second: Reply = { text: "ok" };
    const reply = await ask(
      seat([
        () => Promise.reject(new Error("first step rejected")),
        () => Promise.resolve(second),
      ]),
      "question",
      new Map(),
    );
    expect(reply).toEqual(second);
  });

  test("runCouncil reports every debater unavailable when every chain throws", async () => {
    // source: Door 17. No working provider ends on the existing unavailable report, not a stack trace.
    const result = await runCouncil(
      "question",
      [
        seat([
          () => {
            throw new Error("no provider");
          },
        ]),
      ],
      seat(
        [
          () => {
            throw new Error("judge must not run");
          },
        ],
        { name: "Fable", role: "judge" },
      ),
    );
    const debater = result.roster.find((row) => row.name === "Probe");
    const judge = result.roster.find((row) => row.name === "Fable");
    expect(debater?.status).toBe("failed");
    expect(debater?.error).toBe("no provider");
    expect(judge?.error).toBe("no debate to adjudicate");
    expect(result.report).toContain("All debaters were unavailable");
  });
});
