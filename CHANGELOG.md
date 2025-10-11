# Changelog

All notable changes to **wng-zipper** will be documented in this file. The project adheres loosely to [Semantic Versioning](https://semver.org/) and the dates follow ISO-8601 format (YYYY-MM-DD).

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
