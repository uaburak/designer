/**
 * The manager's name as the owner sees it (Agent settings › Manager › Name): what it answers as in the chat, its
 * avatar, cursor and "Following <name>" in the file. The default name shows translated; a chosen one as typed.
 */
import { t } from "@/i18n";
import { DEFAULT_MANAGER_NAME, type ManagerSettings } from "@shared/studio/types";

export function managerName(settings: Pick<ManagerSettings, "name"> | null | undefined): string {
  const name = settings?.name?.trim();
  return !name || name === DEFAULT_MANAGER_NAME ? t("Manager") : name;
}

/** A worker of the manager's, as a collaborator: "<name> · 2" (its task's number in the chat). */
export function workerName(manager: string, ordinal: number): string {
  return `${manager} · ${ordinal}`;
}
