import { WNGTest } from "./test.js"

export default class WeaponTest extends WNGTest {
  constructor(data = {})
  {
    super(data)
    if (foundry.utils.isEmpty(data))
      return

    this.data.testData.range = data.range
    this.data.testData.aim = data.aim
    this.data.testData.calledShot = data.calledShot

    this.addDamageData(data);

    //this.data.context.edit = mergeObject(this.data.context.edit, {damage : 0, ed : 0, ap : 0})
  }

  get template() {
    return "systems/wrath-and-glory/templates/chat/roll/weapon/weapon-roll.hbs"
  }

  async runPreScripts()
  {
      await super.runPreScripts();
      await Promise.all(this.actor.runScripts("preRollWeaponTest", this));
      await Promise.all(this.item.runScripts("preRollWeaponTest", this));
  }

  async runPostScripts()
  {
      await super.runPostScripts();
      await Promise.all(this.actor.runScripts("rollWeaponTest", this));
      await Promise.all(this.item.runScripts("rollWeaponTest", this));
  }

  async edit({pool=0, wrath=0, icons=0, damage=0, ed=0, ap=0}={})
  {
    this.data.testData.edit.damage += damage;
    this.data.testData.edit.ed += ed;
    this.data.testData.edit.ap += ap;
    await super.edit({pool, wrath, icons})
  }

  _computeResult()
  {
    super._computeResult()

    this.result.range = this.testData.range
    this.result.aim = this.testData.aim
    this.result.calledShot = this.testData.calledShot
    if (this.weapon.system.traits?.has("blast"))
    {
      this.result.blast = this.weapon.system.traits.has("blast").rating;
      if (!this.result.isSuccess)
      {
        this.result.scatter = true;
        this.computeDamage();
      }
    }
  }

  get weapon() {return fromUuidSync(this.testData.itemId)}
  
}

