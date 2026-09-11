# Historical Review Origins

Use `backfill_review_origins.sql` only when the lab owner explicitly supplies the
historical paths. This is database-owner maintenance, not a member-facing RPC,
scheduled job, classifier, or override of future sidebar selections.

1. Apply `../migrations/202609110002_review_origin_backfill_audit.sql`.
2. Privately resolve each supplied name to one approved profile UUID. Confirm the
   exact stored display name; do not fuzzy-match or infer from a paper's topics.
3. Inspect the count of NULL origins per mapped member and confirm the operation.
4. In the same database session, set `lmi.confirmed_review_origins` to a JSON array
   with `user_id`, `expected_name`, and canonical `topic` fields, then execute the
   maintenance script. Do not commit the real input mapping or query to Git.
5. Check the latest `public.review_origin_backfill_log` row, remaining NULL counts,
   enabled review triggers, and member/administrator access before closing out.

The transaction locks the review table, temporarily suspends only its origin and
timestamp triggers, fills NULL paths, and restores both triggers before releasing
the lock. Other writers may briefly wait; lock acquisition times out after five
seconds. An exact before/after comparison rejects changes to scores, notes, IDs,
timestamps, existing paths, or unmapped reviews. Any error rolls back the operation,
including trigger changes. A retry with no eligible rows does not create a log.

The administrator-only audit retains the owner-confirmed mapping (including
members with no reviews) and the actual changed review keys and paths. It contains
no score or note text. This distinguishes retroactively supplied context from
browser-observed context; it is not evidence that a specific filter was captured
at the original review time. Public completion metadata still exposes paths only,
without names, author IDs, scores, or notes.

Run `pnpm test:coordination` to test preservation, idempotence, mapping validation,
rollback after a trigger failure, private provenance, and anonymous completion.
