let fields = foundry.data.fields;

export class DamageModel extends foundry.abstract.DataModel
{
    static LOCALIZATION_PREFIXES = ["WH.Components.damage"];

    static defineSchema() 
    {
        let schema = {};
        schema.enabled = new fields.BooleanField({initial: false});
        schema.attribute = new fields.StringField({initial : "strength"})
        schema.base = new fields.NumberField({initial: 0, nullable: false});
        schema.bonus = new fields.NumberField({initial: 0, nullable: false});
        schema.dice = new fields.StringField();
        schema.rank = new fields.NumberField({initial : 0, choices : {0 : "RANK.NONE", 1 : "RANK.SINGLE", 2: "RANK.DOUBLE"}});

        schema.ed = new fields.SchemaField({
            base: new fields.NumberField({initial: 0, nullable: false}),
            bonus: new fields.NumberField({initial: 0, nullable: false}),
            dice : new fields.StringField(),
            rank: new fields.NumberField({initial : 0, choices : {0 : "RANK.NONE", 1 : "RANK.SINGLE", 2: "RANK.DOUBLE"}})
        })
        
        schema.ap = new fields.SchemaField({
            base: new fields.NumberField({initial: 0, nullable: false}),
            bonus: new fields.NumberField({initial: 0, nullable: false}),
            dice : new fields.StringField(),
            rank: new fields.NumberField({initial : 0, choices : {0 : "RANK.NONE", 1 : "RANK.SINGLE", 2: "RANK.DOUBLE"}})
        })
        
        schema.otherDamage = new fields.SchemaField({
            mortal : new fields.StringField({initial : "0"}),
            wounds : new fields.StringField({initial : "0"}),
            shock : new fields.StringField({initial : "0"})
        })
        return schema;
    }

    get formatted() {
        let damage = Roll.safeEval(this._dataWithRank("damage"));
        if (this.parent.isMelee && this.parent.parent.isOwned)
            damage += this.parent.parent.actor?.system.attributes?.[this.attribute]?.total || 0

        damage += (this.parent.parent.actor?.system.advances?.rank || 0) * this.rank;

        return damage
    }
    get ED() {
        return this._dataWithRank("ed");
    }
    get AP() {
        return this._dataWithRank("ap");
    }

    _dataWithRank(type) {
        let data = type != "damage" ? this[type] : this;
        let damage = data.base + data.bonus;
        if (data.dice)
        {
            damage = damage ? damage + ` + ${data.dice}` : data.dice
        }

        return `${damage}`;
    }
}