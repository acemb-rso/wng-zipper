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

