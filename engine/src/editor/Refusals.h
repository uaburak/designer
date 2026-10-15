// Refusals in Figma's words (round 17 B, docs/research/rea/components.md §2.19, docs/schema.md §5.10): what a
// component command or a write refused, as a message key. Editor::refuse returns E_INVALID and reports the key twice:
// as a NOTICE event (the editor's toast, Figma's visual bell) and as engine_command's {"error": key} (the plugin API
// throws Figma's message). The English and Turkish texts live in src/renderer/src/editor/refusals.ts; the keys are
// the wire format: append only.
#pragma once

namespace eng::refusal {

// Figma's visual bell `components_can_t_contain_instances_of_themselves`: an instance created, pasted, inserted or
// swapped into a component it (transitively) shows.
inline constexpr const char* kSelfInstance = "components_cant_contain_instances_of_themselves";
// "Cannot move node. Reparenting would create a component cycle" / "… component set cycle".
inline constexpr const char* kReparentCycle = "reparent_component_cycle";
inline constexpr const char* kReparentSetCycle = "reparent_component_set_cycle";
// "Component property definition name cannot be empty".
inline constexpr const char* kPropertyNameEmpty = "property_name_empty";
// "Component property name cannot have '=' or ','" (a Variant property's name).
inline constexpr const char* kVariantNameChars = "property_name_has_equals_or_comma";
// A Variant property's value with '=' or ',' or empty ("Invalid component variant prop value").
inline constexpr const char* kVariantValueInvalid = "variant_value_invalid";
// "Component property default value cannot be empty".
inline constexpr const char* kDefaultEmpty = "property_default_empty";
// "Property value is incompatible with component property type" (Figma's "mismatching type and default value").
inline constexpr const char* kValueIncompatible = "property_value_incompatible";
// "Default value for instance swap must be a symbol".
inline constexpr const char* kSwapDefaultNotComponent = "instance_swap_default_not_component";
// "Default backing symbol ID for instance prop will create cycle".
inline constexpr const char* kSwapDefaultCycle = "instance_swap_default_cycle";
// "Invalid preferred value for component property type".
inline constexpr const char* kPreferredInvalid = "invalid_preferred_value";
// "Attaching component property reference '%s' will create a cycle".
inline constexpr const char* kPropertyRefCycle = "property_reference_cycle";
// "Cannot change defaultValue of a variant property" / "… of a slot component property".
inline constexpr const char* kVariantDefaultLocked = "variant_default_locked";
inline constexpr const char* kSlotDefaultLocked = "slot_default_locked";
// "Can only add variant property to a component set" (the plugin API; the UI makes the component a set).
inline constexpr const char* kVariantNeedsSet = "variant_property_needs_set";

}  // namespace eng::refusal
