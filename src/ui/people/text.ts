export const ASSIGN = "Assign";

export const UNKNOWN_INITIALS = "?";

export const ASSIGNEES = "Assignees";

export const UNASSIGNED = "Unassigned";

export const ASSIGN_MORE = "Assign…";

export const ADD_PEOPLE_IN_SETTINGS = "Add people in Settings…";

export const moreText = (n: number): string => `+${n}`;

export const assigneesLabel = (names: readonly string[]): string => `Assignees: ${names.join(", ")}`;

export const assignToLabel = (name: string): string => `Assign to ${name}`;

export const unassignLabel = (name: string): string => `Unassign ${name}`;

export const PEOPLE = "People";

export const PEOPLE_HEAD: readonly string[] = ["", "", "Name", "Initials", "Items", ""];

export const PEOPLE_EMPTY = "No people yet. Add someone to assign tasks and milestones.";

export const PEOPLE_FOOT = "Order here is the order of avatars on cards. Up to 8 people per item.";

export const ADD_PERSON = "+ Add person";

export const ADD_PERSON_ROW = "Add person";

export const PEOPLE_LIST_FOOT = "Tap Edit to reorder or remove people.";

export const PEOPLE_EDIT_FOOT = "Drag a handle to reorder, tap the red minus to remove. Tap Done when finished.";

export const PERSON_TITLE = "Person";

export const PERSON_GONE = "This person is no longer in this plan.";

export const NEW_PERSON_PLACEHOLDER = "Name";

export const NEW_PERSON_LABEL = "Name of the new person";

export const REMOVE_ROW = "Remove…";

export const REMOVE_PERSON = "Remove person";

export const REMOVE = "Remove";

export const GIVE_TO_GROUP = "Give the items to";

export const sameNameText = (name: string): string => `More than one person is named “${name}”. Rename one.`;

export const personReorderLabel = (name: string): string => `Reorder ${name}`;

export const personColourLabel = (name: string): string => `Colour of ${name}`;

export const personNameLabel = (name: string): string => `Name of ${name}`;

export const personInitialsLabel = (name: string): string => `Initials of ${name}`;

export const removePersonLabel = (name: string): string => `Remove ${name}`;

export const removeEmptyText = (name: string): string => `Remove “${name}” from this plan? No item is assigned to them.`;

export const removeHeldText = (name: string, n: number): string => `“${name}” is assigned to ${n === 1 ? "1 item" : `${n} items`}. Give them to…`;

export const trashedOfThem = (n: number): string => `${n} of them ${n === 1 ? "is" : "are"} in the Trash.`;

export const THIS_IS_ME = "This is me";

export const MINE_UNTIL = "Mine shows nothing until you choose again.";

export const meGoneText = (name: string | null): string =>
  name === null ? `The person chosen as you is not in this plan’s people. ${MINE_UNTIL}` : `“${name}” was removed from this plan’s people. ${MINE_UNTIL}`;

export const MINE_NEEDS_ME = "Mine needs “This is me”. Choose who you are in Settings › General.";

export const CHOOSE_ME = "Choose…";

export const mineTitle = (name: string): string => `Open items assigned to ${name} (This is me)`;
