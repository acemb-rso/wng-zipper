import { StandardItemModel } from "./components/standard";

let fields = foundry.data.fields;

export class AscensionModel extends StandardItemModel
{
    static LOCALIZATION_PREFIXES = ["WH.Models.ascension"];

    static defineSchema() 
    {
        let schema = super.defineSchema();
        schema.cost = new fields.NumberField({min : 0});
        schema.requirements = new fields.StringField({});
        schema.keywords = new fields.StringField({});
        schema.influence = new fields.NumberField({});
        schema.benefits = new fields.HTMLField({});
        return schema;
    }

}