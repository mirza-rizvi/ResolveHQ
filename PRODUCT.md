# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React, TypeScript, Tailwind CSS, shadcn/ui, and React Router on the frontend; Hono on Cloudflare Workers; Cloudflare D1 with Drizzle ORM; Cloudflare R2 for files; Cloudflare Queues and Cron Triggers for asynchronous work. This stack was explicitly requested.

## Users

Primary users are owners, administrators, and support agents at small SaaS companies, software and WordPress businesses, agencies, and ecommerce companies. They need to receive, organize, collaborate on, and resolve customer requests without enterprise helpdesk overhead.

Customers are external participants who submit requests and exchange messages with the support team. A customer-facing portal is a future feature, not part of the first agent application.

## Product Purpose

ResolveHQ gives a small support team one fast, self-hostable workspace for customer requests, ticket ownership, replies, internal notes, customer history, tags, saved replies, attachments, search, and team collaboration. MVP success means a real business can complete the full lifecycle from owner signup and agent invitation through ticket resolution and later retrieval without cross-organization data exposure.

## Positioning

ResolveHQ keeps the operational core of Help Scout, Freshdesk, and Zendesk while being intentionally smaller, faster, Cloudflare-native, self-hostable, and designed for a future in which AI augments support without becoming a required dependency.

## Operating Context

Agents work primarily from a desktop inbox throughout the day. They scan queue state, open conversations, assign ownership, add private notes, reply to customers, change priority and status, tag work, search prior resolutions, and inspect complete customer history. Owners and admins invite teammates and manage support settings.

## Capabilities and Constraints

- Multi-tenant from day one; every business-owned resource belongs to an organization and server-side authorization enforces isolation.
- Roles are Owner, Admin, and Agent.
- Ticket statuses are Open, Pending, Waiting for Customer, Resolved, and Closed.
- Ticket priorities are Low, Normal, High, and Urgent.
- D1 is the relational source of truth. R2 storage must remain replaceable by an S3-compatible implementation.
- Incoming mail, outgoing mail, and AI are provider interfaces rather than vendor-specific dependencies.
- Knowledge Base, Reports, and Automations appear as honest placeholders in the MVP.
- Future features must fit without microservices or speculative enterprise machinery.
- Production mail provider, pricing, public API policy, and commercial licensing remain open decisions.

## Brand Commitments

The product name is ResolveHQ. Product voice is concise, calm, competent, and human. The application should feel closer to Linear, Help Scout, Intercom, and Vercel than traditional enterprise administration software. It must avoid visual clutter, excessive gradients, oversized cards, and decorative motion.

## Evidence on Hand

The implementation brief is the current source of product truth. `mailflare` in the parent workspace is a technical reference for proven Cloudflare Workers, D1, R2, queues, authentication, email, and deployment patterns. No customer logos, testimonials, benchmarks, pricing claims, or final brand assets exist and none should be fabricated.

## Product Principles

1. Optimize for resolving customer work, not configuring the helpdesk.
2. Make tenant boundaries explicit in schema, repositories, and authorization.
3. Keep the daily inbox fast, dense, keyboard-friendly, and understandable at a glance.
4. Prefer replaceable provider seams at external boundaries, not abstractions inside simple domain logic.
5. Make AI optional and additive; the human support workflow must remain complete without it.

## Accessibility & Inclusion

The web application must be keyboard-friendly, responsive, and meet WCAG 2.2 AA expectations for semantics, focus visibility, contrast, error identification, and reduced motion.
