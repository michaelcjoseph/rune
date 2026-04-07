/** The default schema.md content for a new knowledge base. */
export const DEFAULT_SCHEMA = `# Knowledge Base Schema

## Purpose
This knowledge base is a personal wiki compiled by an AI assistant from raw source material. It serves as a second brain — a searchable, interlinked collection of knowledge organized for retrieval and synthesis.

## Directory Structure
- raw/articles/     — Readwise articles, web clips (immutable after ingestion)
- raw/conversations/ — Captured Telegram conversation summaries
- raw/notes/        — User-shared notes, ideas, observations
- raw/media/        — Transcripts from YouTube, podcasts (future)
- wiki/entities/    — People, companies, projects, products
- wiki/concepts/    — Ideas, frameworks, mental models, principles
- wiki/topics/      — Broad topic syntheses (crypto, AI, health, etc.)
- wiki/comparisons/ — X vs Y structured analyses

## Page Templates

Every wiki page MUST begin with a YAML frontmatter block. This frontmatter enables structured search filtering and temporal tracking.

### Entity Page (wiki/entities/)

\`\`\`
---
type: entity
tags: [tag1, tag2]
related: [other-entity, topic-page]
created: YYYY-MM-DD
last-verified: YYYY-MM-DD
valid-until: YYYY-MM-DD  # optional — only for time-sensitive facts
---
# [Entity Name]

**Type:** person | company | project | product

## Overview
[2-3 sentence summary]

## Key Facts
- [fact with [[source link]] citation]

## Connections
- Related to [[other-entity]] because...
- Mentioned in [[topic-page]]

## Sources
- [[raw/articles/source-name]] (ingested YYYY-MM-DD)
\`\`\`

### Concept Page (wiki/concepts/)

\`\`\`
---
type: concept
tags: [tag1, tag2]
related: [concept-a, concept-b]
created: YYYY-MM-DD
last-verified: YYYY-MM-DD
---
# [Concept Name]

## Definition
[Clear, concise definition]

## Key Principles
1. [Principle] — [explanation] ([[source]])

## Applications
- [How this applies to current work/thinking]

## Related Concepts
- [[concept-a]] — [relationship]

## Sources
- [[raw/articles/source-name]] (ingested YYYY-MM-DD)
\`\`\`

### Topic Page (wiki/topics/)

\`\`\`
---
type: topic
tags: [tag1, tag2]
related: [entity-1, concept-a]
created: YYYY-MM-DD
last-verified: YYYY-MM-DD
---
# [Topic Name]

## Overview
[3-5 sentence synthesis of current understanding]

## Key Themes
### [Theme 1]
[Discussion with citations]

## Open Questions
- [What's unresolved or uncertain]

## Key Entities
- [[entity-1]] — [relevance]

## Sources
- [[raw/articles/source-name]] (ingested YYYY-MM-DD)
\`\`\`

## Conventions

### Frontmatter
- Every wiki page MUST start with a YAML frontmatter block (between \`---\` delimiters)
- Required fields: \`type\`, \`tags\`, \`related\`, \`created\`, \`last-verified\`
- \`type\`: one of \`entity\`, \`concept\`, \`topic\`, \`comparison\`
- \`tags\`: array of topic tags (see Tags section below), without # prefix
- \`related\`: array of kebab-case page names this page links to (no [[ ]] brackets)
- \`created\`: date the page was first created (YYYY-MM-DD)
- \`last-verified\`: date the page content was last reviewed/updated (YYYY-MM-DD) — set to today on every edit
- \`valid-until\`: (optional) expiry date for time-sensitive facts (e.g., someone's current role, active projects). Omit for evergreen content.

### Wikilinks
- Use [[page-name]] for all internal links
- Page names are kebab-case: [[onchain-identity]], [[vitalik-buterin]]
- Link to both wiki pages AND personal vault pages (e.g., [[UNO]], [[playbook]])
- When creating a new page, always add a link from at least one existing page

### Tags
Use tags from this list (in frontmatter as plain strings, in body text with # prefix):
ai, crypto, energy, demographics, governance, health, productivity,
investing, psychology, writing, engineering, product, design

Pages can have multiple tags.

### Citations
- Always cite source material with [[raw/type/source-name]]
- Include ingestion date
- If a claim comes from multiple sources, cite all of them

### Tone
- Neutral, factual, concise
- Favor concrete claims over vague summaries
- Flag uncertainty: "According to [source]..." or "Disputed: ..."
- No hedging language — state the claim and cite the source

### Updates
- When updating a page with new information, preserve existing content
- Add new information in the appropriate section
- Update the Sources section
- If new info contradicts existing content, note the contradiction explicitly

## Index Format (index.md)
Each entry is one line:
- [[page-name]] — 8-15 word summary (updated: YYYY-MM-DD)

Organized by category (Entities, Concepts, Topics, Comparisons).

## Log Format (log.md)
Each entry:
[YYYY-MM-DD HH:MM] [OPERATION] description
  Sources: [[source1]], [[source2]]
  Pages touched: [[page1]], [[page2]]

Operations: INGEST, COMPILE, QUERY, LINT, UPDATE
`;
