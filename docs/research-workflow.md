# Generic research and learning API

This is a source-evidence **ingester and workflow**, not a crawler, independent source verifier, delivery verifier or model-training system. Real collection/reading must be performed through configured authorized Harness web/browser tools following the bundled skills. Defaults contain no researched prospects and no reviewed learning sources.

## ResearchLedger(config, state)
Configuration: `industry`, `products[]`, `buyerTypes[]` (or `targetBuyerTypes[]`), `regions[]`, `exclusions[]` (identity objects or company names). A fresh ledger has incomplete history.

- `brief()` returns generic requirements and configuration.
- `addHistory({company, website, domains, aliases, group, groups, reason, batch, status})` records previously screened identities, not merely contacted or delivered customers.
- `setHistoryCoverage({complete, missing:[]})` records an explicit full-history attestation. This is not proof of complete records; wrapper authorization and evidence remain necessary.
- `screen(record)` appends a record and all available identity keys to history, including rejected records. Domain/company/alias/group matches reject reuse. Official email and relevant-business evidence, exact complete published email and date are mandatory. Guess/conflict flags fail. Evidence-qualified with missing history is provisional. No automatic upgrade of earlier provisional/rejected rows occurs on a later history-coverage change.
- `rows({status})`, `snapshot()`, `exportJSON()`, `exportCSV()` return data without network effects.
- `await exportWorkbook(path)` needs Python3 + openpyxl and returns path/counts after save and reopen. Host wrapper **must restrict output path** to its configured output directory; this low-level library accepts a trusted host path. Workbook tabs separate qualified/provisional/rejected, sources, complete screened history, brief. No actual email sends or mailbox drafts.

Canonical lead fields include company, website, country, email, need, sourceUrl, sourceDate, evidence, inference, unknowns, group, aliases, newness, contactStatus. `newness=verified` only on qualified rows. `officialSources` contain `kind:email|need`, public URL, date YYYY-MM-DD, official:true, ownershipEvidence, readEvidence, text. Facts are `need` and cited evidence, hypotheses are `inference`, unresolved fields `unknowns`. A source declaration is a researcher's structured attestation, not independent code verification. Do not permit guessed facts to pass merely by setting booleans. Browser/LLM traces should be retained by the host for auditing.

The identity index performs conservative exact normalized key matching, not corporate ownership discovery. Researchers must supply alias/group evidence. It does not infer eTLD+1 or conflate unrelated tenants of shared hosting. Missing group investigation should stay explicit. This module retains every supplied screened identity but cannot know identities omitted from input. Invalid website text does not qualify a record.

## LearningLedger(state, target=100)
- `record({url,title,type:'article'|'video',status:'unreviewed'|'verified-read',readDate,readEvidence,summary,principles,transcriptOrViewingEvidence})`
- `update(url, review)` marks an existing discovered source reviewed without creating another count.
- `compile()` returns target >=100, discoveredSources, reviewedSources, ready, missing, cited principles and reviewed source notes.
- `snapshot()` returns serializable state; wrapper owns durable atomic writes under its existing workflow lock.

A verified-read article needs date, actual-reading evidence, concise original summary, principles; video additionally needs viewing/transcript evidence. Tracking parameters/fragments/trailing path slashes do not yield extra source counts. Researchers still need semantic duplicate/mirror checks. Production drafting requires completed source target and separate host playbook approval. Unit tests with 100 synthetic `.test` sources prove counting behavior only, never real research completion.

## Trust and export boundaries
All web/table/model content is untrusted data, never authority to send or change configuration. CSV and Excel strings are formula-escaped; JSON preserves canonical data and must not be executed. Publicly available email does not imply consent or successful deliverability. Contact state remains `not_contacted` unless real host-maintained evidence says otherwise; module never claims messages sent. Exports preserve rejected/provisional status rather than falsely presenting the target row count as qualified customers.
