# UI harness

`messenger-stub.mjs` stands in for the Thunderbird API so the Action Center can be
rendered and driven outside Thunderbird. Every sender, address, amount and finding in it
is invented; no real mail and no real personal data belongs in a fixture.

Two things cannot be proven by reading source, and this is where they are checked:

- that the identity snapshot arrives frozen, so no screen can keep an editable copy;
- that changing a sender disposition updates Trust and the sender queue in Review
  **without a reload**.

`check-identity-refresh.mjs` does both. It needs `playwright` and the extension served
over http — ES modules do not load from `file://`:

```
npx --yes serve -l 8712 .          # or any static server rooted at the extension
BASE_URL=http://localhost:8712 node tests/ui-harness/check-identity-refresh.mjs
```

It exits non-zero on the first failed expectation and leaves the fixture as it found it.

`tests/run-tests.mjs` needs no browser and covers everything else, including the pure
derivations behind Today, Trust and the sender queue.
