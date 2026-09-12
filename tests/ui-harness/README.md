# UI harness

`messenger-stub.mjs` stands in for the Thunderbird API so the Action Center can be
rendered and driven outside Thunderbird. Every sender, address, amount and finding in it
is invented; no real mail and no real personal data belongs in a fixture.

Three things cannot be proven by reading source:

- that the read-only snapshots arrive **deeply** frozen — a shallow freeze would still let
  a screen edit an entry inside a list or rewrite a provenance, which is exactly the quiet
  local drift the contract exists to prevent;
- that changing a sender disposition updates Trust and Review **without a reload**;
- that every derived screen is complete **on arrival**, rather than filling itself when
  some other screen is visited first.

Three scripts cover them. All need `playwright` and the extension served over http — ES
modules do not load from `file://`:

```
npx --yes serve -l 8712 .          # or any static server rooted at the extension
BASE_URL=http://localhost:8712 node tests/ui-harness/check-identity-refresh.mjs
BASE_URL=http://localhost:8712 node tests/ui-harness/check-snapshot-screens.mjs
BASE_URL=http://localhost:8712 node tests/ui-harness/check-review-commands.mjs
```

`check-identity-refresh.mjs` attacks the freeze at every level in strict mode — outside
strict mode a write to a frozen object fails silently and a shallow freeze looks identical
to a deep one — then blocks a domain from Trust and checks that Trust, the summary and the
sender queue all move with zero navigations, and that clearing it restores the previous
state.

`check-snapshot-screens.mjs` opens each of the eleven surfaces first in its own page, with
nothing else visited, and requires it to be complete with its counter matching its list;
then walks all of them in one page in a **shuffled** order and requires every figure to be
unchanged; then checks that a selected record survives a trip through the other screens.
That is what "fed by snapshots, no duplicate state" looks like from the outside.

`check-review-commands.mjs` drives the only two commands Review issues — rejecting a
reading and acknowledging a rule — and checks the loop closes with zero navigations, that
a rejected reading is kept and names its finding, and that restoring puts it back.

Both exit non-zero on the first failed expectation and leave the fixture as they found it.

`tests/run-tests.mjs` needs no browser and covers everything else, including the pure
derivations behind Today, Dates, Trust and all five Review queues. Dates takes
`now` as an argument, so those cases are deterministic.
