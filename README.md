# wng-zipper
Automates the alternating initiative from the Wrath and Glory system

# Wrath & Glory — Zipper Initiative

**Version:** 0.3.0  
**Author:** Ariel Cember + GPT-5  
**Foundry Compatibility:** v11–v12 (possibly v13) 
**System:** Wrath & Glory  

---

### Description
Implements **alternate-activation initiative** (“zipper” style) for *Wrath & Glory* inside Foundry VTT.  
Combat alternates between **PCs and NPCs** each activation, honoring a chosen **Priority side** each round.  
When multiple PCs are eligible to act, players may select which one goes next.  
The GM always retains override authority, and the module falls back gracefully to Foundry’s normal initiative when disabled.

---

### Features
- **Strict PC↔NPC interlacing** until one side runs out of eligible combatants.  
- **Priority side** selectable each round (default dialog button).  
- **Player choice dialog** when multiple PCs can act.  
- **GM override & fallback** safety.  
- Compatible with Foundry v11–v12.

---

### Installation
1. In Foundry VTT, open **Add-on Modules → Install Module**.  
2. Paste this manifest URL:
3. Enable *Wrath & Glory — Zipper Initiative* in your world’s module settings.

---

### 🔧 Usage
1. In the Combat Tracker, click **Zipper: ON/OFF** to toggle.  
2. Use the **Priority** button to set who starts the round (PCs or NPCs).  
3. During PC turns, if multiple characters can act, a small dialog lets the group choose who goes next.  
4. When all combatants have acted, the round resets to the chosen Priority side.

---

### ⚙️ Settings
| Setting | Scope | Default | Description |
|----------|--------|----------|-------------|
| **enabledByDefault** | world | true | Start new combats with Zipper enabled |
| **playersCanAdvance** | world | true | Allow players to select the next PC |

---

### 🧪 Compatibility & Limitations
- Tested with Foundry v12.  
- Works with the official *Wrath & Glory* system.  
- Does not modify dice mechanics (e.g., Seize the Initiative, Glory, or Ruin).  
- Hidden or defeated tokens are skipped automatically.

---

### 🪙 Credits & License
Created by **Ariel Cember** with design assistance from GPT-5.  
Inspired by [Caewok’s Zipper Initiative](https://github.com/caewok/fvtt-zipper-initiative)  
and [Death-Save’s Combat Carousel](https://github.com/death-save/combat-carousel).  

Licensed under the **MIT License** (see LICENSE).  

