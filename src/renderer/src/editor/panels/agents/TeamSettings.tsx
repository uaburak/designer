/**
 * Agent settings › Team (docs/studio.md §9 [ours]): the members with one job each — the list (on / off, Edit, Reset to
 * default, Remove) and a member's page: Name, Role (what the manager picks by), Instructions, its agent and model (or
 * general work's), the Skills it always works with and the tools it may use. Wecra's default members are edited as the
 * owner's copy, as default Skills are. No editor or engine import (Home's Settings › Agents shows these too).
 */
import { useState, type ReactNode } from "react";
import { Badge, Button, Checkbox, Icon, MenuButton, Select, Switch, TextInput, showToast } from "@/ds";
import { TEAM_LIMITS, TOOL_GROUPS, cleanMember, defaultMember, memberIdFor, resetMember, withMember, withoutMember, type TeamEntry, type TeamMember } from "@shared/agents/team";
import type { AgentSetupHost } from "../../agents/setup";
import { RouteFields, useImageRoutes } from "./ManagerSettings";
import { imageRouteOptions, routeOfOption } from "../../agents/imageRoutes";
import { useSkills } from "./aiData";
import { Block, Field, Group, Row, SettingsGroup, SettingsRow, errorText } from "./settingsParts";
import styles from "./Agents.module.css";
import { t, useT } from "@/i18n";

/** A member's name and role as shown: a default as Wecra ships it reads in the UI's language. */
export const memberName = (m: Pick<TeamEntry, "name" | "origin">) => (m.origin === "default" ? t(m.name) : m.name);
export const memberRole = (m: Pick<TeamEntry, "role" | "origin">) => (m.origin === "default" ? t(m.role) : m.role);

const fail = (err: unknown) => showToast({ message: errorText(err), kind: "error" });

/** The member saved (a default becomes the owner's copy). */
const saveMember = (service: AgentSetupHost, m: TeamMember) => service.setTeam(withMember(service.teamSettings(), m));

/** The Team page: one row per member. */
export function TeamSection({ service }: { service: AgentSetupHost }) {
  useT();
  const team = service.team();
  return (
    <SettingsGroup note={t("Agents with one job each. The manager gives every task to the member whose role fits it; type @ and a member's name in a message to ask one directly.")} data-settings-box="team">
      {!team.length && <p className={styles.mEmpty}>{t("No team members yet.")}</p>}
      {team.map((m) => (
        <SettingsRow
          key={m.id}
          title={memberName(m)}
          badge={m.origin === "override" && <Badge className={styles.rowBadge}>{t("Edited")}</Badge>}
          desc={`@${m.id} · ${memberRole(m)}`}
          dim={!m.enabled}
          onClick={() => service.openSetting(`member:${m.id}`)}
          chevron={false}
          data-member={m.id}
          data-member-origin={m.origin || undefined}
        >
          <MenuButton
            label={t("More")}
            tooltip
            className={styles.barButton}
            align="end"
            entries={[{ id: "edit", label: t("Edit") }, ...(m.origin === "override" ? [{ id: "reset", label: t("Reset to default") }] : []), { id: "remove", label: t("Remove") }]}
            onSelect={(id) => {
              if (id === "edit") service.openSetting(`member:${m.id}`);
              else if (id === "reset") void service.setTeam(resetMember(service.teamSettings(), m.id)).catch(fail);
              else if (id === "remove") void service.setTeam(withoutMember(service.teamSettings(), m.id)).catch(fail);
            }}
          >
            <Icon name="24.more" />
          </MenuButton>
          <Switch label={memberName(m)} checked={m.enabled} onChange={(on) => void saveMember(service, { ...m, enabled: on }).catch(fail)} data-member-switch={m.id} />
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}

/** Settings › Agents' list (Home): the team as rows, and Add. */
export function TeamGroup({ service }: { service: AgentSetupHost }) {
  useT();
  return (
    <Group title={t("Team")}>
      {service.team().map((m) => (
        <Row key={m.id} icon="24.person" label={memberName(m)} status={m.enabled ? t("On") : t("Off")} on={m.enabled} dim={!m.enabled} onClick={() => service.openSetting(`member:${m.id}`)} data-member={m.id} />
      ))}
      <Row icon="24.plus" label={t("New team member")} onClick={() => service.openSetting("add-member")} data-settings-row="add-member" />
    </Group>
  );
}

/** A member's pages for settingsPageOf: "member:<id>" and "add-member". */
export function teamSettingsPage(kind: string, id: string, service: AgentSetupHost): { title: string; body: ReactNode } | null {
  if (kind === "add-member") return { title: t("New team member"), body: <MemberEditor key="new" service={service} /> };
  if (kind !== "member") return null;
  const m = service.team().find((x) => x.id === id);
  if (!m) return { title: t("Team member"), body: <p className={styles.pageText}>{t("This member isn’t in the team any more.")}</p> };
  return { title: memberName(m), body: <MemberEditor key={`${m.id}:${m.origin ?? ""}`} service={service} member={m} /> };
}

const GENERAL = "";

/** The member's pictures: the manager's image model, or one of its own (the Post Designer: Antigravity by default). */
function ImageField({ draft, onChange }: { draft: TeamMember; onChange: (image: TeamMember["image"]) => void }) {
  useT();
  const { options, disabled } = imageRouteOptions(useImageRoutes());
  const value = draft.image ? `${draft.image.providerId}|${draft.image.model ?? ""}` : GENERAL;
  const entries = [{ value: GENERAL, label: t("Same as the manager’s") }, ...options.map((o) => ({ value: o.id, label: o.label, disabled: disabled.includes(o.id) }))];
  if (draft.image && !options.some((o) => o.id === value)) entries.push({ value, label: draft.image.model ?? draft.image.providerId, disabled: false });
  return (
    <Block title={t("Pictures")}>
      <Field label={t("Image model")}>
        <Select label={t("Image model")} className={styles.fieldSelect} value={value} options={entries} onChange={(v) => onChange(v === GENERAL ? null : routeOfOption(v))} data-member-image="" />
      </Field>
      <p className={styles.pageText}>{t("The pictures of the posts this member makes come from this model.")}</p>
    </Block>
  );
}

function MemberEditor({ service, member }: { service: AgentSetupHost; member?: TeamEntry }) {
  useT();
  const shipped = member?.origin === "default";
  const [draft, setDraft] = useState<TeamMember>(() =>
    member
      ? { ...member, name: memberName(member), role: memberRole(member), skills: [...member.skills], tools: member.tools ? [...member.tools] : null }
      : { id: "", name: "", role: "", instructions: "", route: null, skills: [], tools: null, enabled: true },
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { list: skills } = useSkills();
  const providers = service.get().providers;
  const general = service.managerSettings().general;
  const patch = (p: Partial<TeamMember>) => setDraft((d) => ({ ...d, ...p }));
  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    try {
      await job();
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      if (!draft.name.trim()) return setProblem(t("Give the member a name."));
      if (!draft.role.trim()) return setProblem(t("Say in one line what this member does: the manager picks by it."));
      const id = member?.id ?? memberIdFor(draft.name, service.team().map((m) => m.id));
      // A default left as shipped in a field keeps Wecra's English (the manager reads it).
      const d = member && shipped ? defaultMember(member.id) : undefined;
      const clean = cleanMember({ ...draft, id, name: d && draft.name === t(d.name) ? d.name : draft.name, role: d && draft.role === t(d.role) ? d.role : draft.role });
      if (!clean) return setProblem(t("Give the member a name."));
      await saveMember(service, clean);
      setProblem(null);
      showToast({ message: member ? t("Team member saved") : t("{name} joined the team — type @{id} in a message to ask it directly", { name: clean.name, id: clean.id }) });
      service.openSetting(`member:${clean.id}`);
    });
  // Skills to pick from: the enabled ones, and any the member already has.
  const offered = skills.filter((s) => s.enabled || draft.skills.includes(s.name));
  const routeValue = draft.route ? draft.route.providerId : GENERAL;
  const agents = [{ value: GENERAL, label: t("Same as general work") }, ...providers.map((p) => ({ value: p.id, label: p.label, disabled: !p.available }))];
  return (
    <div className={styles.pageBody} data-member-editor={member?.id ?? "new"}>
      {member?.origin && (
        <Block data-member-origin={member.origin}>
          <p className={styles.pageText}>
            {member.origin === "default"
              ? t("A default team member that comes with Wecra. Your changes are saved as your own copy; Reset to default brings back Wecra’s version.")
              : t("You changed this default team member. Reset to default brings back Wecra’s version.")}
          </p>
        </Block>
      )}
      <Block title={t("Member")}>
        <TextInput label={t("Name")} placeholder={t("Story Designer")} value={draft.name} maxLength={TEAM_LIMITS.name} onChange={(v) => patch({ name: v })} data-member-name="" />
        {member && <p className={styles.pageText}>{t("In a message: @{id}", { id: member.id })}</p>}
        <TextInput label={t("Role")} placeholder={t("What this member does, in one line")} value={draft.role} maxLength={TEAM_LIMITS.role} onChange={(v) => patch({ role: v })} data-member-role="" />
        <textarea
          className={styles.textArea}
          aria-label={t("Instructions")}
          placeholder={t("How this member works: its rules, its style, what it never does")}
          value={draft.instructions}
          rows={7}
          maxLength={TEAM_LIMITS.instructions}
          onChange={(e) => patch({ instructions: e.target.value })}
          onKeyDown={(e) => e.stopPropagation()}
          data-member-instructions=""
        />
      </Block>
      <Block title={t("Agent")}>
        <Field label={t("Agent")}>
          <Select label={t("Agent")} className={styles.fieldSelect} value={routeValue} options={agents} onChange={(v) => patch({ route: v === GENERAL ? null : { providerId: v } })} data-member-agent="" />
        </Field>
        {draft.route ? (
          <RouteFields label={t("Agent")} route={draft.route} providers={providers} withEffort onChange={(route) => patch({ route })} />
        ) : (
          <p className={styles.pageText}>{t("Runs on general work’s agent ({agent}).", { agent: providers.find((p) => p.id === general.providerId)?.label ?? general.providerId })}</p>
        )}
      </Block>
      <ImageField draft={draft} onChange={(image) => patch({ image })} />
      <Block title={t("Skills")}>
        <p className={styles.pageText}>{t("Their instructions go with every task this member runs.")}</p>
        {!offered.length && <p className={styles.mEmpty}>{t("No skills yet.")}</p>}
        {offered.map((s) => (
          <div key={s.id} className={styles.mCheck}>
            <Checkbox
              label={`/${s.name}`}
              checked={draft.skills.includes(s.name)}
              disabled={!draft.skills.includes(s.name) && draft.skills.length >= TEAM_LIMITS.skills}
              onChange={(on) => patch({ skills: on ? [...draft.skills, s.name] : draft.skills.filter((x) => x !== s.name) })}
              data-member-skill={s.name}
            />
          </div>
        ))}
      </Block>
      <Block title={t("Tools")}>
        <div className={styles.mCheck}>
          <Checkbox label={t("Every tool")} checked={!draft.tools} onChange={(on) => patch({ tools: on ? null : TOOL_GROUPS.map((g) => g.id) })} data-member-all-tools="" />
        </div>
        {draft.tools &&
          TOOL_GROUPS.map((g) => (
            <div key={g.id} className={styles.mCheck}>
              <Checkbox label={t(g.label)} checked={draft.tools!.includes(g.id)} onChange={(on) => patch({ tools: on ? [...draft.tools!, g.id] : draft.tools!.filter((x) => x !== g.id) })} data-member-tools={g.id} />
            </div>
          ))}
        <p className={styles.pageText}>{t("Reading the file is always allowed. A member without a tool says what is needed instead of doing it.")}</p>
      </Block>
      {problem && <div className={styles.attachProblem} role="alert">{problem}</div>}
      <div className={styles.actions}>
        <Button variant="primary" disabled={busy} onClick={() => void save()} data-member-save="">
          {member ? t("Save") : t("Add to team")}
        </Button>
        {member?.origin === "override" && (
          <Button variant="secondary" disabled={busy} onClick={() => void run(async () => {
            await service.setTeam(resetMember(service.teamSettings(), member.id));
            showToast({ message: t("Team member reset to default") });
          })} data-member-reset="">
            {t("Reset to default")}
          </Button>
        )}
        {member && (
          <Button variant="secondary" disabled={busy} onClick={() => void run(async () => {
            await service.setTeam(withoutMember(service.teamSettings(), member.id));
            service.openSetting("section:team");
          })} data-member-remove="">
            {t("Remove")}
          </Button>
        )}
      </div>
    </div>
  );
}
