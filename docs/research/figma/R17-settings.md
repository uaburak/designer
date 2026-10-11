# R17 — Figma Settings

Figma's Settings modal, researched 2026-10-11 for the Settings round. Read-only (WebSearch/WebFetch, no sign-in). help.figma.com pages are thin on exact dialog wording; anything not on a page is marked **unverified** (needs a first-hand screenshot).

Sources: H1 = https://help.figma.com/hc/en-us/articles/1500006061462 (View and manage account settings);
H2 = https://help.figma.com/hc/en-us/articles/8085703771159 (personal access tokens);
H3 = https://help.figma.com/hc/en-us/articles/15021280611607 (How do I keep my account secure);
H4 = https://help.figma.com/hc/en-us/articles/360039826814 (Delete your Figma account);
H5 = https://help.figma.com/hc/en-us/articles/29638316371479 (See viewer history for your files);
D1 = https://developers.figma.com/docs/rest-api/personal-access-tokens/ ; D2 = https://developers.figma.com/docs/rest-api/scopes/ ;
H6 = https://help.figma.com/hc/en-us/articles/6956360971415 (language); H7 = https://help.figma.com/hc/en-us/articles/4402390110743 (closed captions);
H8 = https://help.figma.com/hc/en-us/articles/360038510833 (Create a Community profile).

## 1. Where Settings lives
- File browser: click your avatar/name top-left -> account menu -> **"Settings"** opens the settings modal (H1, H2, H4). Tabs named in H1: **"Account"**, **"Community"**, **"Notifications"**; H2/H3/D1 also name a **"Security"** tab.
- A "Community profile" dropdown also sits in the account menu (H8).
- Rest of the account menu item list (Add account / Log out / theme etc.): **unverified**.
- Editor main menu > Help and account > "Account settings", and the Preferences item: **unverified** (only "Menu -> Preferences -> Accessibility settings" seen in a forum post, https://forum.figma.com/report-a-problem-6/figma-ui-borders-contrast-issue-48709).

## 2. Account tab
- Name: "Change name" under Name; enter the new name, "Save" (via search summary of https://help.figma.com/hc/en-us/articles/360041034433). Dialog title/buttons otherwise **unverified**.
- Profile photo Edit / upload / remove wording: **unverified**.
- Email: "Change email" underneath the email address, then "Save" (helpjuice mirror of "Manage email address or password", via search). Google SSO accounts: email and password shown as "Managed by Google"; cannot be changed in Figma, only in the Google account (same source; forum https://forum.figma.com/ask-the-community-7/how-to-change-my-figma-account-email-47805). Workaround: reset password to leave SSO, then Change email. Dialog text: **unverified**.
- Org members see org name, seat and account types, with an upgrade request next to the seat type (H1). "Your spaces" and "Learn what products are included in each seat.": **unverified** (strings not found). Seat types for context: Full, Dev, Collab, View (https://www.figma.com/pricing-faq/).
- Role / Change role dialog and role list: **unverified**.
- Language: section "Language", button "Change language", pick a language, "Save"; current tab refreshes, other tabs need manual refresh (helpjuice change-your-language-preference, via search; H6). Supported per H6: English, Spanish, Japanese, Brazilian Portuguese, Korean. Another Figma page lists French, German, Spanish (Spain and Latin America), Portuguese (Brazil) too (https://help.figma.com/hc/en-us/articles/4404356228119). Final list and dialog wording: **unverified**.
- Theme: light, dark, or follow system settings; device-specific (helpjuice change-themes-in-figma, via search). Exact labels in Settings: **unverified**.
- Enhance contrast: Figma's accessibility option is "Enhanced contrast" (Menu > Preferences > Accessibility settings); increases contrast between text/controls and backgrounds in light and dark. Settings-modal label "Enhance contrast" and its description string: **unverified**.
- Closed captions: desktop-app-only, for audio conversations; toggle "Closed captioning"; per-device (H7). The "New features > Closed captions (Beta)" row: **unverified**.
- "Your uploaded fonts" / Upload font: **unverified**. Context: only .ttf and .otf supported; upload-to-Figma is Organization/Enterprise only (https://help.figma.com/hc/articles/360039956774). Personal-upload string, size limit, .ttc: **unverified**.
- Library: H1 lists "Choose which libraries are enabled for files in your drafts"; the button "Enable libraries for all files in your drafts" and its dialog: **unverified**.
- View history: Account > "View history" > "Change preference"; option **"Off"** stops you being recorded as a viewer; applies to all teams/orgs (H5). Other options and dialog text: **unverified**.
- Delete account: Account tab, scroll to the "Account" section at the bottom, button **"Delete account"**, then "follow the on-screen prompts" (H4). Permanent, cannot be reversed, you can no longer log in. Effects (H4): paid Professional subscription must be cancelled first (not auto-cancelled); invoices inaccessible; owned teams may be deleted/reassigned/ownerless; owned folders/files may become ownerless but stay accessible to others; drafts may become inaccessible on Starter, move to an admin-only folder on Professional/Organization/Enterprise; org admin must remove you from an org. Confirmation dialog title/text/buttons: **unverified**.

## 3. Community tab
- Tasks (H1): register a handle to create a Community profile; add and remove profile connections; manage the Community profile primary email; manage Community notifications; delete Community profile.
- Button "Claim your handle"; handle max 15 chars, alphanumeric plus underscore, changeable (H8).
- Profile page fields (https://help.figma.com/hc/en-us/articles/4404108672663, via search): Bio (up to 160 chars), Location, Websites, social links X (formerly Twitter) and Instagram, cover artwork (pencil icon), profile picture (min 500 x 500 px, separate from the account photo). Whether these live in the modal, toggles, save wording: **unverified**.

## 4. Security tab
- Sections named: "Personal access tokens", "Connect apps" (H2, H3). Password / 2FA: H3 only links "Reset your password" and "Enable two-factor authentication (2FA)"; what shows for Google-SSO accounts: **unverified**.
- Sessions: no help article; a forum answer says active sessions are under Settings > Security (https://forum.figma.com/ask%2Dthe%2Dcommunity%2D7/deleting%2Dlogging%2Dout%2Dof%2Dfigma%2Dfrom%2Da%2Dremote%2Dcomputer%2D20402). Intro sentence, columns, Sign out / Current, sign-out-all: **unverified**.
- Personal access tokens: **"Generate new token"** (D1, H2) opens a configuration modal; set a name (H2), expiration and scopes (D1); confirm button **"Generate token"** (D1). "The token only displays immediately after being generated." (H2) — copy it; if you leave, generate a new one. Existing tokens: hover the name to see scopes; last-used date shown (search summary of H2). Revoke: select the token, click **"Revoke access"**, instant (H2). Dialog title, expiration option list (non-expiring tokens removed May 2025; third parties say max 90 days), scope labels and access levels (No access / Read-only / Write): **unverified**.
- REST scopes (D2; the dialog presumably lists these): current_user:read, file_comments:read/write, file_content:read, file_dev_resources:read/write, file_metadata:read, file_variables:read/write (Enterprise), file_versions:read, files:read (deprecated), folders:read, folder_metadata:read, library_analytics:read, library_assets:read, library_content:read, projects:read / project_metadata:read (deprecated), selections:read, team_library_content:read, webhooks:read/write, org:* admin scopes. Example description: current_user:read "Read your name, email, and profile image".
- Connected apps: section "Connect apps"; review the list; click **"Revoke access"** (H3). Intro sentence: **unverified**.
