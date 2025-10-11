/*******************************************************************************************
 * Wrath & Glory — Zipper Initiative for Foundry VTT
 * Author: Ariel Cember + GPT-5
 * Version: 0.2.0
 * 
 * Implements strict alternate-activation (PC↔NPC) initiative with a Priority side each round.
 * When multiple PCs are eligible, players choose who acts next.
 * GM always retains override authority. Falls back to default Foundry initiative if disabled.
 *******************************************************************************************/

const MODULE_ID = "wng-zipper";

/* ---------------------------------------------------------
 * Utility helpers
 * --------------------------------------------------------- */
const log = (...args) => console.log(`[%c${MODULE_ID}%c]`, "color:#2ea043", "color:inherit", ...args);
const isPC = (c) => {
  try {
    if (!c) return false;
    // Prefer actor ownership; fallback to token disposition (FRIENDLY=1)
    if (typeof c.actor?.hasPlayerOwner === "boolean") return c.actor.hasPlayerOwner;
    const disp = c.token?.disposition ?? c.token?.document?.disposition;
    return disp === 1; // FRIENDLY
  } catch {
    return false;
  }
};

/* ---------------------------------------------------------
 * Settings
 * --------------------------------------------------------- */
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
});

/* ---------------------------------------------------------
 * Combat Tracker Header Buttons
 * --------------------------------------------------------- */
Hooks.on("getCombatTrackerHeaderButtons", (app, buttons) => {
  const combat = game.combat;
  const enabled = combat?.getFlag(MODULE_ID, "enabled") ?? false;

  buttons.unshift({
    label: enabled ? "Zipper: ON" : "Zipper: OFF",
    class: enabled ? "zipper-on" : "zipper-off",
    icon: enabled ? "fas fa-exchange-alt" : "far fa-exchange-alt",
    onclick: async () => {
      if (!combat) return ui.notifications.warn("No active combat.");
      const now = !!(combat.getFlag(MODULE_ID, "enabled"));
      await combat.setFlag(MODULE_ID, "enabled", !now);
      if (!now && !(await combat.getFlag(MODULE_ID, "startingSide"))) {
        await chooseStartingSide(combat);
      }
      app.render();
    }
  });

  if (combat?.getFlag(MODULE_ID, "enabled")) {
    buttons.unshift({
      label: `Priority: ${combat.getFlag(MODULE_ID, "startingSide")?.toUpperCase() || "?"}`,
      class: "zipper-priority",
      icon: "fas fa-trophy",
      onclick: () => chooseStartingSide(combat)
    });
  }
});

/* ---------------------------------------------------------
 * Priority chooser
 * --------------------------------------------------------- */
async function chooseStartingSide(combat) {
  return new Promise((resolve) => {
    new Dialog({
      title: "Choose Priority (Starting Side)",
      content: `<p>Which side has Priority this combat? (Wrath & Glory Core Rules)</p>`,
      buttons: {
        pc: {
          label: "PCs First",
          callback: async () => {
            await combat.setFlag(MODULE_ID, "startingSide", "pc");
            await combat.setFlag(MODULE_ID, "currentSide", "pc");
            await combat.setFlag(MODULE_ID, "actedIds", []);
            resolve("pc");
          }
        },
        npc: {
          label: "NPCs First",
          callback: async () => {
            await combat.setFlag(MODULE_ID, "startingSide", "npc");
            await combat.setFlag(MODULE_ID, "currentSide", "npc");
            await combat.setFlag(MODULE_ID, "actedIds", []);
            resolve("npc");
          }
        }
      },
      default: "pc"
    }).render(true);
  });
}

/* ---------------------------------------------------------
 * Initialize per-combat defaults
 * --------------------------------------------------------- */
Hooks.on("createCombat", async (combat) => {
  try {
    const auto = game.settings.get(MODULE_ID, "enabledByDefault");
    await combat.setFlag(MODULE_ID, "enabled", !!auto);
    await combat.setFlag(MODULE_ID, "actedIds", []);
    await combat.setFlag(MODULE_ID, "currentSide", null);
    await combat.setFlag(MODULE_ID, "startingSide", null);
    if (auto) await chooseStartingSide(combat);
  } catch (e) { log(e); }
});

/* ---------------------------------------------------------
 * Reset acted list on new round
 * --------------------------------------------------------- */
Hooks.on("updateCombat", async (combat, change) => {
  try {
    if (!combat?.getFlag(MODULE_ID, "enabled")) return;
    if (typeof change.round === "number") {
      await combat.setFlag(MODULE_ID, "actedIds", []);
      await combat.setFlag(MODULE_ID, "currentSide", await combat.getFlag(MODULE_ID, "startingSide"));
      ChatMessage.create({
        content: `<strong>Zipper:</strong> New round started. Priority resets to <em>${(await combat.getFlag(MODULE_ID, "startingSide"))?.toUpperCase()}</em>.`,
        whisper: ChatMessage.getWhisperRecipients("GM")
      });
    }
  } catch (e) { log(e); }
});

/* ---------------------------------------------------------
 * Track who just acted (turn end)
 * --------------------------------------------------------- */
Hooks.on("combatTurn", async (combat, turn, options) => {
  try {
    if (!combat?.getFlag(MODULE_ID, "enabled")) return;
    const prev = options?.prev ?? (combat.turns?.[combat.turn - 1]);
    const prevId = prev?.id ?? combat?.previous?.combatantId;
    if (prevId) {
      const acted = new Set(await combat.getFlag(MODULE_ID, "actedIds") ?? []);
      acted.add(prevId);
      await combat.setFlag(MODULE_ID, "actedIds", Array.from(acted));
    }
  } catch (e) { log(e); }
});

/* ---------------------------------------------------------
 * Core zipper behavior
 * --------------------------------------------------------- */
Hooks.once("ready", async () => {
  // Wrap Combat.nextTurn / nextRound
  const wrap = (klass, method, impl) => {
    const original = klass.prototype[method];
    klass.prototype[method] = async function (...args) {
      try { return await impl.call(this, original.bind(this), ...args); }
      catch (e) { log(e); return await original(...args); }
    };
  };

  const C = game.documents.getConstructor("Combat");

  wrap(C, "nextTurn", async function (original, ...args) {
    if (!(await this.getFlag(MODULE_ID, "enabled"))) return original(...args);
    const nextCombatant = await computeNextZipperCombatant(this);
    if (!nextCombatant) return original(...args);

    if (typeof this.setTurn === "function") {
      return this.setTurn(nextCombatant.id);
    }

    const idx = this.turns.findIndex(t => t.id === nextCombatant.id);
    if (idx < 0) return original(...args);
    return this.update({ turn: idx });
  });

  wrap(C, "nextRound", async function (original, ...args) {
    if (!(await this.getFlag(MODULE_ID, "enabled"))) return original(...args);

    const outcome = await original(...args);
    const nextCombatant = await computeNextZipperCombatant(this, { forceStartOfRound: true });
    if (!nextCombatant) return outcome;

    if (typeof this.setTurn === "function") {
      await this.setTurn(nextCombatant.id);
      return this;
    }

    const idx = this.turns.findIndex(t => t.id === nextCombatant.id);
    if (idx < 0) return outcome;
    await this.update({ turn: idx });
    return this;
  });
});

/* ---------------------------------------------------------
 * Strict alternation (PC↔NPC)
 * --------------------------------------------------------- */
async function computeNextZipperCombatant(combat, opts = {}) {
  const enabled = await combat.getFlag(MODULE_ID, "enabled");
  if (!enabled) return null;
  const turns = combat.turns || [];
  if (!turns.length) return null;

  const acted = new Set(await combat.getFlag(MODULE_ID, "actedIds") ?? []);
  if (opts.forceStartOfRound) acted.clear();
  let currentSide = await combat.getFlag(MODULE_ID, "currentSide");
  const startingSide = await combat.getFlag(MODULE_ID, "startingSide") ?? "pc";
  if (!currentSide || opts.forceStartOfRound) currentSide = startingSide;

  // Filter candidates
  const aliveAvailOfSide = (side) => turns.filter((c) => {
    const defeated = c.isDefeated ?? c.defeated ?? false;
    if (defeated) return false;
    if (c.hidden && !game.user.isGM) return false;
    return (side === "pc") === isPC(c) && !acted.has(c.id);
  });

  const pcAvail = aliveAvailOfSide("pc");
  const npcAvail = aliveAvailOfSide("npc");

  let nextSide;
  let candidates;

  if (pcAvail.length && npcAvail.length) {
    // Both sides have eligibles → strictly alternate
    nextSide = (currentSide === "pc") ? "npc" : "pc";
    candidates = nextSide === "pc" ? pcAvail : npcAvail;
  } else if (pcAvail.length || npcAvail.length) {
    // One side exhausted → remaining side finishes the round
    nextSide = pcAvail.length ? "pc" : "npc";
    candidates = pcAvail.length ? pcAvail : npcAvail;
  } else {
    // Round over → reset to starting side
    await combat.setFlag(MODULE_ID, "actedIds", []);
    await combat.setFlag(MODULE_ID, "currentSide", startingSide);
    const fresh = aliveAvailOfSide(startingSide);
    if (!fresh.length) return null;
    ChatMessage.create({
      content: `<strong>Zipper:</strong> All combatants acted. New round begins with <em>${startingSide.toUpperCase()}</em>.`,
      whisper: ChatMessage.getWhisperRecipients("GM")
    });
    return fresh[0];
  }

  // Player choice when multiple PCs
  if (nextSide === "pc" && candidates.length > 1) {
    const chosen = await selectPCDialog(candidates);
    if (chosen) {
      await combat.setFlag(MODULE_ID, "currentSide", "pc");
      return chosen;
    }
  }

  // Otherwise pick first available
  const chosen = candidates[0];
  await combat.setFlag(MODULE_ID, "currentSide", isPC(chosen) ? "pc" : "npc");

  // Announce flip
  const newSide = await combat.getFlag(MODULE_ID, "currentSide");
  ChatMessage.create({
    content: `<em>Alternate Activation:</em> <strong>${newSide.toUpperCase()}</strong> act.`,
    speaker: { alias: "Zipper" }
  });

  return chosen;
}

/* ---------------------------------------------------------
 * Dialog for selecting next PC
 * --------------------------------------------------------- */
async function selectPCDialog(candidates) {
  const canPlayers = game.settings.get(MODULE_ID, "playersCanAdvance");
  if (!canPlayers && !game.user.isGM) {
    ui.notifications.warn("Only the GM may choose the next PC.");
    return null;
  }

  const choices = candidates.map(c => `
    <label style="display:flex;align-items:center;gap:6px;margin:4px 0;">
      <input type="radio" name="pcChoice" value="${c.id}">
      <img src="${c.token?.texture?.src || c.img}" width="28" height="28" style="object-fit:cover;border-radius:4px;">
      ${c.name}
    </label>`).join("");

  return new Promise(resolve => {
    new Dialog({
      title: "Choose Next PC",
      content: `<form>${choices}</form>`,
      buttons: {
        ok: {
          label: "Activate",
          callback: (html) => {
            const id = html[0].querySelector('input[name="pcChoice"]:checked')?.value;
            const sel = candidates.find(c => c.id === id) || candidates[0];
            resolve(sel);
          }
        }
      },
      default: "ok",
      close: () => resolve(null)
    }).render(true);
  });
}

/* ---------------------------------------------------------
 * UI quality-of-life
 * --------------------------------------------------------- */
Hooks.on("renderCombatTracker", (app, html) => {
  if (!game.combat) return;
  const enabled = game.combat.getFlag(MODULE_ID, "enabled");
  const hint = $(`<div class="zipper-hint" style="margin:4px 8px;font-size:11px;opacity:.85;">
    Zipper ${enabled ? "<strong>ENABLED</strong>" : "disabled"}. Use header buttons to toggle or set Priority.
  </div>`);
  html.find(".directory-header").append(hint);
});

/* ---------------------------------------------------------
 * Public API
 * --------------------------------------------------------- */
Hooks.once("ready", () => {
  const api = {
    async enableForActiveCombat(on = true) {
      const c = game.combat; if (!c) return false;
      await c.setFlag(MODULE_ID, "enabled", !!on);
      if (on && !(await c.getFlag(MODULE_ID, "startingSide"))) await chooseStartingSide(c);
      ui.combat.render(); return true;
    },
    async setPriority(side = "pc") {
      const c = game.combat; if (!c) return false;
      if (!["pc", "npc"].includes(side)) return false;
      await c.setFlag(MODULE_ID, "startingSide", side);
      await c.setFlag(MODULE_ID, "currentSide", side);
      ui.combat.render(); return true;
    }
  };
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = api;
});

/*******************************************************************************************
 * Macro Example
 *******************************************************************************************
(async () => {
  const mod = game.modules.get("wng-zipper-initiative");
  if (!mod?.active) return ui.notifications.error("wng-zipper-initiative not active.");
  const c = game.combat; if (!c) return ui.notifications.warn("No active combat.");
  const on = !(await c.getFlag("wng-zipper-initiative", "enabled"));
  await mod.api.enableForActiveCombat(on);
  ui.notifications.info(`Zipper ${on ? "ENABLED" : "disabled"}.`);
})();
