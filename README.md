# Wrath & Glory — Zipper Initiative

> Alternate-activation initiative for Wrath & Glory combats inside Foundry VTT.

## At a Glance
- **Current release:** 0.9.0
- **Foundry VTT:** v11 – v13 (verified on v13)
- **Wrath & Glory system:** v6+

The module replaces the default combat order with true zipper-style initiative: the acting
side alternates between PCs and NPCs each activation, while still respecting Wrath & Glory's
round structure and GM authority. A floating "zipper" tracker keeps the table informed about
priority, eligible combatants, and who has already acted.

---

## Features
- 🔁 **Strict alternating turns** that honor a configurable round priority (PCs or NPCs).
- 👥 **Player-facing activation controls** that let the party decide who goes next when
  multiple PCs are available (with full GM override and fallback to native initiative).
- 🪟 **Resizable docked tracker** rendered with Handlebars inspired by the combat carousel
  UX while highlighting current, pending, and completed combatants.
- 🧭 **Queued activations** for both sides so the GM (or eligible players) can line up the
  next combatant without immediately advancing the turn.
- ⚙️ **Quality-of-life automation** that hides defeated or hidden combatants and gracefully
  hands control back to Foundry when the zipper is toggled off.
- 🧩 **Macro & module API** helpers for inspecting zipper state, advancing combatants, and
  integrating with other automations.

---

## Requirements
- Foundry VTT core version 11–13.
- Wrath & Glory game system version 6 or newer.
- A world with at least one active combat encounter (the tracker appears once combat starts).

---

## Installation
1. Open **Add-on Modules → Install Module** inside Foundry.
2. Paste the manifest URL: `https://raw.githubusercontent.com/acemb-rso/wng-zipper/main/module.json`
3. Enable **Wrath & Glory — Zipper Initiative** in your world's Module Settings.
4. Reload the world so the dock UI and settings register.

---

## Using the Zipper Tracker
1. Start a combat encounter and open the **Combat Tracker**.
2. Click **Zipper: ON/OFF** to toggle alternate activation for the active combat.
3. Use the **Priority** control to choose which side (PCs or NPCs) leads the next round.
4. When several PCs are available, the module prompts the players (or GM) to select who acts.
5. Queue specific combatants in advance with the dock controls; clear the queue anytime to
   fall back to the natural alternating order.
6. When a round ends, all acted markers reset and the priority side begins the next cycle.

The GM can always override the current combatant, advance rounds manually, or disable the
module mid-combat—`wng-zipper` respects those decisions and resynchronizes automatically.

---

## Configuration
The following settings are available under **Configure Settings → Module Settings → Wrath & Glory — Zipper Initiative**:

| Setting | Scope | Default | Summary |
| --- | --- | --- | --- |
| `enabledByDefault` | World | `true` | Start new combats with zipper initiative enabled automatically. |
| `playersCanAdvance` | World | `true` | Allow players who own a combatant to queue or advance their side. |
| `dockAnchor` | Client | `right` | Pin the tracker to the left or right edge of the window. |
| `dockTopOffset` | Client | `120` | Distance (px) from the top of the viewport before the dock begins. |
| `dockSideOffset` | Client | `16` | Horizontal offset (px) from the anchored edge. |
| `dockWidth` | Client | `320` | Base width (px) of the tracker dock. |
| `dockMaxHeightBuffer` | Client | `160` | Pixels reserved from viewport height to cap dock height. |
| `dockInactiveOpacity` | Client | `0.7` | Dock opacity when zipper initiative is disabled. |
| `dockNoCombatOpacity` | Client | `0.85` | Dock opacity when no combat is active. |
| `dockBackgroundOpacity` | Client | `0.35` | Background opacity of the dock panel. |

All client settings can be customized per user. The tracker enforces reasonable min/max
sizes and supports drag-resizing when pinned.

---

## API & Macros
Developers can import helpers from `game.modules.get('wng-zipper-initiative')?.api` to
inspect current zipper state, programmatically queue combatants, or advance turns in sync with
the module's alternating logic. See the `scripts/wng-zipper.js` source for the full surface
area and examples of the available methods.

---

## Support & License
- Issues & feedback: <https://github.com/acemb-rso/wng-zipper/issues>
- Changelog: `CHANGELOG.md`
- License: [MIT](LICENSE)

Created by **Ariel Cember** with collaboration from GPT-5. Inspired by
[Caewok’s Zipper Initiative](https://github.com/caewok/fvtt-zipper-initiative)
and [Death-Save’s Combat Carousel](https://github.com/death-save/combat-carousel).
