# TM1 Knowledge Base — Default Bundle

Shipped with `tm1-mcp-server`. Override by setting `TM1_KNOWLEDGE_DIR` to a directory containing your own `*.md` files.

## Topics

- **ti-syntax** — TurboIntegrator function reference, control flow, common patterns
- **mdx-patterns** — MDX queries for TM1: set operations, calculated members, drilldown
- **tm1-rules** — Cube rules syntax, feeders, SKIPCHECK / FEEDSTRINGS

## Conventions

Each article uses `##` headers per section. Use `tm1_get_knowledge(topic='<name>', search='<keyword>')` to fetch only matching sections — saves tokens on large articles.

## Workflow

1. `tm1_get_knowledge(topic='list')` — list shipped topics
2. `tm1_get_knowledge(topic='index')` — read this file
3. `tm1_get_knowledge(topic='ti-syntax', search='ASCIIOUTPUT')` — section-filtered fetch

## Customizing

Point `TM1_KNOWLEDGE_DIR=/path/to/your/knowledge` to replace this bundle with project-specific content. The tool falls back to the bundled directory only when the env var is unset.
