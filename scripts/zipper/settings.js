import { DOCK_DEFAULTS, MODULE_ID } from "./constants.js";
import { requestDockRender } from "./dock.js";

export function registerSettings() {
  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, "enabledByDefault", {
      name: "Enable by default for new Combats",
      hint: "When true, new combats will start with zipper initiative turned on.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, "playersCanAdvance", {
      name: "Allow players to choose next PC",
      hint: "Allow players to select the next PC when it's their side's activation.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    const clientSettings = [
      ["dockAnchor", {
        name: "Dock Anchor Side",
        hint: "Choose which side of the screen the zipper dock should attach to.",
        scope: "client",
        config: true,
        type: String,
        choices: {
          right: "Right",
          left: "Left"
        },
        default: DOCK_DEFAULTS.anchor
      }],
      ["dockTopOffset", {
        name: "Dock Top Offset (px)",
        hint: "Distance from the top edge of the screen in pixels.",
        scope: "client",
        config: true,
        type: Number,
        default: DOCK_DEFAULTS.topOffset
      }],
      ["dockSideOffset", {
        name: "Dock Side Offset (px)",
        hint: "Horizontal distance from the anchored edge in pixels.",
        scope: "client",
        config: true,
        type: Number,
        default: DOCK_DEFAULTS.sideOffset
      }],
      ["dockWidth", {
        name: "Dock Width (px)",
        hint: "Overall width of the zipper dock in pixels.",
        scope: "client",
        config: true,
        type: Number,
        default: DOCK_DEFAULTS.width
      }],
      ["dockHeight", {
        name: "Dock Height (px)",
        hint: "Fixed height of the zipper dock in pixels. Set to 0 to auto-size to the viewport buffer.",
        scope: "client",
        config: true,
        type: Number,
        default: DOCK_DEFAULTS.height
      }],
      ["dockMaxHeightBuffer", {
        name: "Dock Max Height Buffer (px)",
        hint: "Pixels to subtract from the viewport height when calculating the dock's max height.",
        scope: "client",
        config: true,
        type: Number,
        default: DOCK_DEFAULTS.maxHeightBuffer
      }],
      ["dockInactiveOpacity", {
        name: "Inactive Dock Opacity",
        hint: "Opacity of the dock when zipper initiative is disabled (0–1).",
        scope: "client",
        config: true,
        type: Number,
        range: { min: 0, max: 1, step: 0.05 },
        default: DOCK_DEFAULTS.inactiveOpacity
      }],
      ["dockNoCombatOpacity", {
        name: "No-Combat Dock Opacity",
        hint: "Opacity of the dock when no combat is selected (0–1).",
        scope: "client",
        config: true,
        type: Number,
        range: { min: 0, max: 1, step: 0.05 },
        default: DOCK_DEFAULTS.noCombatOpacity
      }],
      ["dockBackgroundOpacity", {
        name: "Dock Background Opacity",
        hint: "Opacity of the dock panel background (0–1).",
        scope: "client",
        config: true,
        type: Number,
        range: { min: 0, max: 1, step: 0.05 },
        default: DOCK_DEFAULTS.backgroundOpacity
      }]
    ];

    for (const [key, config] of clientSettings) {
      game.settings.register(MODULE_ID, key, {
        ...config,
        onChange: () => requestDockRender()
      });
    }
  });
}
