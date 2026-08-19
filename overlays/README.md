# Tenant overlays

An overlay adapts a capability recorded at one institution to another institution
running the same vendor product. It is authored by a person, reviewed like code,
and applied deterministically by `src/artifact/overlay.ts`.

Attach one with:

```bash
npm run cli -- overlay member.read-savings-balance overlays/corepoint-servicing.riverstone-fcu.json
```

## Why this shape

The thing worth noticing about `corepoint-servicing.riverstone-fcu.json` is how
small it is: four renamed labels and four relocated routes. That is not a
simplification of the example, it is the actual distribution of the problem. When
hundreds of tenants run the same vendor build, what differs between them is
overwhelmingly wording, routing, and locally-mandated extra screens. The *shape* of
the flow -- search, open the record, read the field -- belongs to the vendor, and it
is the same everywhere.

So the reuse unit is `productId`, not `tenantId`. One discovery run produces a
capability for CorePoint Servicing; each institution costs a small diff a human can
read in a minute.

Note what is **not** in this file: Riverstone's mandatory acceptable-use gate. That
is handled by the `terms-acknowledgement-gate` interrupt in the product profile
(`src/artifact/product-profiles.ts`), because more than one institution has one and
the vendor renders them all the same way. An overlay only needs to speak up when a
tenant's wording differs from the product's.

## When an overlay is the wrong answer

If a tenant needs more than aliases and a couple of `stepPatches`, that is a signal
worth listening to rather than working around: the builds have genuinely diverged,
and re-recording against that tenant is the honest response. `effectiveCapability`
refuses to run a capability against a tenant with no overlay unless you pass
`--allow-unadapted`, so this is a decision someone makes rather than a default.
