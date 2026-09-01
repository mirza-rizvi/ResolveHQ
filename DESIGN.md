# ResolveHQ design system

ResolveHQ uses a “support ledger” visual model: dense, calm, accountable, and optimized for sustained queue work rather than dashboard decoration. The interface should feel like correspondence laid across a limestone work surface, with forest-green actions and rust reserved for urgency.

## Foundations

- Manrope is the product and data typeface. Newsreader is reserved for primary page and conversation titles.
- Core colors: paper `#fbfcf8`, limestone `#f1f3ee`, ink `#17231c`, forest `#1f6547`, pale forest `#e2eee6`, rule `#dde2dc`, rust/red for urgent states, and warm ochre for internal notes.
- Hairline dividers and ledger rows establish structure. Shadows are used sparingly for floating composers, dialogs, and focused controls.
- Information density is intentional. Avoid oversized cards, ornamental gradients, and non-functional hero treatments inside the application.

## Interaction patterns

- Desktop inbox: global navigation, queue navigation, ticket list, and active correspondence remain visible together.
- Mobile inbox: the ticket list is the entry surface; selecting a ticket opens a focused full-screen conversation with an explicit back control.
- Primary actions use forest green. Secondary controls remain white or transparent with visible borders.
- Customer messages, agent replies, and internal notes have distinct authorship and treatment. Internal notes use a warm private-note surface.
- Status, assignment, priority, and tags stay adjacent to the conversation header. Reply mode, saved replies, attachments, and send controls stay in the anchored composer.

## Accessibility

- Use semantic buttons, links, labels, headings, forms, and native selects where possible.
- Preserve visible focus rings, keyboard submission with Command/Ctrl+Enter, descriptive accessible names, and large enough mobile targets.
- Respect `prefers-reduced-motion`; responsive transitions must not be required to understand state.
- Never communicate status or priority with color alone; pair color with text.

## Reuse rules

- Extend the existing CSS variables and UI primitives before introducing a new visual language.
- New product pages should use `standard-page`, `page-header`, ledger rows, and quiet states when those patterns fit.
- Knowledge Base, Reports, and Automations must remain clearly labeled placeholders until they have real workflows; do not add vanity charts or fabricated data.
- AI additions must appear as optional assistive actions and must never block the human support workflow.
