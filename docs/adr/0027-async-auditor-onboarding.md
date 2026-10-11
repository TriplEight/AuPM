# Auditor onboarding is self-service and asynchronous

Status: accepted (2026-10-11). Applies from the Wave 0 pilot.

An auditor applies with a form: contact email, pseudonym, conflict declaration, a draft
payout-binding statement and the hardware attestation of the signing key (ADR 0022). AuPM checks
the attestation chain to the vendor CA automatically. The admin signs the certifications in a
weekly batch. There is no live call. The auditor then starts on probation (ADR 0025): a small
package, one test review, spot-checked.

A live call does not scale to about 50 auditors in different time zones, and most of what a call
checks is either automatic (the attestation) or a signed declaration (conflicts). A false
declaration is a signed statement, so it carries a reputation penalty and forfeiture.

Later automation of the form is open. Before the contest window closes, the MVP application path
(a GitHub issue form and a manual identity mapping) stays in use.
