import { mkdir } from "node:fs/promises";
import { log } from "./shared/logging.js";

// ─────────────────────────────────────────────────────────────────────────────
// Council — five frontier debaters + Fable 5 as a blind Chief Adjudicator.
//
// Self-contained: no SDK. Each seat is served through a PROVIDER CHAIN that
// tries the $0 subscription-backed CLI first and falls back to the OpenRouter
// API only if the sub path is unavailable. As sub auth/quota is restored
// (Gemini login), those seats shift to free with zero code change.
//
// Design decisions (2026-07-09, all verified against live behavior):
//   • BLIND debate: Round 2 critiques and the Round 3 adjudication see the
//     debaters only as MEMBER-A…E. LLM judges exhibit self/brand-preference
//     bias; anonymization removes it. Labels are de-anonymized in the report.
//   • Judge ≠ debater: Fable 5 never argues a position. It judges, corrects,
//     overrules false consensus, red-teams its own verdict, then settles.
//   • Verdict-first report: the adjudication is the payoff, so it leads; the
//     debate transcript follows as the record.
//   • High reasoning effort on API seats (sol-pro bakes it in via
//     reasoning.mode=pro; grok/gemini/deepseek get reasoning.effort=high with
//     automatic strip-and-retry if a provider rejects the param).
//   • Sub seats get read-only grounding tools (Read/Glob/Grep/WebSearch) —
//     they can verify claims; WebFetch and all mutating tools are disallowed.
//   • Cost telemetry per seat (tokens + $ at current OpenRouter rates);
//     sub/local seats report $0.
//
// Routing today (2026-07-09):
//   • Claude (Opus 4.8)      — `claude -p` sub ($0)  → OpenRouter fallback
//   • Fable  (judge)         — `claude -p` sub ($0)  → OpenRouter fallback
//   • Nova   (GPT-5.6 sol-pro) — OpenRouter (sol tier isn't on the codex sub;
//                              sol-pro = sol with reasoning.mode=pro, same $)
//   • Gem    (Gemini 3.1 Pro)  — gemini CLI sub → OpenRouter fallback
//   • Grok   (4.5)             — OpenRouter (no headless sub CLI exists)
//   • Kai    (DeepSeek V4 Pro) — OpenRouter → local Ollama fallback. Replaces
//     the 3B local seat: the judge's own live verdict called it negative
//     signal, and DeepSeek adds real non-US-lab training diversity.
// ─────────────────────────────────────────────────────────────────────────────

// Hard ceiling on a single seat call. Headless `claude -p` spawns a fresh
// session and high-effort API seats think long, so this is generous — but a
// hung provider must not wedge the whole council.
const CALL_TIMEOUT_MS = 300_000;

// Sub CLIs run in a neutral cwd so they don't load a repo's CLAUDE.md context.
// (The user-level ~/.claude/CLAUDE.md still loads — deliberate: it grounds the
// sub seats in your local environment, and sub tokens are $0.)
const NEUTRAL_CWD = "/tmp";

// Read-only grounding for the sub-backed seats. WebFetch stays disallowed
// (prompt-injection surface); everything mutating or agentic is disallowed.
const CLAUDE_ALLOWED_TOOLS = ["Read", "Glob", "Grep", "WebSearch"];
const CLAUDE_DISALLOWED_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "Task",
  "Agent",
  "KillShell",
  "Skill",
];

type Usage = { inTok: number; outTok: number };

type Reply = {
  text: string;
  error?: string;
  via?: string;
  usage?: Usage;
  costUsd?: number;
};

type RosterEntry = {
  name: string;
  role: "debater" | "judge";
  route: string;
  via?: string;
  status: "ok" | "failed";
  error?: string;
  calls: number;
  inTok: number;
  outTok: number;
  costUsd: number;
};

// ── small utilities ──────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// ── provider primitives ──────────────────────────────────────────────────────

// Claude Code headless (subscription-backed, $0).
//  - prompt is fed via STDIN (argv has size limits; judge inputs are large)
//  - `--strict-mcp-config` with no `--mcp-config` loads ZERO MCP servers
//  - `--output-format json` gives structured result + usage
//  - read-only grounding tools allowed; mutating/agentic tools disallowed
//  - ANTHROPIC_API_KEY is stripped so the CLI uses the sub's OAuth, never a
//    dead pay-per-use key
async function askClaudeCli(model: string, prompt: string): Promise<Reply> {
  const via = "sub:claude";
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      "--model",
      model,
      "--output-format",
      "json",
      "--strict-mcp-config",
      "--allowedTools",
      ...CLAUDE_ALLOWED_TOOLS,
      "--disallowedTools",
      ...CLAUDE_DISALLOWED_TOOLS,
    ],
    {
      cwd: NEUTRAL_CWD,
      stdin: new TextEncoder().encode(prompt),
      stdout: "pipe",
      stderr: "pipe",
      env,
    },
  );

  const run = (async (): Promise<Reply> => {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      return {
        text: "",
        error: `claude cli exit ${code}: ${err.trim().slice(0, 200) || "no stderr"}`,
        via,
      };
    }

    // --output-format json → single JSON object with .result; fall back to raw
    // stdout if the shape ever changes.
    let text = "";
    let usage: Usage | undefined;
    let isError = false;
    try {
      const parsed: unknown = JSON.parse(out);
      if (isRecord(parsed)) {
        if (typeof parsed.result === "string") text = parsed.result.trim();
        if (parsed.is_error === true) isError = true;
        if (isRecord(parsed.usage)) {
          const inTok = asNumber(parsed.usage.input_tokens);
          const outTok = asNumber(parsed.usage.output_tokens);
          if (inTok !== undefined || outTok !== undefined) {
            usage = { inTok: inTok ?? 0, outTok: outTok ?? 0 };
          }
        }
      }
    } catch {
      text = out.trim();
    }

    if (isError) return { text: "", error: `claude cli error: ${text.slice(0, 200)}`, via };
    if (!text) return { text: "", error: "empty response from claude cli", via };
    // Subscription-billed: marginal cost is $0 regardless of notional usage.
    return { text, via, usage, costUsd: 0 };
  })();

  try {
    return await withTimeout(run, CALL_TIMEOUT_MS, model);
  } catch (e) {
    proc.kill();
    return { text: "", error: (e as Error).message, via };
  }
}

// Gemini CLI headless (subscription-backed, $0). Prints stack traces to stdout
// on auth failure, so those are detected and treated as unavailable → chain
// falls back to the API seat. Prompts here are argv-sized (debater rounds only).
async function askGeminiCli(model: string | undefined, prompt: string): Promise<Reply> {
  const via = "sub:gemini";
  const args = ["-p", prompt];
  if (model) args.push("-m", model);
  const proc = Bun.spawn(["gemini", ...args], {
    cwd: NEUTRAL_CWD,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const run = (async (): Promise<Reply> => {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const text = out.trim();
    if (code !== 0 || !text || /Ineligible|ProjectId|Error:|at throw|at process\./i.test(text)) {
      const detail = (err || text).trim().slice(0, 160) || `exit ${code}`;
      return { text: "", error: `gemini cli unavailable: ${detail}`, via };
    }
    return { text, via, costUsd: 0 };
  })();

  try {
    return await withTimeout(run, CALL_TIMEOUT_MS, "gemini");
  } catch (e) {
    proc.kill();
    return { text: "", error: (e as Error).message, via };
  }
}

// OpenRouter HTTP (paid per token). Bun auto-loads the repo .env, so
// OPENROUTER_API_KEY is present when the council runs from the project root.
//  - optional reasoning.effort (stripped and retried if the provider rejects it)
//  - one retry on 429/5xx/network errors
//  - usage captured; cost estimated from the seat's configured per-M rates
type OpenRouterOpts = {
  reasoningEffort?: "high" | "medium";
  // USD per million tokens (input, output) — for cost estimates only.
  // Baked from the live catalog 2026-07-09; drift only skews the estimate.
  rates?: { inPerM: number; outPerM: number };
};

async function askOpenRouter(
  model: string,
  prompt: string,
  opts?: OpenRouterOpts,
): Promise<Reply> {
  const via = "api:openrouter";
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { text: "", error: "OPENROUTER_API_KEY not set", via };

  let useReasoning = Boolean(opts?.reasoningEffort);
  let lastError = "no attempt made";

  for (let attempt = 1; attempt <= 3; attempt++) {
    const run = (async (): Promise<Reply | { retry: true; reason: string }> => {
      const body: Record<string, unknown> = {
        model,
        messages: [{ role: "user", content: prompt }],
      };
      if (useReasoning && opts?.reasoningEffort) {
        body.reasoning = { effort: opts.reasoningEffort };
      }

      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (r.status === 429 || r.status >= 500) {
        return { retry: true, reason: `openrouter ${r.status}` };
      }
      if (!r.ok) {
        const errText = (await r.text()).slice(0, 300);
        if (useReasoning && /reasoning|effort/i.test(errText)) {
          useReasoning = false;
          return { retry: true, reason: `reasoning param rejected — retrying plain` };
        }
        return { text: "", error: `openrouter ${r.status}: ${errText.slice(0, 200)}`, via };
      }

      const j: unknown = await r.json();
      let text = "";
      let usage: Usage | undefined;
      let apiError = "";
      if (isRecord(j)) {
        const choices = j.choices;
        if (Array.isArray(choices) && isRecord(choices[0])) {
          const msg = choices[0].message;
          if (isRecord(msg) && typeof msg.content === "string") text = msg.content.trim();
        }
        if (isRecord(j.usage)) {
          usage = {
            inTok: asNumber(j.usage.prompt_tokens) ?? 0,
            outTok: asNumber(j.usage.completion_tokens) ?? 0,
          };
        }
        if (isRecord(j.error) && typeof j.error.message === "string") apiError = j.error.message;
      }

      if (!text) {
        return { text: "", error: `openrouter empty (${apiError || "no content"})`, via };
      }

      const costUsd =
        usage && opts?.rates
          ? (usage.inTok * opts.rates.inPerM + usage.outTok * opts.rates.outPerM) / 1_000_000
          : undefined;
      return { text, via, usage, costUsd };
    })();

    try {
      const result = await withTimeout(run, CALL_TIMEOUT_MS, model);
      if ("retry" in result) {
        lastError = result.reason;
        log("council", "warn", `${model}: ${result.reason} (attempt ${attempt}/3)`);
        if (attempt < 3) await sleep(3000);
        continue;
      }
      return result;
    } catch (e) {
      const msg = (e as Error).message;
      lastError = msg;
      // Timeouts are terminal (the budget is spent); transient network errors retry.
      if (/timed out/.test(msg) || attempt >= 3) return { text: "", error: msg, via };
      await sleep(3000);
    }
  }
  return { text: "", error: lastError, via };
}

// Ollama local (OpenAI-compatible), $0. Offline fallback for the open-model
// seat — if Ollama is down too, the seat is flagged unavailable.
async function askOllama(model: string, prompt: string): Promise<Reply> {
  const via = "local:ollama";
  const run = fetch("http://localhost:11434/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: false }),
  })
    .then(async (r): Promise<Reply> => {
      if (!r.ok) return { text: "", error: `ollama ${r.status}`, via };
      const j: unknown = await r.json();
      let text = "";
      if (isRecord(j) && Array.isArray(j.choices) && isRecord(j.choices[0])) {
        const msg = j.choices[0].message;
        if (isRecord(msg) && typeof msg.content === "string") text = msg.content.trim();
      }
      return text
        ? { text, via, costUsd: 0 }
        : { text: "", error: "ollama empty response", via };
    })
    .catch((e: unknown): Reply => ({
      text: "",
      error: `ollama unreachable: ${(e as Error).message}`,
      via,
    }));

  try {
    return await withTimeout(run, CALL_TIMEOUT_MS, model);
  } catch (e) {
    return { text: "", error: (e as Error).message, via };
  }
}

// ── seats ────────────────────────────────────────────────────────────────────

type Ask = (prompt: string) => Promise<Reply>;

export type Member = {
  name: string;
  role: "debater" | "judge";
  // Human-readable model + route summary for the roster.
  route: string;
  personality: string;
  // Ordered provider chain: first non-error, non-empty reply wins. Put the $0
  // sub path first, the paid API fallback last (Kai inverts: frontier API
  // first, weak-local only as an offline fallback — quality > pennies).
  chain: Ask[];
};

export const DEBATERS: Member[] = [
  {
    name: "Claude",
    role: "debater",
    route: "Opus 4.8 (sub→api)",
    personality:
      "Methodical architect. The deepest reasoner. Plans before acting. Finds structural issues and subtle flaws others miss entirely.",
    chain: [
      (p) => askClaudeCli("claude-opus-4-8", p),
      (p) =>
        askOpenRouter("anthropic/claude-opus-4.8", p, {
          reasoningEffort: "high",
          rates: { inPerM: 5, outPerM: 25 },
        }),
    ],
  },
  {
    name: "Nova",
    role: "debater",
    route: "GPT-5.6 sol-pro (api)",
    personality:
      "Relentless reasoner. Chains of thought that go deep. Catches logical gaps and edge cases through exhaustive analysis.",
    // sol-pro = sol served with reasoning.mode=pro at the SAME price — strictly
    // better for a council seat where latency doesn't matter. Reasoning is
    // baked in server-side, so no effort param is sent.
    chain: [
      (p) => askOpenRouter("openai/gpt-5.6-sol-pro", p, { rates: { inPerM: 5, outPerM: 30 } }),
    ],
  },
  {
    name: "Gem",
    role: "debater",
    route: "Gemini 3.1 Pro (sub→api)",
    personality:
      "Massive context thinker. Holds entire systems in mind at once. Connects disparate information, sees patterns across scale.",
    chain: [
      (p) => askGeminiCli(undefined, p),
      (p) =>
        askOpenRouter("google/gemini-3.1-pro-preview", p, {
          reasoningEffort: "high",
          rates: { inPerM: 2, outPerM: 12 },
        }),
    ],
  },
  {
    name: "Grok",
    role: "debater",
    route: "Grok 4.5 (api)",
    personality:
      "Contrarian truth-teller. Questions assumptions. Cuts through politeness to say what others won't. Real-time awareness.",
    chain: [
      (p) =>
        askOpenRouter("x-ai/grok-4.5", p, {
          reasoningEffort: "high",
          rates: { inPerM: 2, outPerM: 6 },
        }),
    ],
  },
  {
    // Non-US-lab frontier seat. Replaces the old 3B local "Sage" — the judge's
    // own live verdict called that seat negative signal. DeepSeek V4 Pro adds
    // genuine training-lineage diversity for well under $0.01/call; the local
    // Ollama model survives only as an offline fallback.
    name: "Kai",
    role: "debater",
    route: "DeepSeek V4 Pro (api→local)",
    personality:
      "Independent frontier voice trained outside the US-lab consensus. Different priors, different blind spots. Judges ideas on engineering merit and cost realism, immune to Silicon Valley groupthink.",
    chain: [
      (p) =>
        askOpenRouter("deepseek/deepseek-v4-pro", p, {
          reasoningEffort: "high",
          rates: { inPerM: 0.435, outPerM: 0.87 },
        }),
      (p) => askOllama("llama3.2:3b", p),
    ],
  },
];

// The Chief Adjudicator does NOT debate. It reads every round BLIND (anonymous
// labels) and settles the question — judging, correcting, and overruling the
// debaters where they are wrong. Fable 5 via the sub ($0), OpenRouter fallback.
export const JUDGE: Member = {
  name: "Fable",
  role: "judge",
  route: "Fable 5 (sub→api)",
  personality:
    "Chief Adjudicator. Reads the whole debate blind and settles it on the best possible outcome — judges each position on its merits, corrects errors, overrules false consensus, and red-teams its own verdict before finalizing.",
  chain: [
    (p) => askClaudeCli("claude-fable-5", p),
    (p) =>
      askOpenRouter("anthropic/claude-fable-5", p, {
        reasoningEffort: "high",
        rates: { inPerM: 10, outPerM: 50 },
      }),
  ],
};

// ── spend tracking ───────────────────────────────────────────────────────────

type Spend = { calls: number; inTok: number; outTok: number; usd: number };

function trackSpend(spend: Map<string, Spend>, name: string, reply: Reply): void {
  const s = spend.get(name) ?? { calls: 0, inTok: 0, outTok: 0, usd: 0 };
  s.calls += 1;
  s.inTok += reply.usage?.inTok ?? 0;
  s.outTok += reply.usage?.outTok ?? 0;
  s.usd += reply.costUsd ?? 0;
  spend.set(name, s);
}

// Try each provider in order; return the first real reply, else the last error.
async function ask(member: Member, prompt: string, spend: Map<string, Spend>): Promise<Reply> {
  let lastError = "no providers configured";
  for (const step of member.chain) {
    const reply = await step(prompt);
    if (!reply.error && reply.text.trim().length > 0) {
      trackSpend(spend, member.name, reply);
      return reply;
    }
    lastError = reply.error ?? "empty response";
    log("council", "warn", `${member.name}: ${reply.via ?? "?"} unavailable — ${lastError}`);
  }
  return { text: "", error: lastError };
}

// ── blind labels ─────────────────────────────────────────────────────────────

function blindLabel(index: number): string {
  return `MEMBER-${String.fromCharCode(65 + index)}`; // MEMBER-A, MEMBER-B, …
}

// Replace anonymous labels with real names for the human-facing report.
// Tolerates "MEMBER-A", "Member A", "member-a's", etc.
export function deAnonymize(text: string, labelToName: Map<string, string>): string {
  let out = text;
  for (const [label, name] of labelToName) {
    const letter = label.slice(-1);
    out = out.replace(new RegExp(`\\bmember[-\\s]?${letter}\\b`, "gi"), name);
  }
  return out;
}

// ── progressive-disclosure TLDR ──────────────────────────────────────────────
// The adjudicator opens with a marker-delimited three-tier TLDR (one-liner →
// the gist → the map). Extract it so the report can lead with a skim gradient;
// the verdict body is what remains. Failure-open: if the judge skipped the
// contract, fall back to the first substantive line as the one-liner and keep
// the body untouched — the report always builds.
export type Tldr = { one?: string; two?: string; three?: string };

export function extractTldr(adjudication: string): { tldr: Tldr; body: string } {
  const m = adjudication.match(
    /\*{0,2}TLDR-ONE\*{0,2}:\*{0,2}\s*([\s\S]*?)\n\s*\*{0,2}TLDR-TWO\*{0,2}:\*{0,2}\s*([\s\S]*?)\n\s*\*{0,2}TLDR-THREE\*{0,2}:\*{0,2}\s*([\s\S]*?)\n\s*\*{0,2}END-TLDR\*{0,2}/,
  );
  if (!m) {
    const first = adjudication
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .map((l) => l.replace(/\*\*/g, "").trim())
      .find((l) => l.length >= 30);
    return { tldr: { one: first?.slice(0, 220) }, body: adjudication };
  }
  const [, one, two, three] = m;
  const body = adjudication.replace(m[0], "").trim();
  return {
    tldr: { one: one?.trim(), two: two?.trim(), three: three?.trim() },
    body: body || adjudication,
  };
}

// ── council run ──────────────────────────────────────────────────────────────

export async function runCouncil(
  input: string,
  debaters: Member[] = DEBATERS,
  judge: Member = JUDGE,
): Promise<{ report: string; roster: RosterEntry[]; totalCostUsd: number; tldr: Tldr }> {
  if (debaters.length === 0) throw new Error("Council must have at least one debater");

  const spend = new Map<string, Spend>();
  const labelToName = new Map<string, string>();
  const nameToLabel = new Map<string, string>();
  debaters.forEach((m, i) => {
    labelToName.set(blindLabel(i), m.name);
    nameToLabel.set(m.name, blindLabel(i));
  });

  // Round 1: Independent analysis (debaters know their own persona; they are
  // instructed NOT to self-identify so Rounds 2–3 can run blind).
  log("council", "info", "Round 1: Independent analysis", { members: debaters.length });
  process.stderr.write("\n🏛️  COUNCIL CONVENED\n\n");
  process.stderr.write("📋 Round 1: Independent Analysis\n");

  const round1 = await Promise.all(
    debaters.map(async (member) => {
      process.stderr.write(`   ⏳ ${member.name} thinking...\n`);
      const reply = await ask(
        member,
        `You are a council member with this analytical disposition: ${member.personality}

Analyze the input below independently. Be specific and actionable. Give your honest take — don't hedge.

Hard rules:
- Do NOT state, sign, or imply your name, model, or vendor identity anywhere in your analysis. Later rounds are judged blind.
- End with a final line in exactly this form: \`CONFIDENCE: High|Medium|Low — <the single fact or observation that would most change your mind>\`

INPUT:
${input}`,
        spend,
      );
      process.stderr.write(
        reply.error
          ? `   ⚠️  ${member.name} unavailable: ${reply.error}\n`
          : `   ✅ ${member.name} done (${reply.via})\n`,
      );
      return { name: member.name, text: reply.text, error: reply.error, via: reply.via };
    }),
  );

  const available = round1.filter((r) => !r.error && r.text.trim().length > 0);

  const buildRoster = (): RosterEntry[] =>
    debaters.map((member) => {
      const r = round1.find((x) => x.name === member.name);
      const ok = !!r && !r.error && r.text.trim().length > 0;
      const s = spend.get(member.name) ?? { calls: 0, inTok: 0, outTok: 0, usd: 0 };
      return {
        name: member.name,
        role: member.role,
        route: member.route,
        via: r?.via,
        status: ok ? "ok" : "failed",
        error: r?.error,
        calls: s.calls,
        inTok: s.inTok,
        outTok: s.outTok,
        costUsd: s.usd,
      };
    });

  if (available.length === 0) {
    process.stderr.write("\n❌ Every debater was unavailable — see roster.\n\n");
    const roster = buildRoster();
    roster.push({
      name: judge.name,
      role: "judge",
      route: judge.route,
      status: "failed",
      error: "no debate to adjudicate",
      calls: 0,
      inTok: 0,
      outTok: 0,
      costUsd: 0,
    });
    const noDebate = "_All debaters were unavailable. No adjudication was produced._";
    const report = buildReport(input, round1, [], noDebate, roster, labelToName, 0, {
      one: "All debaters were unavailable — no adjudication was produced.",
    });
    return { report, roster, totalCostUsd: 0, tldr: {} };
  }

  // Round 2: BLIND cross-examination — each surviving debater critiques the
  // others, who appear only as anonymous MEMBER labels.
  log("council", "info", "Round 2: Blind cross-examination", { participants: available.length });
  process.stderr.write("\n🔍 Round 2: Cross-Examination (blind)\n");

  const round2 = await Promise.all(
    debaters
      .filter((member) => available.some((a) => a.name === member.name))
      .map(async (member) => {
        const othersResponses = available
          .filter((r) => r.name !== member.name)
          .map((r) => `## ${nameToLabel.get(r.name)}'s Analysis\n${r.text}`)
          .join("\n\n---\n\n");

        if (!othersResponses.trim()) {
          return {
            name: member.name,
            critique: "",
            error: "no peer analyses available to critique",
          };
        }

        process.stderr.write(`   ⏳ ${member.name} reviewing others...\n`);
        const reply = await ask(
          member,
          `You are a council member with this analytical disposition: ${member.personality}

Below are the other members' independent analyses. They are ANONYMIZED as MEMBER-A, MEMBER-B, … (your own analysis is not among them). Refer to them ONLY by those labels. Critique them on the merits: where do you agree? Where do you disagree? What did they miss? Defend your position where you think you're right.

Do NOT state or imply your own identity.

ORIGINAL INPUT:
${input}

OTHER MEMBERS' ANALYSES:
${othersResponses}

YOUR CRITIQUE (be direct, not diplomatic):`,
          spend,
        );
        process.stderr.write(
          reply.error
            ? `   ⚠️  ${member.name} unavailable: ${reply.error}\n`
            : `   ✅ ${member.name} done\n`,
        );
        return { name: member.name, critique: reply.text, error: reply.error };
      }),
  );

  // Round 3: BLIND adjudication — Fable judges the anonymized debate, corrects
  // it, red-teams its own verdict, and settles.
  log("council", "info", "Round 3: Chief Adjudicator (blind judge + correction)");
  process.stderr.write("\n⚖️  Round 3: Chief Adjudicator (Fable, blind)\n");

  const allResponses = available
    .map((r) => `## ${nameToLabel.get(r.name)}'s Analysis\n${r.text}`)
    .join("\n\n---\n\n");

  const validCritiques = round2.filter((r) => !r.error && r.critique.trim().length > 0);
  const allCritiques = validCritiques.length
    ? validCritiques
        .map((r) => `## ${nameToLabel.get(r.name)}'s Critique\n${r.critique}`)
        .join("\n\n---\n\n")
    : "_No cross-examination critiques were produced._";

  const participatingLabels = available
    .map((r) => nameToLabel.get(r.name))
    .filter((l): l is string => typeof l === "string")
    .join(", ");

  const adjudicatorPrompt = `You are the Chief Adjudicator of a multi-model council. You did NOT participate in the debate. The debaters are five distinct frontier models, ANONYMIZED as ${participatingLabels}; they were instructed not to reveal their identities. Judge every position strictly on its merits — you have no information about which model is which, by design.

Your job is to JUDGE and CORRECT the debate, then SETTLE the question on the single best possible outcome — not to average opinions, not to be diplomatic. If the debaters were wrong, say so and give the right answer.

ORIGINAL QUESTION:
${input}

ROUND 1 — INDEPENDENT ANALYSES:
${allResponses}

ROUND 2 — CROSS-EXAMINATION:
${allCritiques}

START your response with EXACTLY this progressive-disclosure block (plain-text markers, no heading, no preamble before it):

TLDR-ONE: <the settled answer in ONE plain sentence or phrase — decisive, no hedging>
TLDR-TWO: <2–4 sentences — the answer, the core "why", and the strongest tension or flip condition. This is "what's really going on.">
TLDR-THREE:
- <6–10 tight bullets — the whole verdict in skimmable form: the decision, the top reasons, the strongest losing argument and why it lost, what the council got wrong, the flip condition, confidence>
END-TLDR

THEN produce the full sections (use the MEMBER labels when referring to debaters):

## Verdict on Each Position
For each debater, state what holds up and what is wrong, weak, or unsupported. Correct factual or logical errors outright — do not defer to the group.

## Corrected Thesis
The strongest synthesis of what is actually true, incorporating only what survives scrutiny.

## Settled Recommendation
The single best course of action, decided. Be concrete and actionable.

## What The Council Got Wrong
Errors, blind spots, or false consensus you overrode — and why.

## Self-Red-Team
Attack your own verdict: the strongest objection to your Settled Recommendation, what you might have missed, and under what conditions a rejected position would actually be right. Then either CONFIRM the verdict or AMEND it — explicitly.

## Confidence
High / Medium / Low, why, and the single fact that would change the verdict.`;

  let adjudication: string;
  let judgeVia: string | undefined;
  let judgeError: string | undefined;

  const judgeReply = await ask(judge, adjudicatorPrompt, spend);
  if (!judgeReply.error && judgeReply.text.trim()) {
    adjudication = judgeReply.text;
    judgeVia = judgeReply.via;
    process.stderr.write(`   ✅ Fable adjudicated (${judgeReply.via})\n`);
  } else {
    // Judge down — fall back to the first available debater as synthesizer so
    // the council never loses its final verdict.
    judgeError = judgeReply.error;
    const fallback = debaters.find((m) => available.some((a) => a.name === m.name));
    if (!fallback) throw new Error("unreachable: available is non-empty");
    process.stderr.write(
      `   ⚠️  Fable unavailable (${judgeReply.error}) — ${fallback.name} synthesizes instead\n`,
    );
    const fb = await ask(fallback, adjudicatorPrompt, spend);
    adjudication = fb.error
      ? `_Adjudication unavailable. Fable: ${judgeReply.error}. Fallback ${fallback.name}: ${fb.error}._`
      : `> ⚠️ Fable (judge) was unavailable — this verdict was produced by fallback synthesizer **${fallback.name}**.\n\n${fb.text}`;
    judgeVia = fb.via ? `fallback:${fallback.name}` : undefined;
  }

  const roster = buildRoster();
  const judgeSpend = spend.get(judge.name) ?? { calls: 0, inTok: 0, outTok: 0, usd: 0 };
  roster.push({
    name: judge.name,
    role: "judge",
    route: judge.route,
    via: judgeVia,
    status: judgeError ? "failed" : "ok",
    error: judgeError,
    calls: judgeSpend.calls,
    inTok: judgeSpend.inTok,
    outTok: judgeSpend.outTok,
    costUsd: judgeSpend.usd,
  });

  const totalCostUsd = roster.reduce((sum, r) => sum + r.costUsd, 0);

  process.stderr.write(
    `\n✅ Council complete — est. API spend $${totalCostUsd.toFixed(2)} (sub/local seats $0)\n\n`,
  );

  // Peel the judge's progressive-disclosure TLDR off the top of the verdict so
  // the report can lead with the skim gradient.
  const { tldr, body: adjudicationBody } = extractTldr(adjudication);

  const report = buildReport(
    input,
    round1,
    round2,
    adjudicationBody,
    roster,
    labelToName,
    totalCostUsd,
    tldr,
  );
  return { report, roster, totalCostUsd, tldr };
}

// ── report ───────────────────────────────────────────────────────────────────

function buildReport(
  input: string,
  round1: { name: string; text: string; error?: string; via?: string }[],
  round2: { name: string; critique: string; error?: string }[],
  adjudication: string,
  roster: RosterEntry[],
  labelToName: Map<string, string>,
  totalCostUsd: number,
  tldr: Tldr,
): string {
  const rosterLines = roster
    .map((r) => {
      const tag = r.role === "judge" ? " ⚖️ _judge_" : "";
      const via = r.via ? ` [${r.via}]` : "";
      const cost =
        r.status === "ok"
          ? r.costUsd > 0
            ? ` — ~$${r.costUsd.toFixed(2)}`
            : " — $0"
          : "";
      return r.status === "ok"
        ? `- **${r.name}** (${r.route})${via}${tag}${cost} — ✅ participated`
        : `- **${r.name}** (${r.route})${tag} — ⚠️ unavailable: ${r.error ?? "unknown"}`;
    })
    .join("\n");

  const adjudicationBody = deAnonymize(adjudication, labelToName);

  const round1Body = round1
    .map((r) => `### ${r.name}\n${r.error ? `_Unavailable: ${r.error}_` : r.text}`)
    .join("\n\n---\n\n");

  const round2Body = round2.length
    ? round2
        .map(
          (r) =>
            `### ${r.name}\n${
              r.error ? `_Unavailable: ${r.error}_` : deAnonymize(r.critique, labelToName)
            }`,
        )
        .join("\n\n---\n\n")
    : "_No cross-examination round (fewer than two debaters were available)._";

  // Progressive-disclosure TLDR — three ascending tiers (one-liner → the gist
  // → the map), then a jump row. The div wrappers style the HTML render and
  // pass through pandoc as raw HTML blocks; typst/PDF drops the tags but keeps
  // the markdown content, so every format leads with the skim gradient.
  const tiers: string[] = [];
  if (tldr.one) {
    tiers.push(
      `<div class="tldr-tier tldr-one">\n\n**${deAnonymize(tldr.one, labelToName)}**\n\n</div>`,
    );
  }
  if (tldr.two) {
    tiers.push(
      `<div class="tldr-tier tldr-two">\n\n${deAnonymize(tldr.two, labelToName)}\n\n</div>`,
    );
  }
  if (tldr.three) {
    tiers.push(
      `<div class="tldr-tier tldr-three">\n\n${deAnonymize(tldr.three, labelToName)}\n\n</div>`,
    );
  }
  const tldrBlock = tiers.length
    ? `<div class="tldr">
${tiers.join("\n")}
</div>

<p class="jump"><a href="#verdict">⚖️ Full verdict</a> · <a href="#roster">Roster &amp; cost</a> · <a href="#round-1">Round 1</a> · <a href="#round-2">Round 2</a></p>

`
    : "";

  return `# 🏛️ Agent Council Report

${tldrBlock}<a id="input"></a>

## Input
${input}

<a id="roster"></a>

## Roster & Status
${rosterLines}

**Estimated API spend:** $${totalCostUsd.toFixed(2)} (subscription/local seats run at $0.)

_Round 2 critiques and the Round 3 adjudication ran **blind** — debaters and judge saw only anonymous MEMBER labels, de-anonymized here for readability._

---

<a id="verdict"></a>

## ⚖️ The Verdict — Chief Adjudicator (Fable 5)

${adjudicationBody}

---

# Appendix: The Debate Record

<a id="round-1"></a>

## Round 1: Independent Analysis

${round1Body}

---

<a id="round-2"></a>

## Round 2: Cross-Examination (blind)

${round2Body}
`;
}

// ── artifacts: JSON + Markdown + PDF + HTML ─────────────────────────────────

const HTML_STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2.5rem 1.25rem 5rem;
    font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #fafaf8; color: #1a1a1a;
  }
  main { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 1.7rem; line-height: 1.25; margin: 0 0 1.5rem; }
  h2 { font-size: 1.25rem; margin: 2.5rem 0 0.75rem; padding-bottom: 0.35rem; border-bottom: 2px solid #d9d4c8; }
  h3 { font-size: 1.05rem; margin: 1.75rem 0 0.5rem; }
  hr { border: none; border-top: 1px solid #e2ddd2; margin: 2rem 0; }
  code { font: 0.875em ui-monospace, "SF Mono", Menlo, monospace; background: #efece4; padding: 0.1em 0.35em; border-radius: 4px; }
  pre { overflow-x: auto; background: #efece4; padding: 0.9rem 1rem; border-radius: 8px; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 1rem 0; padding: 0.5rem 1rem; border-left: 4px solid #b8a24a; background: #f4f1e8; border-radius: 0 8px 8px 0; }
  ul, ol { padding-left: 1.4rem; }
  li { margin: 0.25rem 0; }
  table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
  th, td { border: 1px solid #d9d4c8; padding: 0.4rem 0.7rem; text-align: left; }
  strong { font-weight: 650; }
  /* Progressive-disclosure TLDR: three ascending tiers, each denser than the
     last — skim the one-liner, glide to the gist, land on the map, then decide
     whether to dive. */
  .tldr { border: 1px solid #d9d4c8; border-left: 5px solid #b8a24a; border-radius: 10px; padding: 1.3rem 1.5rem; margin: 0 0 1rem; background: #f7f4ec; }
  .tldr-tier + .tldr-tier { margin-top: 1.05rem; padding-top: 1.05rem; border-top: 1px dashed #d9d4c8; }
  .tldr-tier::before { display: block; font-size: 0.68rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #8f7c35; margin-bottom: 0.35rem; }
  .tldr-one::before { content: "TL;DR"; }
  .tldr-two::before { content: "The gist"; }
  .tldr-three::before { content: "The map"; }
  .tldr-one p { font-size: 1.32rem; line-height: 1.38; margin: 0; }
  .tldr-two p { font-size: 1.02rem; margin: 0 0 0.4rem; }
  .tldr-two p:last-child { margin-bottom: 0; }
  .tldr-three ul { margin: 0; }
  .tldr-three li { margin: 0.16rem 0; font-size: 0.94rem; line-height: 1.5; }
  .jump { font-size: 0.88rem; color: #6b6553; margin: 0 0 2.25rem; }
  .jump a { color: inherit; text-underline-offset: 3px; }
  @media (prefers-color-scheme: dark) {
    body { background: #161512; color: #e8e6e1; }
    h2 { border-bottom-color: #3a372e; }
    hr { border-top-color: #2c2a24; }
    code, pre { background: #24221c; }
    blockquote { background: #221f16; border-left-color: #8f7c35; }
    th, td { border-color: #3a372e; }
    .tldr { background: #201d15; border-color: #3a372e; border-left-color: #8f7c35; }
    .tldr-tier + .tldr-tier { border-top-color: #3a372e; }
    .tldr-tier::before { color: #b8a24a; }
    .jump { color: #9a927c; }
  }
`;

export async function renderHtml(mdPath: string, htmlPath: string, title: string): Promise<boolean> {
  try {
    const body = await Bun.$`pandoc ${mdPath} -f gfm -t html`.text();
    const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${HTML_STYLE}</style>
</head>
<body><main>
${body}
</main></body>
</html>
`;
    await Bun.write(htmlPath, page);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("council", "warn", `HTML generation failed: ${msg}`);
    return false;
  }
}

export async function saveReport(
  input: string,
  report: string,
  roster: RosterEntry[],
  totalCostUsd: number,
  tldr: Tldr,
  outDir?: string,
): Promise<{ openPath: string; htmlPath?: string; pdfPath?: string; jsonPath: string }> {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const slug =
    input
      .slice(0, 50)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "council";

  const dir = outDir ?? process.env.COUNCIL_OUT_DIR ?? "./council-reports";
  const jsonPath = `${dir}/${ts}-${slug}.json`;
  const pdfPath = `${dir}/${ts}-${slug}.pdf`;
  const mdPath = `${dir}/${ts}-${slug}.md`;
  const htmlPath = `${dir}/${ts}-${slug}.html`;

  await mkdir(dir, { recursive: true });

  // Keep the markdown permanently next to the renders — it's the source for
  // both and the fallback if pandoc/typst are unavailable.
  await Bun.write(mdPath, report);

  // HTML is the primary deliverable (single-file, noindex, dark-mode aware).
  const htmlOk = await renderHtml(mdPath, htmlPath, `Council — ${slug}`);

  let pdfOk = false;
  try {
    await Bun.$`pandoc ${mdPath} -o ${pdfPath} --pdf-engine=typst`.quiet();
    pdfOk = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("council", "warn", `PDF generation failed — keeping markdown: ${msg}`);
  }

  const json = {
    timestamp: now.toISOString(),
    input,
    models: roster,
    totalCostUsd,
    tldr,
    htmlPath: htmlOk ? htmlPath : undefined,
    pdfPath: pdfOk ? pdfPath : undefined,
    report,
  };
  await Bun.write(jsonPath, JSON.stringify(json, null, 2));

  const openPath = htmlOk ? htmlPath : pdfOk ? pdfPath : mdPath;
  return {
    openPath,
    htmlPath: htmlOk ? htmlPath : undefined,
    pdfPath: pdfOk ? pdfPath : undefined,
    jsonPath,
  };
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────

if (import.meta.main) {
  const input = process.argv.slice(2).join(" ").trim();
  if (!input) {
    process.stderr.write("Usage: bun run src/council.ts <question or topic>\n");
    process.stderr.write(
      'Example: bun run src/council.ts "Should we price the product at $69 or $49?"\n',
    );
    process.exit(1);
  }

  const { report, roster, totalCostUsd, tldr } = await runCouncil(input);
  const saved = await saveReport(input, report, roster, totalCostUsd, tldr);

  if (saved.htmlPath) process.stderr.write(`\n📄 HTML: ${saved.htmlPath}\n`);
  if (saved.pdfPath) process.stderr.write(`📄 PDF: ${saved.pdfPath}\n`);
  process.stderr.write(`📋 JSON: ${saved.jsonPath}\n`);
  process.stderr.write(`💰 Est. API spend: $${totalCostUsd.toFixed(2)} (sub/local seats $0)\n`);

  const failures = roster.filter((r) => r.status === "failed");
  if (failures.length) {
    process.stderr.write(
      `⚠️  ${failures.length}/${roster.length} seats unavailable: ${failures
        .map((f) => f.name)
        .join(", ")}\n`,
    );
  }

  if (process.platform === "darwin") {
    process.stderr.write(`\n💡 Opening report...\n`);
    await Bun.$`open ${saved.openPath}`.quiet().nothrow();
  }

  process.stdout.write(report);
}
