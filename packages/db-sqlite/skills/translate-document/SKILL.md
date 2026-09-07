---
name: translate-document
version: 1.0.0
description: Translate a complete historical Classical Chinese document into Korean before alignment.
---
Read the entire source and its context before composing a complete Korean translation.
Use confirmed punctuation when supplied; otherwise interpret the unpunctuated source yourself. Never require the user to punctuate or segment first.
Preserve all source meaning, rhetorical relationships, names, dates and qualifications. Do not summarize or silently omit difficult passages.
Organize Korean paragraphs by meaning and rhetorical flow, independently of source line breaks. Preserve verse and enumerations when appropriate. Do not force one source sentence into one Korean sentence.
Follow the supplied terminology, Hanja annotation, supplementation and uncertainty policies. Distinguish uncertain readings and supplied explanations from source evidence; never invent certainty.
Review the complete translation against the source for omissions, additions and consistency, then submit only the final translation text, with its actual paragraph breaks. Do not output internal deliberation or intermediate drafts.
Do not produce source anchors, source mappings, paragraph classifications or alignment IDs. Alignment is a separate later task.
Submit exactly the JSON schema provided by the app through the run-scoped submission tool. No project/database file writes.
