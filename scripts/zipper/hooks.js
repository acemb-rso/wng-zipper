import { MODULE_ID, PLAYERS_SIDE } from "./constants.js";
import { clearQueuedChoice, persistQueuedChoices, registerSocketBridge } from "./queue.js";
import {
  computeNextZipperCombatant,
  ensurePlayersLead,
  maybePromptForNextPcQueue,
  promptRoundAdvanceOrEnd,
  queuePromptBypass
} from "./combat.js";
import { requestDockRender } from "./dock.js";
import { toSideLabel } from "./permissions.js";
import { log } from "./utils.js";

function registerHeaderButtonHook() {
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
        const next = !now;
        await combat.setFlag(MODULE_ID, "enabled", next);
        if (next) {
          await ensurePlayersLead(combat, { resetActed: true, resetCurrentSide: true });
        }
        app.render();
      }
    });
  });
}

function registerCombatLifecycleHooks() {
  Hooks.on("createCombat", async (combat) => {
    try {
      if (!game.user?.isGM) return;
      const auto = game.settings.get(MODULE_ID, "enabledByDefault");
      await combat.setFlag(MODULE_ID, "enabled", !!auto);
      await combat.setFlag(MODULE_ID, "actedIds", []);
      await combat.unsetFlag(MODULE_ID, "currentSide");
      try {
        await combat.setFlag(MODULE_ID, "startingSide", PLAYERS_SIDE);
      } catch (err) {
        log(err);
      }
      await ensurePlayersLead(combat);
    } catch (e) { log(e); }
  });

  Hooks.on("combatStart", async (combat) => {
    try {
      if (!combat?.getFlag(MODULE_ID, "enabled")) return;
      if (!game.user?.isGM) return;
      const step = await computeNextZipperCombatant(combat, { forceStartOfRound: true });
      if (!step || step.type !== "activate" || !step.combatant) return;

      if (step.queueChanged && step.queue) {
        await persistQueuedChoices(combat, step.queue);
      }

      try {
        await combat.setFlag(MODULE_ID, "currentSide", step.side);
      } catch (err) {
        log(err);
      }

      if (step.message) {
        await ChatMessage.create({
          content: step.message,
          whisper: ChatMessage.getWhisperRecipients("GM")
        });
      }

      if (typeof combat.setTurn === "function") {
        await combat.setTurn(step.combatant.id);
        return;
      }

      const idx = combat.turns.findIndex(t => t.id === step.combatant.id);
      if (idx < 0) return;
      await combat.update({ turn: idx });
    } catch (e) { log(e); }
  });

  Hooks.on("updateCombat", async (combat, change) => {
    try {
      if (!combat?.getFlag(MODULE_ID, "enabled")) return;
      if (!game.user?.isGM) return;
      if (typeof change.round === "number") {
        const startingCombat = change?.started === true;
        await combat.setFlag(MODULE_ID, "actedIds", []);
        await ensurePlayersLead(combat, { resetCurrentSide: true });
        await clearQueuedChoice(combat);
        const firstLabel = toSideLabel(PLAYERS_SIDE) ?? "PCs";
        const message = startingCombat
          ? `<strong>Zipper:</strong> Combat started. <em>${firstLabel}</em> act first.`
          : `<strong>Zipper:</strong> New round ready. <em>${firstLabel}</em> choose the next activation.`;
        await ChatMessage.create({
          content: message,
          whisper: ChatMessage.getWhisperRecipients("GM")
        });
      }
    } catch (e) { log(e); }
  });

  Hooks.on("combatTurn", async (combat, turn, options) => {
    try {
      if (!combat?.getFlag(MODULE_ID, "enabled")) return;
      if (!game.user?.isGM) return;
      const prevData = options?.prev ?? combat.previous ?? {};
      const prevId = prevData?.id ?? prevData?.combatantId;
      const prevRound = prevData?.round;
      if (prevId && (prevRound === undefined || prevRound === combat.round)) {
        const acted = new Set(await combat.getFlag(MODULE_ID, "actedIds") ?? []);
        acted.add(prevId);
        await combat.setFlag(MODULE_ID, "actedIds", Array.from(acted));
      }
    } catch (e) { log(e); }
  });
}

function registerCombatWrappers() {
  Hooks.once("ready", async () => {
    const wrap = (klass, method, impl) => {
      const registerWrapperWithLibWrapper = () => {
        if (!globalThis.libWrapper?.register) return false;

        const handler = async function (wrapped, ...args) {
          try {
            return await impl.call(this, wrapped, ...args);
          } catch (err) {
            log(err);
            return await wrapped(...args);
          }
        };

        const target = `CONFIG.Combat.documentClass.prototype.${method}`;
        try {
          const type = globalThis.libWrapper.WRAPPER ?? "WRAPPER";
          globalThis.libWrapper.register(MODULE_ID, target, handler, type);
          return true;
        } catch (err) {
          log(`libWrapper registration failed for ${target}; falling back to direct wrap.`);
          log(err);
          return false;
        }
      };

      if (registerWrapperWithLibWrapper()) return;

      const original = klass?.prototype?.[method];
      if (typeof original !== "function") {
        log(`Unable to wrap Combat.${method}; original method missing.`);
        return;
      }

      klass.prototype[method] = async function (...args) {
        const boundOriginal = original.bind(this);
        try {
          return await impl.call(this, boundOriginal, ...args);
        } catch (err) {
          log(err);
          return await boundOriginal(...args);
        }
      };
    };

    const combatDocumentClass =
      game.getDocumentClass?.("Combat")
      ?? game.combats?.documentClass
      ?? game.documents?.getConstructor?.("Combat")
      ?? CONFIG?.Combat?.documentClass;

    const C = combatDocumentClass;
    if (!C) {
      log("Unable to resolve Combat document constructor; aborting zipper initialization.");
      return;
    }

    wrap(C, "nextTurn", async function (original, ...args) {
      if (!(await this.getFlag(MODULE_ID, "enabled"))) return original(...args);
      const current = this.combatant ?? null;
      if (queuePromptBypass.has(this.id)) {
        queuePromptBypass.delete(this.id);
      } else {
        const outcome = await maybePromptForNextPcQueue(this, { actingCombatant: current });
        if (outcome.cancelled) return this;
      }

      if (current?.id) {
        try {
          const acted = new Set(await this.getFlag(MODULE_ID, "actedIds") ?? []);
          if (!acted.has(current.id)) {
            acted.add(current.id);
            await this.setFlag(MODULE_ID, "actedIds", Array.from(acted));
          }
        } catch (err) {
          log(err);
        }
      }

      const step = await computeNextZipperCombatant(this);
      if (!step) return original(...args);

      if (step.queueChanged && step.queue) {
        await persistQueuedChoices(this, step.queue);
      }

      if (step.type === "advance-round") {
        let decision = { action: "next-round" };
        if (game.user?.isGM) {
          try {
            decision = await promptRoundAdvanceOrEnd(this, step);
          } catch (err) {
            log(err);
            decision = { action: "next-round" };
          }
        }

        if (decision?.action === "end-combat") {
          try {
            if (typeof this.endCombat === "function") {
              await this.endCombat();
            } else {
              await this.update({ active: false });
            }
          } catch (err) {
            log(err);
          }
          return this;
        }

        if (game.user?.isGM && step.message) {
          try {
            await ChatMessage.create({
              content: step.message,
              whisper: ChatMessage.getWhisperRecipients("GM")
            });
          } catch (err) {
            log(err);
          }
        }

        await this.nextRound();
        return this;
      }

      if (step.type !== "activate" || !step.combatant) {
        return original(...args);
      }

      try {
        await this.setFlag(MODULE_ID, "currentSide", step.side);
      } catch (err) {
        log(err);
      }

      if (step.message) {
        try {
          await ChatMessage.create({
            content: step.message,
            whisper: ChatMessage.getWhisperRecipients("GM")
          });
        } catch (err) {
          log(err);
        }
      }

      if (typeof this.setTurn === "function") {
        await this.setTurn(step.combatant.id);
        return this;
      }

      const idx = this.turns.findIndex(t => t.id === step.combatant.id);
      if (idx < 0) return original(...args);
      await this.update({ turn: idx });
      return this;
    });

    wrap(C, "nextRound", async function (original, ...args) {
      if (!(await this.getFlag(MODULE_ID, "enabled"))) return original(...args);
      return original(...args);
    });
  });
}

function registerSocketAvailabilityWarning() {
  Hooks.once("ready", () => {
    if (game.socket) return;
    console.error(`[${MODULE_ID}] Socket system unavailable! Player actions will fail.`);
    if (game.user?.isGM) {
      ui.notifications.error("WNG Zipper: Socket system unavailable. Player actions will not work!");
    }
  });
}

function registerDockHooks() {
  Hooks.on("renderCombatTracker", () => {
    requestDockRender();
  });

  Hooks.once("ready", () => {
    registerSocketBridge();
  });

  Hooks.once("ready", () => {
    requestDockRender();
  });

  const dockRefreshHooks = [
    "createCombat", "deleteCombat", "updateCombat", "combatTurn",
    "createCombatant", "updateCombatant", "deleteCombatant"
  ];

  for (const hook of dockRefreshHooks) {
    Hooks.on(hook, () => requestDockRender());
  }
}

export function registerHooks() {
  registerHeaderButtonHook();
  registerCombatLifecycleHooks();
  registerCombatWrappers();
  registerSocketAvailabilityWarning();
  registerDockHooks();
}
