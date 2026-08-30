# Retina Extension Distribution Contract

`extension-distribution.json` is the UI-agnostic loading contract shipped in
each newly published Retina browser extension artifact. Contract version 1 is
generated during the build, validated before publication, and included in the
artifact SHA-256 inventory.

## Current supported path

The current release stage is `preview`, and the supported channel is
`manual_unpacked`. A user loads the immutable artifact directory through the
browser's extensions page. Silent installation is not supported. Retina does not
currently have a published Chrome Web Store listing, an Edge Add-ons listing, or
a signed enterprise-policy artifact, so those channels are machine-readably
unavailable and contain no fabricated URL.

This is the complete onboarding flow:

1. Open `chrome://extensions/` or `edge://extensions/`.
2. Enable Developer mode.
3. Select **Load unpacked**.
4. Select the immutable versioned artifact root containing `manifest.json`.
5. Verify extension ID `lefpojfbfejboofinaodnoadplihdbhm`.

The native host lifecycle remains independent: installing the native host does
not and cannot load the unpacked extension into a regular browser profile.

## Version 1 schema

The top-level fields are:

- `contractVersion`: integer `1`.
- `extensionId`: fixed ID `lefpojfbfejboofinaodnoadplihdbhm`.
- `extensionVersion`: generated from `package.json` and equal to
  `manifest.json.version`.
- `releaseStage`: currently `preview`.
- `currentChannel`: currently `manual_unpacked`.
- `artifactPathContract`: `immutable_versioned_directory`; onboarding selects
  the artifact root itself.
- `silentInstallSupported`: `false`.
- `requiresUserInteraction`: `true`.
- `browsers`: ordered Chrome and Edge setup records with exact `setupUrl` and
  `loadAction` values.
- `channels`: availability for `manualUnpacked`, `chromeWebStore`,
  `edgeAddons`, and `enterprisePolicy`.
- `onboardingActions`: ordered action records for a UI or terminal client.
- `statusContract`: stable states and their machine-readable next action.

The stable states and next actions are:

| State | Next action |
| --- | --- |
| `not_loaded` | `load_unpacked` |
| `loaded` | `none` |
| `disabled` | `enable_extension` |
| `version_mismatch` | `reload_extension` |
| `artifact_missing` | `locate_extension_artifact` |

Consumers may display their own wording, but must use the action code and the
browser-specific `setupUrl` rather than scraping prose. Additive fields may be
introduced without changing `contractVersion`; changing an existing field's
meaning, state, action, or loading semantics requires a new contract version.

## Artifact and promotion rules

New publication requires `extension-distribution.json`. The publisher validates
its ID, version, supported browsers, channel claims, onboarding order, and status
map before staging the artifact. `extension-artifact-manifest.json` points to it
with `distribution_contract` and inventories its exact SHA-256 hash.

Published version directories are immutable. Re-publishing identical bytes is
idempotent; changed bytes at an existing version are rejected. A distribution
contract change therefore requires a new extension version and a new artifact
directory. Already-promoted artifacts that predate this contract remain
verifiable but are not modified in place.

When a real store listing or enterprise deployment asset exists, publish a new
version whose contract contains the actual URL or policy artifact and changes
the corresponding availability flags. Do not mark those channels available
before the external asset exists and has been acceptance-tested.
