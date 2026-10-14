/**
 * Agent settings › Access › GitHub (docs/agents-reach.md §6.1): the repositories agents may read — added by name
 * (`owner/name`); with none, nothing can be read.
 */
import { useState } from "react";
import { Button, TextInput } from "@/ds";
import { isRepoName, type ReachPatch, type ReachView } from "@shared/agents/reach";
import { Block } from "./settingsParts";
import { ListLine } from "./AccessSettings";
import styles from "./Agents.module.css";
import { t, useT } from "@/i18n";

export function GithubConnection({ view, patch }: { view: ReachView; patch: (p: ReachPatch) => void }) {
  useT();
  const repos = view.settings.github.repos;
  const [name, setName] = useState("");
  const clean = name.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$|\/$/g, "");
  const add = () => {
    if (!isRepoName(clean)) return;
    patch({ repos: [...repos, clean] });
    setName("");
  };
  return (
    <Block title={t("Repositories agents can read")}>
      {!repos.length && <p className={styles.pageText}>{t("No repositories yet: agents can't read any.")}</p>}
      {repos.map((r) => <ListLine key={r} text={r} onRemove={() => patch({ repos: repos.filter((x) => x !== r) })} data-access-repo={r} />)}
      <div className={styles.actions}>
        <TextInput label={t("Repository")} placeholder="owner/name" value={name} onChange={setName} onExit={(r) => r === "enter" && add()} data-access-repo-input="" />
        <Button variant="secondary" disabled={!isRepoName(clean)} onClick={add} data-access-repo-add="">{t("Add")}</Button>
      </div>
    </Block>
  );
}
