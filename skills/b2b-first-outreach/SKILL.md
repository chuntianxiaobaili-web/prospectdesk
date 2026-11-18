---
name: b2b-first-outreach
description: Read customer records and seller evidence to draft and review individualized first outreach, with English and Chinese review copies; adapt the writing to physical products, digital offers, services and explicitly identified non-B2B audiences. Drafting only, not enquiry replies or sending.
---
# First outreach from customer and seller facts

Act as the seller's representative. The first message should establish why this recipient is relevant, one useful offer and one easy reply. Do not turn a particular brand, product, industry or sales policy into a universal default. Deliver drafts only; do not log into mailboxes, reply to enquiries, schedule or send messages.

## 1. Read the records and choose one supported angle

Read the company name, website, buyer type, actual products or projects, verified public business email, evidence links and contact history. Then read the seller's actual products or services, specifications, sample policy and commitments. A company name and email alone are insufficient.

Choose one verifiable recipient fact that connects to the seller's actual capability: a concrete product, collection, business use or purchasing entry point. Prefer the buyer's website or catalogue. Keep an internal chain of fact -> evidence link -> why the recommendation fits. Keep research notes outside the email.

For wholesalers, consider a category relevant to replenishment or assortment. For retailers, consider a style relevant to an existing range. For project buyers, consider supported specifications, a use case or a sample option. These are writing angles, not evidence of pain, demand or a purchase plan. A publicly listed address does not itself establish agreement to receive a message.

Use a company-team greeting when no person's identity is verified. If recipient identity, relevance or business-email evidence is insufficient, mark the missing facts and hold the record. Already contacted, refused or unsubscribed records do not enter the first-outreach draft list. Do not guess names, roles or addresses.

Adapt the angle from the user's actual industry, product and intended audience. Explicit audience and offer-type settings take priority; conflicting or insufficient context stays unknown. Physical offers may use verified materials, specifications or sample options; digital offers may use verified licensing, compatibility or delivery terms; services may use verified scope, deliverables or collaboration. Do not invent benefits, statistics, results or fulfilment promises. For personal/B2C recipients, use the minimum necessary verified identity and voluntary-contact context; if these are unverified, hold an internal review note rather than producing a recipient-ready first message. This writing adaptation does not imply that the package's company-record importer accepts personal records without business fields.

## 2. Write one message per recipient

- Subject: short and concrete about a product, use or purchasing topic. No fake Re:, inflated promises or bait.
- Opening: one or two sentences naming the concrete customer fact and why it makes contact relevant. Avoid generic praise or merely saying you saw the website.
- Body: one relevant offer with one supported detail, such as material, specification, a confirmed sample option, licence condition or service deliverable. Do not stack products, selling points or company history. Unverified prices, inventory, MOQ, lead times, freight and certifications stay unknown rather than promises.
- Closing: one easy question and one next step. Do not ask for a meeting, budget and purchasing sheet together. For example, when supported by the seller's offer: “Would you prefer to see single stems or bouquets?”

Default English length is approximately 70–120 words excluding the signature. Use natural business English and stop when the meaning is complete. Supply a Chinese subject and full Chinese review body with the same facts and commitments. Reuse the structure where useful, not whole paragraphs. Do not add an automatic catalogue attachment.

## 3. Review each draft and deliver

Apply the name-swap test: if replacing the company name with a competitor leaves the whole message equally valid, reselect the customer fact, recommendation and question. Changing a few words is insufficient.

Check each draft against its evidence: the customer fact is traceable; the recommendation matches the business; seller commitments have support; English and Chinese agree; only one next step remains. Compare drafts within the batch to detect near-duplicate content. If no other batch drafts are available, mark that comparison pending rather than claiming it passed. Rewrite failures; mark insufficient evidence as needs-information.

For each eligible company output: company | verified public business email, if available | English subject and body | Chinese subject and body | personalization fact and evidence links | review status. Keep evidence and review notes in separate fields outside customer-visible copy. Deliver held records with their reasons separately, without first-message copy. No draft becomes approved merely because writing is complete.

In the package's JSON drafting route preserve the required subject, english and chinese fields. Put the translated subject at the start of chinese, followed by the full translated body. Return personalizationBasis, reviewStatus and reviewNotes as separate metadata; the existing core persists its supported three draft fields and applies its existing exact-version review checks. Keep metadata in the review handoff; do not assume unsupported fields have been stored by the core.

## 4. Conditional upstream learning review

Only apply the original 100-source learning gate when the upstream workflow explicitly selects hundred-source-playbook. Check its reviewed learning records and approval before drafting. Each counted source needs a title, link and methods actually extracted from content. Duplicates, title-only reading and unverifiable sources do not count. Report the verified reviewed count and gap if the gate is not met; do not claim completion. The reviewed record develops the writing method, does not require relearning 100 sources per email and does not justify copying tutorial prose into customer mail.

When the user selected product-evidence-review, work from the supplied seller evidence and per-message review; do not manufacture a learning count or claim that a 100-source gate passed. Follow the selected upstream policy and preserve its version and approval checks. Replying to a supplied enquiry belongs to the separate reply workflow, not this skill.
