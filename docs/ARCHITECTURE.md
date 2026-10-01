# Signalroom V1 architecture

Signalroom is one private web application backed by one local SQLite database. It deliberately avoids a job queue, microservices, a CRM, or a multi-agent framework.

## First working loop

1. The owner signs in and adds a product plus approved source material.
2. The application creates a versioned profile whose statements are visibly marked as known, hypothesis, or needs testing.
3. The owner corrects the thesis or selects one narrow audience and one observable intent signal.
4. A bounded research run uses only enabled source adapters. Built-in simulations automatically discover realistic fictional evidence; a separate adapter accepts public excerpts deliberately supplied by the owner. Neither path reads the internet.
5. Transparent qualification derives signal specificity, recency, product fit, evidence quality, source reliability, and disqualifiers from the stored evidence. The owner never has to assign numeric scores.
6. The application saves each stage, source result, rejection, failure, simulated cost, and partial opportunity as work happens. At most two runs are active; additional runs wait visibly.
7. The application ranks at most ten opportunities, recommends reply, DM, email, watch, or no action, and creates an evidence-grounded draft when outreach is appropriate. Every draft remains unsent.
8. Owner feedback and outcomes append learnings while preserving the earlier profile and original ranking reason.

## Reuse and dependency decision

The starting repository contained only a placeholder README, so there was no existing component or framework to extend. Node's built-in HTTP, cryptography, test runner, and SQLite support cover this V1 without adding a dependency or requiring a package download.

## External capabilities

Broad live discovery requires a compliant search provider. Synthesis beyond the transparent local rules will require an approved language-model provider. Both are disabled in this build: there are no credentials, network calls, or implied approval to spend money.

The successful, slow, failing, disabled, and paid sources are simulations. The paid simulation records fictional usage only and requires explicit approval plus a positive monthly limit. It cannot create a real charge.

Public repository documentation is read-only by policy. Private repositories, contact enrichment, email delivery, social posting, website changes, SEO execution, and analytics remain future provider interfaces.

## Safety and source policy

Every source explicitly records whether discovery, reading, storage, contact, and automation are allowed. Missing, unclear, disabled, deferred, or over-limit sources deny new access while keeping earlier permitted results readable. The owner-evidence adapter stores only the supplied excerpt, and no adapter can send outreach.

First-run owner creation works only over a loopback connection. A copy exposed before owner setup remains locked. Sessions expire after seven days; all product, evidence, opportunity, and draft APIs require the owner session.
