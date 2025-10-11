import { AttributesModel } from "./attributes";
import { CombatModel } from "./combat";
import { SkillsModel } from "./skills";

export class StandardWNGActorModel extends BaseWarhammerActorModel {

    static singletonItemPaths = {"species" : "species", "faction" : "faction", "archetype" : "archetype"};
        
    async _preCreate(data, options, user) 
    {
        await super._preCreate(data, options, user);
        this.parent.updateSource({
            "prototypeToken.bar1": { "attribute": "combat.wounds" },
            "prototypeToken.bar2": { "attribute": "combat.shock" },
            "prototypeToken.displayName": CONST.TOKEN_DISPLAY_MODES.OWNER_HOVER,
            "prototypeToken.displayBars": CONST.TOKEN_DISPLAY_MODES.OWNER_HOVER,
            "prototypeToken.disposition": CONST.TOKEN_DISPOSITIONS.NEUTRAL,
            "prototypeToken.name": data.name,
        })
    }
    

    static defineSchema() {
        return {
            attributes: new foundry.data.fields.EmbeddedDataField(AttributesModel),
            skills : new foundry.data.fields.EmbeddedDataField(SkillsModel),
            combat : new foundry.data.fields.EmbeddedDataField(CombatModel),

            species : new foundry.data.fields.EmbeddedDataField(SingletonItemModel),
            faction : new foundry.data.fields.EmbeddedDataField(SingletonItemModel),
            archetype : new foundry.data.fields.EmbeddedDataField(SingletonItemModel),

            settings : new foundry.data.fields.SchemaField({
                generateMetaCurrencies : new foundry.data.fields.BooleanField({initial : true}),
                autoCalc : new foundry.data.fields.SchemaField({
                    defence : new foundry.data.fields.BooleanField({initial: true}),
                    resilience : new foundry.data.fields.BooleanField({initial: true}),
                    shock : new foundry.data.fields.BooleanField({initial: true}),
                    awareness : new foundry.data.fields.BooleanField({initial: true}),
                    resolve : new foundry.data.fields.BooleanField({initial: true}),
                    determination : new foundry.data.fields.BooleanField({initial: true}),
                    wounds : new foundry.data.fields.BooleanField({initial: true}),
                    conviction : new foundry.data.fields.BooleanField({initial: true}),
                })
            })
        }
    }

    async _preUpdate(data, options, user)
    {
        await super._preUpdate(data, options, user);
        if (foundry.utils.hasProperty(options, "changed.system.combat.wounds.value"))
        {
            options.deltaWounds = data.system.combat.wounds.value - this.combat.wounds.value;
            if (data.system.combat.wounds.value > this.combat.wounds.max)
            {
                data.system.combat.wounds.value = this.combat.wounds.max;
            }
        }
        if (foundry.utils.hasProperty(options, "changed.system.combat.shock.value"))
        {
            options.deltaShock = data.system.combat.shock.value - this.combat.shock.value;
            if (data.system.combat.shock.value > this.combat.shock.max)
            {
                data.system.combat.shock.value = this.combat.shock.max;
            }
        }
    }

    async _onUpdate(data, options, user)
    {
        super._onUpdate(data, options, user)
        if (user == game.user.id)
        {
            if (this.combat.wounds.value > 0)
            {
                this.parent.addCondition("wounded")
            }
            else if (this.parent.hasCondition("wounded"))
            {
                this.parent.removeCondition("wounded");
            }
        }
    }

    computeDerived() {
        this.attributes.compute();
        this.skills.compute(this.attributes);
        this.combat.compute(this.attributes, this.settings.autoCalc);
    }

    
    _addModelProperties()
    {
        this.species.relative = this.parent.items
        this.faction.relative = this.parent.items
        this.archetype.relative = this.parent.items
    }
}
