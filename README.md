# blind-council

Five frontier models debate your question. A sixth model, which never argued a side, judges the debate blind, corrects it, red-teams its own verdict, and settles the answer.

One command in, one verdict-first report out (HTML, PDF, Markdown, JSON), with a three-tier TLDR at the top so you can skim before you commit.

## Why this exists

Multi-model "councils" usually have two silent failure modes:

1. **Brand bias.** LLM judges measurably prefer their own family's outputs, and debaters defer to big-name analyses. blind-council anonymizes every debater as `MEMBER-A ... MEMBER-E` during cross-examination and adjudication. Nobody knows who wrote what, including the judge. Names come back only in the final report.
2. **Consensus worship.** Averaging five opinions produces mush, and five models fed the same framing can converge on the same wrong answer. Here the judge's job is explicitly to correct the debate: rule on each position, overrule false consensus, attack its own verdict (a mandatory Self-Red-Team section that must end in CONFIRM or AMEND), and only then settle.

Prior art: [karpathy/llm-council](https://github.com/karpathy/llm-council) popularized the council pattern. blind-council differs in four ways: blind rounds, a dedicated judge seat that never debates, subscription-first routing (below), and a progressive-disclosure TLDR contract.

## How it works

```
Round 1  Independent analysis     5 debaters, parallel, no self-identification,
                                  forced CONFIDENCE line each
Round 2  Cross-examination        each debater critiques the others, BLIND
Round 3  Adjudication             the judge (never a debater) rules on each
                                  position, corrects errors, self-red-teams,
                                  settles the answer, BLIND
```

Failed seats (auth, quota, timeout) are flagged in the roster and excluded from later rounds. The council degrades gracefully; if the judge itself is down, the strongest surviving debater synthesizes as a clearly labeled fallback.

## The seats

| Seat | Model | Route |
|------|-------|-------|
| Claude | Claude Opus 4.8 | `claude -p` subscription CLI first, OpenRouter fallback |
| Nova | GPT-5.6 sol-pro | OpenRouter |
| Gem | Gemini 3.1 Pro | `gemini` CLI first, OpenRouter fallback |
| Grok | Grok 4.5 | OpenRouter |
| Kai | DeepSeek V4 Pro | OpenRouter, local Ollama offline fallback |
| **Fable (judge)** | Claude Fable 5 | `claude -p` subscription CLI first, OpenRouter fallback |

This is the July 2026 lineup the code ships with. Model names move fast; swap in the current ones in `src/council.ts` before a serious convening.

Every seat is a provider chain: the cheapest already-paid path first (a signed-in subscription CLI at zero marginal cost), the metered API as fallback. If you have Claude Code signed in, the Claude debater and the judge run free. If you have nothing but an OpenRouter key, everything still works. Edit `DEBATERS` and `JUDGE` in `src/council.ts` to change the roster; each seat is a few lines.

API seats run at high reasoning effort, with automatic strip-and-retry if a provider rejects the reasoning parameter, plus retry on 429/5xx. Per-seat token and dollar telemetry lands in the roster, the JSON, and stderr. A full six-seat convening typically costs one to two dollars.

## The report

The report opens with a progressive-disclosure TLDR authored by the judge under a hard output contract:

1. **TL;DR.** The settled answer in one sentence.
2. **The gist.** Two to four sentences: the answer, the core why, the strongest tension or flip condition.
3. **The map.** Six to ten bullets: the whole verdict in skimmable form, including the strongest losing argument, what the council got wrong, and confidence.

Then a jump nav, then the full verdict, then the complete debate record as an appendix. Each tier earns the next; most reads stop at the map. If the judge ever skips the contract, the report still builds (failure-open).

## Quickstart

Requires [Bun](https://bun.sh) and [pandoc](https://pandoc.org) (plus [typst](https://typst.app) if you want PDF output; HTML and Markdown work without it).

```bash
git clone https://github.com/LucasCooperBey/blind-council
cd blind-council
bun install
cp .env.example .env   # add your OpenRouter key
bun run council "Should we build feature X or kill it?"
```

Optional free seats:

- **Claude Code signed in** routes the Claude debater and the Fable judge through `claude -p` at zero marginal cost (headless mode is a supported first-party feature). Note that council runs share your subscription's usage quota.
- **gemini CLI signed in** does the same for the Gemini seat.
- **Ollama running** gives the DeepSeek seat an offline fallback.

Configuration:

- `OPENROUTER_API_KEY` in `.env` powers the API seats and all fallbacks.
- `COUNCIL_OUT_DIR` overrides the report directory (default `./council-reports`).

```bash
bun run typecheck   # strict TS gate
bun test            # unit tests (TLDR extraction, de-anonymization)
```

## Sample verdict structure

```
## Verdict on Each Position     what holds up, what is wrong, per debater
## Corrected Thesis             only what survives scrutiny
## Settled Recommendation       one decided course of action
## What The Council Got Wrong   false consensus overridden, and why
## Self-Red-Team                strongest objection to the verdict, then CONFIRM or AMEND
## Confidence                   High/Medium/Low and the single fact that would flip it
```

## License

MIT
