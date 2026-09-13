---
name: query-deepen
description: Run the canonical knowledge query workflow. Use for all knowledge-content questions, natural-language business questions, and fallback question handling when no other workflow clearly applies.
---

# Query Deepen

## Overview

Use this skill for all knowledge-content questions, whether or not the user used a `query:` prefix. It owns the full query process:
- identify relevant knowledge pages
- read them
- draft an internal intermediate answer
- deepen the investigation when useful
- shape the final answer with the chosen answer composition

Do not use this skill for ingest or graph building.

## Workflow

1. Read `knowledge/index.md` to identify relevant seed pages.
2. Read the most direct seed pages.
3. Draft an internal intermediate working_answer for yourself. **You MUST immediately Output this intermediate working answer as visible text**, enclosed within `<working_answer>` and `</working_answer>` tags, so the user can see your current understanding. This is not the final user answer.
4. Decide the likely answer composition before more retrieval:
   - what sections the user will likely need
   - what distinctions are easy to confuse
   - what caveats materially affect the conclusion
5. Compare the intermediate working_answer with the user's original query and ask what is still under-explained, over-broad, easy to misread, or insufficiently supported.
6. Identify concrete deepening retrieval questions based on gaps, ambiguity, weak evidence, missing lifecycle branches, unclear boundaries, or likely neighboring concepts. **You MUST immediately Output these deepening retrieval questions as visible text**, enclosed within `<deepening_queries>` and `</deepening_queries>` tags, so the user can see what gaps you are investigating. The purpose is to guide additional knowledge retrieval and evidence expansion. 
7. Use the `deepening_queries` items to drive additional retrieval. Read additional pages that directly address those gaps before producing the final answer.    
8. Stop expanding once the new pages no longer materially change or qualify the answer.
9. Synthesize the final user-facing answer using the refined evidence set and the chosen answer composition.
10. Ask whether the answer should be saved. If yes, call the `knowledge_save_synthesis` MCP tool with the complete Markdown content for the synthesis page. You may provide an optional ASCII slug and one-line index summary. Do not create `pending_review/drafts/`, do not write `meta.json`, do not create or update `ingest-plans/`, do not run Verify, and do not move the journey to Review. If the tool reports that pending Review drafts exist, tell the user to approve, discard, or recover those pending Review drafts before saving this synthesis.

## Retrieval Guidance

When identifying relevant pages from `knowledge/index.md`, prefer the pages that look most directly useful for the user's question.

When deepening, prefer directly related pages rather than restarting the search from scratch.

Prefer, in this order:
- pages explicitly linked from the initial pages or index entries for the same subject
- pages that directly define the subject, behavior, constraints, data shape, state changes, or interaction contract
- pages that explain adjacent dependencies, exceptions, lifecycle branches, or boundary cases needed for the chosen answer composition
- primary source evidence that anchors or resolves claims
- high-level summaries only when they add cross-page framing

For broad concept or entity queries, try to cover most of these evidence roles before answering if they exist:
- definition and purpose
- structure, data, roles, or dimensions
- lifecycle, operation, constraints, or rule effects
- interactions or boundaries when operational behavior matters
- source-backed evidence when maturity, contradictions, or code-vs-doc drift matters

## Answer Shape

Always answer in layers, not as a single compressed summary.

Start with:
- a 1-2 sentence direct answer

Build the answer from one lead shape plus any supporting shapes that are necessary.

The lead shape controls the top-level organization. Supporting shapes add sections, qualifiers, or missing dimensions. Do not force a mixed question into a single shape.

Available shapes:
- `fact`: narrow lookup
- `concept`: concept, object, module, capability, or business entity
- `workflow`: process, lifecycle, approval path, state transition, or ordered journey
- `mechanism`: internal operation, routing, matching, generation, selection, or decision process
- `interface`: API, event, integration, tool call, or component boundary
- `rule`: condition, permission, gate, validation, policy, or constraint
- `compare`: difference, boundary, tradeoff, or relationship

Choose the lead shape by the user's main need:
- understand what something is -> `concept`
- trace how something proceeds or changes -> `workflow`
- understand how a result is produced -> `mechanism`
- understand a boundary or exchange -> `interface`
- understand conditions or constraints -> `rule`
- distinguish related things -> `compare`
- retrieve a specific value -> `fact`

Read `references/answer-shapes/<shape>.md` for the lead shape before the final answer. Many questions need more than one shape; when two or more shapes may materially affect the answer, read all relevant shape references before composing the response. Do not load every shape.

For broad or ambiguous questions, include enough structure that the answer covers the important dimensions the knowledge supports. If an expected dimension is unsupported, state it as a knowledge gap instead of silently omitting it.

Aim for enough detail that a reasonable next question would be narrower than "can you expand this?"

## Answer Quality

Before finalizing, check whether the answer is missing anything that would materially change the user's understanding:
- a necessary definition, boundary, or precondition
- an exception, alternate path, or negative case
- a dependency, state change, or downstream effect
- a source conflict, weak claim, or unsupported expected dimension

Do not outsource substance to source pages. Never tell the user to read a Markdown page for the real explanation. If a page appears to contain needed detail, continue deepening, read it, and synthesize the relevant content into the answer.

Deepen only when the missing point materially improves the answer. If the knowledge cannot support it after deepening, state the gap briefly.

## Writing Requirements

The final answer should:
- match the user's input language unless the user explicitly asks otherwise
- read like a direct response, not like a knowledge page dump
- synthesize across pages instead of listing page summaries
- avoid inline `[[PageName]]` links in the main answer
- preserve exact identifiers when accuracy depends on them
- make it explicit whether the answer comes from PRDs, code, or both when that distinction matters
- include a final `参考页面` section with supporting knowledge pages
- ask whether the answer should be saved as a synthesis
- if saved, call the `knowledge_save_synthesis` MCP tool; do not write files directly and do not stage a Review draft

Use headings or bullets when they materially improve readability. For broad explainers, prefer structure over terseness.

## Stop Rule

Stop deepening when one of these is true:
- the added pages no longer materially improve the answer
- the key caveat or branch has now been explained clearly
- the remaining uncertainty is a real knowledge gap rather than a retrieval gap

If the knowledge still cannot fully resolve the question after deepening, say so in the final answer instead of pretending the answer is complete.

## Constraints

- Never include or repate `<working_answer>` or `<deepening_queries>` blocks in your final response.
- Do Not expand your search indefinitely
- Do NOT collect loosely related pages just because they share terms
- Do NOT let a synthesis page outweigh more direct rule, flow, interface, object, or source evidence
- Nevernbury a material exception in a throwaway sentence if it changes the practical conclusion
- DO Not answer a broad explainer with only a terse summary when the retrieved evidence supports a richer explanation
