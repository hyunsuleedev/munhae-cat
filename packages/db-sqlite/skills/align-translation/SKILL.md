---
name: align-translation
version: 1.0.0
description: Align a saved Korean translation with exact source evidence without rewriting either text.
---
Read the complete source and complete saved translation. Translation sentences are display references, not independent translation requests.
Return only correspondence data in the app schema. Never rewrite, correct, reorder or re-paragraph the translation.
For every supplied target sentence, identify exact source quotations. Existing punctuation boundaries are hints, not mandatory one-to-one boundaries.
Allow several source spans for a target sentence, and the same source span for several target sentences. Use context to resolve repeated phrases; quote a wider unambiguous span where needed.
Copy each source quote exactly from the supplied canonical source, including existing whitespace and punctuation. Use its 1-based occurrence number when an identical quote occurs more than once. Never guess a repeated occurrence: mark needsReview if unsure.
If no defensible source correspondence exists, return no quotes and mark needsReview. Do not force coverage or claim correctness just because every sentence has a link.
Submit exactly the JSON schema through the run-scoped submission tool. No project/database file writes.
