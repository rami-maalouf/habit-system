# Declined proposal: automatic handling of offline anchor cycles

**Status: declined by Rami, not implemented.** Rami chose to avoid the additional complexity and expects mostly sequential device use. Do not implement the proposed effective-graph cut, alternate component flattening, explanatory editing UI, or raw-cycle restore exception. Keep the existing rejection of self-links and cyclic anchor graphs. The technical design below is retained only as historical review context, not an implementation task. It consolidates the cycle portion of `.artifacts/t19/compatibility-design/t19-wire-contract.md`; it does not amend the product specification.

Two individually valid offline edits can produce a cycle after whole-row last-writer-wins (LWW) merge. For example, one device saves A after B while another saves B after A. Rejecting whichever row arrives second can leave different graphs on the two devices. Keeping both winning raw rows requires a consistent derived interpretation.

## Recommended option: ignore one stable link in each cycle

Keep every winning raw board row, including its five anchor fields and mutation stamp. For stack computations, derive a separate effective graph from the same snapshot:

1. Validate individual anchor field shapes. Include all undeleted boards, including archived boards, in structural cycle detection. A board-to-board anchor is a directed edge from its owner to its target, for either Before or After.
2. Find each directed cycle involving at least two distinct board IDs. Select the cycle member with the smallest board ID under binary UTF-8 byte ordering. Ignore that member's outgoing anchor link in the effective graph. Its incoming branches remain attached.
3. Represent the ignored link by clearing all five anchor fields in a copied board value, then run the existing stack derivation on those effective values. Keep all other fields unchanged. Return the ignored owner IDs as derived information for presentation.

Board IDs are ASCII UUID strings. Compare their stored bytes exactly, including case; do not use locale ordering or normalize identities. Never select the cut using mutation stamps, titles, order keys, SQL order, or arrival order. Renaming or reordering a habit must not change the chosen root. Use iterative traversal with visited state; cycle detection needs no new dependency or persistent cache.

For A < B < C, consider these raw links:

| Raw link | Effective interpretation |
| --- | --- |
| A after B | Temporarily ignored; A becomes the structural root |
| B after A | Retained |
| C after B | Retained; C remains in the same stack |

The displayed order is A, B, C in this example. Remaining Before/After relations still determine order, so a structural root need not be the first displayed member. Archiving A does not select a new cut; existing activity-period and archived-member rules determine participation.

Received and restored self-links remain invalid: whole-row merge of valid rows cannot manufacture an owner pointing to itself. Inbound validation must reject a self-target regardless of whether its parent identity is present. A read-only projection may defensively ignore an already stored malformed self-link so it does not break display; this grants no authority to admit, restore or resave that link, repair storage, or generate economic evidence.

The ignored link is a consequence of the current raw graph, not a saved repair. If a later explicit anchor edit breaks the cycle, every remaining valid link becomes effective automatically.

## Editing and policy behavior must agree

The board form continues to show the saved anchor sentence. For the ignored owner, explain that its link is temporarily ignored because the saved links form a cycle. Do not display a saved None value or silently replace the anchor when saving a title, color, time, or other unrelated field.

Locally requested self-links and newly created cycles remain invalid. Preserve an unchanged existing non-self parent link on unrelated saves; that exception does not authorize resaving a self-link. When the parent target changes, reject it if following the prospective raw targets reaches the edited board; reaching an already existing multi-board cycle that does not contain the edited board does not create a new cycle. This permits attaching a new incoming member to an existing affected stack. Clearing a link remains available. Changing only Before/After does not create a new parent cycle. Do not validate new links merely by cutting every resulting cycle, which would silently permit new local cycles.

The recommendation must apply consistently beyond display:

| Boundary | Required interpretation |
| --- | --- |
| Stack UI and analytics | Use the effective graph for roots, membership and ordering; retain raw fields for forms and explanations. |
| TypeScript command policy capture | Prepare the effective topology once for the captured board/period snapshot, including prospective in-memory edits. Own check closes still use the member's shift; bonus closes use the effective structural root's shift. |
| TypeScript board-policy planning | Use the same projection for before/after topology, affected components and prospective policy capture. A title or order edit must not switch the cut or manufacture a topology change. |
| Swift Check In / Remove Latest | Use the identical cut and structural membership before private policy capture. Archived roots and exact-date required membership must match TypeScript. No new public native API is needed. |
| Sync and settlement | Merge raw mutable rows, then derive from the resulting snapshot in the existing transaction. Preserve accepted immutable evidence and settle its exact historical scopes through the existing admission rules. The projection itself emits no action, coin row, repair stamp or outbox entry. |
| Version 2 backup / restore | Export all five raw anchor fields. Restore raw links after identities are available, then apply the same projection. Never export effective nulls as the user's saved anchor. |

Current consumers needing coordinated integration are `stack-queries.ts`, `coin-policy-capture.ts`, `coin-policy-emission.ts`, `board-policy-mutations.ts`, local graph validation, and Swift `IntentCoinPolicyCapture.swift`. Updating only the stack screen would leave commands rejecting cycles or capturing a different root. The strict `deriveStacks` implementation can remain the validator of the effective input.

Existing action policies retain their original root, requirements and closes, even when they differ from today's effective graph. Future genuine commands capture the current effective policy and use the existing policy-control protocol. Graph projection never rewrites historical earning evidence or invents retrospective earnings. Any correction from receiving or restoring immutable evidence remains governed by the already approved reconciliation contract.

## Required specification and restore exception

The current specification says that following board anchors must terminate and that cycles are rejected (section 4.2 and success criterion 2). Section 4.12 also requires restoring anchors in two passes and validating the resulting graph; success criterion 8 requires anchor-reference roundtrip. A literal rejection of every raw cycle would reject the app's own exported merged graph. A display-only approval does not resolve that contradiction.

Approval of this recommendation therefore needs to **explicitly permit well-shaped raw cycles involving at least two distinct board IDs received through sync or restored from version 2 backups**, while retaining rejection of received/restored self-links and locally requested new cycles. Restore still validates field shapes, identities and target availability, preserves raw references, and derives an acyclic effective graph. It does not repair raw links or bypass unrelated validation. Identities and final raw links must be installed atomically in two passes; temporary unset links must not escape into reads or policy capture.

An empty-store restore of the same raw boards must produce the same raw anchors and effective cut. A merge restore retains the inherited rule that existing local mutable rows are not replaced by the backup; its resulting graph may therefore differ from the file. This proposal does not grant import LWW semantics, preserve original mutable source stamps, or change immutable IDs and payloads.

A missing parent is not a cycle and must not be fabricated: the existing wire design keeps its whole mutable candidate deferred until the identity exists. For an actually retained tombstoned target, that design preserves the raw link but ignores it only in the effective graph; incoming children keep their links to the owner. Neither case is a cycle cut or a reason to rewrite raw anchors. The separate [period and backup compatibility proposal](period-sync-compatibility-proposal.md) covers the restricted deleted-target identity representation needed for raw anchors to such parents. Approving this cycle policy does not approve that export field, period identities, or a migration. Full backup acceptance remains dependent on those separate decisions.

## Alternative and approval scope

The alternative is to show **every habit in the entire weakly connected component containing a cycle individually**, including incoming branches. Raw links still remain saved. To keep app and native commands consistent, that option would also treat those members as unstacked for future policy capture until an edit resolves the cycle. It avoids choosing a temporary root but removes otherwise usable stack relationships. Existing captured economics remain unchanged under either option. Raw backup preservation and the explicit restore exception are still necessary.

The recommended cut would preserve more of the user's relationships and yield a stable root, at the cost of temporarily ignoring one link the user saved. The historical request covered the exact ID-based cut, its application to future policy capture in TS and Swift, truthful editing, and the sync/version-2-restore exception above. It did not authorize a schema/export-field addition, dependency, public native API, automatic raw repair, or historical action rewrite. Rami declined the proposal; neither option is an implementation task.

Implementation acceptance must pin:

- Two real offline edits merging in both orders, with identical final raw rows, effective roots and links; include multiple multi-board cycles, incoming branches and an unrelated component. Received/restored self-links are rejected separately; defensive display of an already stored malformed self-link grants no admission or write authority.
- Identical results after input permutation, mixed-case ID ordering, title/order/stamp-only changes, restart, and archive/restore of the cut owner. Remaining Before/After ordering stays intact.
- App/native policy parity for archived roots, different member/root shifts, optional or empty required sets, and an unrelated command in a database containing a cycle.
- A form save preserving the ignored raw link, explicit repair restoring the remaining links, a newly requested cycle being rejected, and attaching an incoming member without creating a new cycle.
- Raw version 2 export and two-pass empty-store restore preserving all five fields and immutable evidence; merge restore preserving existing local rows; missing/deleted-target boundaries and cleared-note privacy remaining intact.
- Transaction failure leaving raw rows, visibility, ledger, outbox and caller markers unchanged. Deriving or displaying a cycle alone produces no writes or fresh earnings.
