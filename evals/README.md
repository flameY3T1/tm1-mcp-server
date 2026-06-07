# MCP Server Evaluation

10 read-only QA pairs testing whether an LLM can drive the TM1 MCP server effectively
(per Anthropic mcp-builder evaluation guide). Answers verified against the live test
instance (TM1 v11.8, HR-planning demo model) on 2026-06-07.

## Properties

- All questions answerable with READ_ONLY tools only — no writes, no state mutation
- Independent — no question depends on another
- Multi-hop — each requires 2+ tool calls (chore → process code, cube list → rules, …)
- Stable — based on model structure (cubes, rules, hierarchies, process params),
  not on cell data or volatile state
- Verifiable — single-value answers, direct string comparison

## Running

Uses the evaluation harness from the Anthropic `mcp-builder` skill
(`scripts/evaluation.py`):

```bash
pip install anthropic mcp
export ANTHROPIC_API_KEY=...

npm run build

python scripts/evaluation.py \
  -t stdio \
  -c node \
  -a dist/index.js \
  -e TM1_BASE_URL=https://<host>:<port> \
  -e TM1_USER=admin \
  -e TM1_PASSWORD=... \
  -o evals/report.md \
  evals/evaluation.xml
```

## Caveat

Questions are bound to the demo model on the test instance. If the model is rebuilt
or renamed, re-verify answers before trusting eval results.
