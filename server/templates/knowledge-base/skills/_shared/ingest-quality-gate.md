# Ingest Quality Gate

Scope: the active draft under `pending_review/drafts/<draft-id>/knowledge/`.

Use Grep and Read tools to check for:

- **Orphan pages** — knowledge pages with no inbound `[[links]]` from other pages
- **Broken links** — `[[Links]]` pointing to pages that don't exist
- **Contradictions** — claims that conflict across pages
- **Stale summaries** — pages not updated after newer sources
- **Missing pages** — pages for types defined in {{KNOWLEDGE_SUBDIRS}} referenced in 3+ pages but lacking their own page
- **Taxonomy drift** — actual directory structure or `type` frontmatter values diverging from the schema defined in this file
- **Data gaps** — questions the knowledge can't answer; suggest new sources

Fix blocking findings in the active draft immediately. Do not write `meta.json` while broken links, missing index entries, invalid page types, or source/draft contradictions introduced by this ingest remain unresolved.

For non-blocking data gaps, capture the gap in the most relevant draft source page, overview, or log entry so Review can see it.
