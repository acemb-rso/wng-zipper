# Changelog

All notable changes to **wng-zipper** will be documented in this file. The project adheres loosely to [Semantic Versioning](https://semver.org/) and the dates follow ISO-8601 format (YYYY-MM-DD).

## [0.9.0] - 2025-10-21
### Added
- Optional end-of-turn prompt for PCs that lets the acting player or GM queue the next hero without leaving the tracker flow. 【F:scripts/wng-zipper.js†L855-L874】【F:scripts/wng-zipper.js†L1071-L1120】

### Changed
- Relaxed queue permissions so eligible players can replace the pending PC slot even while their side is acting, and filtered the prompt list to omit hidden or defeated tokens the viewer cannot control. 【F:scripts/wng-zipper.js†L303-L321】【F:scripts/wng-zipper.js†L1075-L1114】
- Queue prompts now fall back to placeholder portraits and reuse sanitized combatant data, keeping the dialog legible for tokens without art. 【F:scripts/wng-zipper.js†L1006-L1040】

### Fixed
- Prevented duplicate queue dialogs when advancing turns from the dock by bypassing prompts that have already been answered. 【F:scripts/wng-zipper.js†L855-L874】
- Guarded pointer capture and release during dock resizing so failed capture calls no longer break drag interactions. 【F:scripts/wng-zipper.js†L1491-L1514】

## [0.7.0] - 2025-10-21
### Added
- Queue controls in the tracker header and combatant cards so GMs (and eligible players) can line up the next PC or NPC before their side is active. 【F:templates/zipper-tracker.hbs†L521-L538】【F:templates/zipper-tracker.hbs†L560-L698】
- GM-mediated socket bridge that relays queue updates, ensuring player requests are executed with sufficient permission. 【F:scripts/wng-zipper.js†L34-L209】

### Changed
- Alternating turn selection now prioritizes queued combatants and respects manual picks before falling back to default order. 【F:scripts/wng-zipper.js†L705-L874】
- Tracker context highlights queued entries, pending activations, and ready/spent groups for both sides. 【F:scripts/wng-zipper.js†L524-L703】

### Fixed
- Clearing or consuming queue slots automatically updates stored flags so stale references to defeated or acted combatants are removed. 【F:scripts/wng-zipper.js†L72-L180】【F:scripts/wng-zipper.js†L744-L822】
- Routed player queue actions through the GM socket to avoid the permission errors that previously blocked non-GM adjustments. 【F:scripts/wng-zipper.js†L148-L209】

## [0.6.0] - 2025-10-21
### Changed
- Bumped the manifest version to 0.3.5 for Foundry distribution with no additional code changes.

## [0.5.2] - 2025-10-21
### Changed
- The tracker dock now fades out of view whenever no combat is running to keep the UI unobtrusive between encounters. 【F:templates/zipper-tracker.hbs†L3-L35】【F:scripts/wng-zipper.js†L1554-L1566】

### Fixed
- Corrected alternating logic so the zipper always flips sides after each activation, even when a round has just reset. 【F:scripts/wng-zipper.js†L826-L882】

## [0.5.0] - 2025-10-21
### Added
- Drag handles and resize controls for the standalone dock, allowing each user to reposition and scale the tracker within configurable limits. 【F:scripts/wng-zipper.js†L1350-L1522】【F:templates/zipper-tracker.hbs†L480-L698】

### Fixed
- Persisted dock size and position across sessions so manual adjustments survive reloads. 【F:scripts/wng-zipper.js†L1350-L1388】

## [0.4.1] - 2025-10-21
### Fixed
- Guarded against Foundry v13 worlds that omit `game.documents` when constructing Combat instances. 【F:scripts/wng-zipper.js†L231-L288】
- Repaired mismatched Handlebars helpers that prevented the tracker template from compiling. 【F:templates/zipper-tracker.hbs†L1-L10】
- Resolved Combat document detection so the module works with both V10 and V11+ constructors. 【F:scripts/wng-zipper.js†L210-L230】

## [0.4.0] - 2025-10-21
### Added
- Revamped dock layout with dedicated activation lanes, status badges, and quick controls for toggling zipper initiative or ending the current turn. 【F:templates/zipper-tracker.hbs†L1-L220】

### Changed
- Switched template rendering to Foundry V13's `foundry.applications.handlebars.renderTemplate`, keeping the dock compatible with the latest core. 【F:scripts/wng-zipper.js†L1558-L1560】

## [0.3.1] - 2025-10-21
### Fixed
- Resolved the tracker template path so installations using custom module folders can still render the standalone dock. 【F:scripts/wng-zipper.js†L1558-L1560】

## [0.3.0] - 2025-10-21
### Added
- Introduced a standalone zipper dock that anchors to the viewport, complete with client settings for anchor side, offsets, width, and opacity. 【F:scripts/wng-zipper.js†L12-L178】【F:scripts/wng-zipper.js†L270-L425】
- Automatic re-rendering hooks refresh the dock whenever combat data changes, keeping the display in sync without opening the combat tracker. 【F:scripts/wng-zipper.js†L442-L520】

### Changed
- Dock controls now dispatch actions (toggle, priority, manual activation) from the floating panel instead of the combat tracker footer. 【F:scripts/wng-zipper.js†L780-L856】

## [0.2.0] - 2024-05-23
### Added
- Handlebars-powered Wrath & Glory combat tracker that mirrors the third-party carousel UX while exposing priority toggles and activation buttons.
- Public API helpers for inspecting zipper state, queuing specific combatants, and integrating with macros.
- Player-facing activation controls that honor Wrath & Glory ownership rules and hide options for defeated or hidden tokens.

### Changed
- Zipper state evaluation now reads Wrath & Glory combat statuses, manual overrides, and alternating flow before advancing turns or rounds.
- `nextTurn` / `nextRound` wrappers delegate to Wrath & Glory's `setTurn` helper and preserve return values so downstream hooks continue to operate.
- Manual override parsing allows the GM to queue any combatant without losing alternating side order or round priority.

### Fixed
- Resets the acted tracker when both sides exhaust their activations to prevent stale state on the next round.
- Ensures chat announcements whisper reset notices to the GM and shows concise side-flip messages to all players.

## [0.1.0] - 2024-04-17
### Added
- Initial release with alternate-activation initiative support for Wrath & Glory combats, including priority selection and round reset handling.
