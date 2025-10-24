import { MANUAL_CHOICE_FLAG, MODULE_ID, PLAYERS_SIDE } from "./constants.js";
import { ensurePlayersLead, evaluateZipperState } from "./combat.js";

export function registerApi() {
  Hooks.once("ready", () => {
    const api = {
      async enableForActiveCombat(on = true) {
        const c = game.combat; if (!c) return false;
        const next = !!on;
        await c.setFlag(MODULE_ID, "enabled", next);
        if (next) await ensurePlayersLead(c, { resetActed: true, resetCurrentSide: true });
        ui.combat.render(); return true;
      },
      async setPriority(side = "pc") {
        const c = game.combat; if (!c) return false;
        if (side !== PLAYERS_SIDE) {
          ui.notifications?.warn?.("Zipper priority is fixed to PCs and cannot be reassigned.");
        }
        await ensurePlayersLead(c, { resetActed: true, resetCurrentSide: true });
        ui.combat.render(); return true;
      },
      async advanceTo(combatantId) {
        const c = game.combat; if (!c) return false;
        if (!combatantId) return false;
        if (!(await c.getFlag(MODULE_ID, "enabled"))) return false;
        await c.setFlag(MODULE_ID, MANUAL_CHOICE_FLAG, combatantId);
        await c.nextTurn();
        return true;
      },
      async getState(opts = {}) {
        const c = game.combat; if (!c) return null;
        return evaluateZipperState(c, { preview: true, ...(opts || {}) });
      }
    };
    const mod = game.modules.get(MODULE_ID);
    if (mod) mod.api = api;
  });
}
