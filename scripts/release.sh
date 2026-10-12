#!/bin/bash
# Builds a DesignerV2 release that installed copies pick up on their own (docs/desktop.md §12.6):
#
#   npm run release -- 0.2.0 notes.md [--win]
#   scripts/release.sh 0.2.0 notes.md [--win]
#
# It sets the version in package.json, builds, has electron-builder sign the Mac app with Developer ID (hardened
# runtime, build/entitlements.mac.plist), notarize it with Apple and staple the ticket, and make the DMG (first
# installs), the zip (what Squirrel.Mac installs) and latest-mac.yml (the feed). With --win it also builds the NSIS
# installer and latest.yml. Nothing is uploaded: the last lines say how to publish.
#
# Installed copies read latest-mac.yml / latest.yml from the latest release of github.com/uaburak/designer, so the
# files go on a GitHub release tagged v<version>, and that release must be the latest (not a draft or a pre-release).
#
# Once per Mac (the same as Glint's Tools/release.sh):
#   - A "Developer ID Application" certificate for team Q6GDNC3V8B in the login keychain:
#       Xcode › Settings › Accounts › Manage Certificates › +.
#   - Notary credentials, with an app-specific password from account.apple.com:
#       xcrun notarytool store-credentials glint-notary --apple-id <apple id> --team-id Q6GDNC3V8B
#     (another profile name: NOTARY_PROFILE=<name> scripts/release.sh …)
#   - gh signed in: gh auth login
set -euo pipefail

VERSION=""
NOTES=""
WINDOWS=0
for arg in "$@"; do
    case "$arg" in
        --win) WINDOWS=1 ;;
        *) if [[ -z "$VERSION" ]]; then VERSION="$arg"; elif [[ -z "$NOTES" ]]; then NOTES="$arg"; fi ;;
    esac
done
if [[ -z "$VERSION" || ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "usage: scripts/release.sh <version> [notes.md] [--win]   e.g. scripts/release.sh 0.2.0 notes.md" >&2
    exit 64
fi
if [[ -n "$NOTES" && ! -f "$NOTES" ]]; then
    echo "error: no release notes at $NOTES" >&2
    exit 66
fi
[[ -n "$NOTES" ]] && NOTES="$(cd "$(dirname "$NOTES")" && pwd)/$(basename "$NOTES")"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEAM_ID="Q6GDNC3V8B"
REPO="uaburak/designer"
NOTARY_PROFILE="${NOTARY_PROFILE:-glint-notary}"
TAG="v$VERSION"
DIST="$ROOT/dist"
APP="$DIST/mac-arm64/DesignerV2.app"

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

cd "$ROOT"

# Everything that can fail for want of setup is checked before the version changes.
step "Checking the setup"
security find-identity -v -p codesigning | grep -q "Developer ID Application: .*($TEAM_ID)" \
    || die "no \"Developer ID Application: … ($TEAM_ID)\" identity in the keychain (see the top of this script)"
xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 \
    || die "no notary credentials named $NOTARY_PROFILE (see the top of this script)"
gh auth status >/dev/null 2>&1 || die "gh isn't signed in (gh auth login)"
[[ -z "$(git status --porcelain)" ]] || die "the working tree isn't clean: commit or stash first"
CURRENT="$(node -p 'require("./package.json").version')"
[[ "$CURRENT" != "$VERSION" ]] || die "package.json is already at $VERSION"
node -e 'const [a,b]=process.argv.slice(1).map(v=>v.split(".").map(Number));process.exit((a[0]-b[0]||a[1]-b[1]||a[2]-b[2])>0?0:1)' "$VERSION" "$CURRENT" \
    || die "$VERSION isn't newer than $CURRENT (installed copies only take a newer version)"
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then die "$REPO already has a release $TAG"; fi

step "DesignerV2 $VERSION (was $CURRENT)"
# A release that fails part way leaves package.json at the version it had.
BACKUP="$(mktemp -d)"
cp package.json package-lock.json "$BACKUP/"
FINISHED=0
trap '[[ $FINISHED == 1 ]] || { cp "$BACKUP/package.json" "$BACKUP/package-lock.json" "$ROOT/"; echo "Version change undone." >&2; }' EXIT
npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null

step "Building"
rm -rf "$DIST"
npm run build

step "Signing with Developer ID and notarizing (usually a few minutes)"
APPLE_KEYCHAIN_PROFILE="$NOTARY_PROFILE" npx electron-builder --mac --publish never

step "Checking the app"
[[ -d "$APP" ]] || die "no app at $APP"
codesign --verify --deep --strict "$APP" || die "the app's signature doesn't verify"
SIGNING="$(codesign -dvv "$APP" 2>&1)"
grep -q "^Authority=Developer ID Application: .*($TEAM_ID)" <<< "$SIGNING" || die "the app isn't signed with Developer ID"
grep -q "flags=.*runtime" <<< "$SIGNING" || die "the app hasn't the hardened runtime"
ASSESS="$(spctl -a -vv "$APP" 2>&1 || true)"
echo "$ASSESS"
grep -q "source=Notarized Developer ID" <<< "$ASSESS" || die "Gatekeeper doesn't see a notarized app"
xcrun stapler validate "$APP" || die "the app has no stapled notarization ticket"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")" == "$VERSION" ]] \
    || die "the app doesn't carry version $VERSION"

DMG="$DIST/DesignerV2-$VERSION.dmg"
ZIP="$(ls "$DIST"/*"$VERSION"*-mac.zip 2>/dev/null | head -1 || true)"
[[ -f "$DMG" ]] || die "no DMG at $DMG"
[[ -n "$ZIP" && -f "$ZIP" ]] || die "no zip for $VERSION in $DIST"
[[ -f "$DIST/latest-mac.yml" ]] || die "no latest-mac.yml in $DIST"
grep -q "version: $VERSION" "$DIST/latest-mac.yml" || die "latest-mac.yml isn't for $VERSION"
FILES=("$DMG" "$ZIP" "$DIST"/*.blockmap "$DIST/latest-mac.yml")

if [[ $WINDOWS == 1 ]]; then
    step "Building the Windows installer (unsigned)"
    npx electron-builder --win nsis --x64 --publish never
    SETUP="$DIST/DesignerV2-Setup-$VERSION.exe"
    [[ -f "$SETUP" && -f "$DIST/latest.yml" ]] || die "no installer or latest.yml in $DIST"
    FILES=("$DMG" "$ZIP" "$SETUP" "$DIST"/*.blockmap "$DIST/latest-mac.yml" "$DIST/latest.yml")
fi
FINISHED=1

# One line per file, for the gh command
ARGS=""
for f in "${FILES[@]}"; do ARGS+=" \"${f#"$ROOT"/}\""; done

step "Ready"
for f in "${FILES[@]}"; do echo "  ${f#"$ROOT"/}"; done
cat <<EOF

package.json is now at $VERSION; commit and push that before publishing:
  git commit -am "DesignerV2 $VERSION" && git push

Publish: a GitHub release tagged $TAG on $REPO with the files above, marked as the latest.
  gh release create $TAG$ARGS --repo $REPO --title "DesignerV2 $VERSION"${NOTES:+ --notes-file "$NOTES"} --latest

Installed copies see it at their next daily check, or right away with "Check for Updates…".
EOF
