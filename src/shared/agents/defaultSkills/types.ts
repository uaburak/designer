/** A skill that ships with Wecra (docs/ai.md §8.6): listed as Default in Agents › Skills, editable as the owner's copy. */
export interface DefaultSkill {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
}
