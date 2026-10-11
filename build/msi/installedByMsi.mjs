// electron-builder's msiProjectCreated hook (electron-builder.yml; docs/desktop.md §12.5): before WiX compiles the MSI's
// project.wxs, add a component writing HKLM\SOFTWARE\DesignerV2\InstalledByMsi = 1 (DWORD) — Figma's MSI installs
// don't update themselves, and a future updater checks this value. electron-builder 26 has no option for it and no
// custom template, so the generated project is edited here.
import { readFile, writeFile } from "node:fs/promises";

const GROUP = '<ComponentGroup Id="ProductComponents" Directory="APPLICATIONFOLDER">';
// A fixed GUID: the component must keep its identity across versions (upgrades in place)
const COMPONENT = `
      <Component Id="InstalledByMsi" Guid="44DC6DF2-A697-48E2-A70C-CECC127B64FA">
        <RegistryValue Root="HKLM" Key="SOFTWARE\\DesignerV2" Name="InstalledByMsi" Type="integer" Value="1" KeyPath="yes"/>
      </Component>`;

export default async function installedByMsi(projectFile) {
  const xml = await readFile(projectFile, "utf8");
  if (!xml.includes(GROUP)) throw new Error(`installedByMsi: ${GROUP} not found in ${projectFile} (electron-builder's MSI template changed)`);
  if (xml.includes('Id="InstalledByMsi"')) return;
  await writeFile(projectFile, xml.replace(GROUP, GROUP + COMPONENT));
}
