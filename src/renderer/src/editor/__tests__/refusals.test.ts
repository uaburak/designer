import { describe, expect, it } from "vitest";
import { TR } from "../../../../shared/i18n/tr";
import { refusalEnglish, refusalMessage } from "../refusals";

describe("refusals (round 17 B)", () => {
  it("the plugin API throws Figma's wording; the toast's English has its Turkish", () => {
    expect(refusalEnglish("variant_property_needs_set")).toBe("Can only add variant property to a component set");
    expect(refusalEnglish("variant_value_invalid")).toBe("Invalid component variant prop value");
    expect(refusalMessage("variant_value_invalid")).toBe("Variant property value cannot be empty or have '=' or ','");
    expect(refusalEnglish("no_such_key")).toBe("no_such_key");
    for (const key of [
      "components_cant_contain_instances_of_themselves",
      "reparent_component_cycle",
      "reparent_component_set_cycle",
      "property_name_empty",
      "property_name_has_equals_or_comma",
      "variant_value_invalid",
      "property_default_empty",
      "property_value_incompatible",
      "instance_swap_default_not_component",
      "instance_swap_default_cycle",
      "invalid_preferred_value",
      "property_reference_cycle",
      "variant_default_locked",
      "slot_default_locked",
      "variant_property_needs_set",
    ])
      expect(TR[refusalMessage(key)], key).toBeTruthy();
  });
});
