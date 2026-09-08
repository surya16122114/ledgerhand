# Recorded capabilities

The runtime keeps versioned JSON files in this directory. The dashboard groups them by product and advertises the latest version per capability. Historical versions remain available for explicit version replay and evidence references. They are not duplicate callable tools.

## Assignment 2 — MERIDIAN CORE

- **member.find-by-name**: [1.1.1 (latest)](assignment-2/member.find-by-name@1.1.1.json), [1.1.0 (historical)](assignment-2/older-versions/member.find-by-name@1.1.0.json), [1.0.0 (historical)](assignment-2/older-versions/member.find-by-name@1.0.0.json)
- **member.list-shares**: [1.0.0 (latest)](assignment-2/member.list-shares@1.0.0.json)
- **member.open-share**: [1.0.0 (latest)](assignment-2/member.open-share@1.0.0.json)
- **member.place-hold**: [1.1.0 (latest)](assignment-2/member.place-hold@1.1.0.json), [1.0.0 (historical)](assignment-2/older-versions/member.place-hold@1.0.0.json)
- **member.read-record**: [1.0.0 (latest)](assignment-2/member.read-record@1.0.0.json)
- **member.transfer-funds**: [1.0.0 (latest)](assignment-2/member.transfer-funds@1.0.0.json)
- **member.update-contact**: [1.1.0 (latest)](assignment-2/member.update-contact@1.1.0.json), [1.0.0 (historical)](assignment-2/older-versions/member.update-contact@1.0.0.json)
- **session.sign-on**: [1.0.0 (latest)](assignment-2/session.sign-on@1.0.0.json)
## Assignment 1 — Local applications

- **member.open-sub-account**: [1.0.0 (latest)](assignment-1/member.open-sub-account@1.0.0.json)
- **member.read-profile-summary**: [1.0.0 (latest)](assignment-1/member.read-profile-summary@1.0.0.json)
- **member.read-savings-balance**: [1.0.0 (latest)](assignment-1/member.read-savings-balance@1.0.0.json)

Riverstone FCU is a second local CorePoint tenant using the same recording with an overlay; it is not Meridian. See [overlays](../overlays/README.md).

## Physical layout

- `assignment-1/`: current local CorePoint recordings.
- `assignment-2/`: current Meridian recordings.
- Each product's `older-versions/`: superseded versions, retained for explicit version replay.

The loader scans these directories; the catalog still shows one latest version per capability. New default discovery saves into the appropriate product directory. CLI IDs are unchanged. Do not place arbitrary evidence JSON inside the capability library.
