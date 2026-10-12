/**
 * electron-builder's `mac.sign` (docs/desktop.md §12.4): its own signing with one change — codesign gets the Developer
 * ID certificate's SHA-1, not its name. electron-builder hands codesign the name ("Developer ID Application: Bilal koç
 * (Q6GDNC3V8B)"), and codesign can't match a name with a non-ASCII letter ("no identity found"). The hash is looked up
 * by team, so a renewed certificate needs no change here.
 */
import { execFileSync } from "node:child_process";
import osxSign from "@electron/osx-sign";

const TEAM_ID = "Q6GDNC3V8B";

function developerIdHash() {
  const out = execFileSync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
  const line = out.split("\n").find((l) => l.includes('"Developer ID Application: ') && l.includes(`(${TEAM_ID})"`));
  const hash = line && /\b([0-9A-F]{40})\b/.exec(line)?.[1];
  if (!hash) throw new Error(`No "Developer ID Application: … (${TEAM_ID})" identity in the keychain`);
  return hash;
}

export default async function sign(opts) {
  await osxSign.signAsync({ ...opts, identity: developerIdHash(), identityValidation: false });
}
