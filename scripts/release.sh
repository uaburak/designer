#!/bin/bash
# Builds a Wecra release and publishes it on get.wecra.app, where installed copies pick it up on their own
# (docs/desktop.md §12.6, docs/site.md):
#
#   npm run release -- 0.2.0 notes.md [--win] [--dry-run] [--upload-only]
#   scripts/release.sh 0.2.0 notes.md [--win] [--dry-run] [--upload-only]
#
# It sets the version in package.json, builds, has electron-builder sign the Mac app with Developer ID (hardened
# runtime, build/entitlements.mac.plist), notarize it with Apple and staple the ticket, and make the DMG (first
# installs), the zip (what Squirrel.Mac installs) and latest-mac.yml (the feed). With --win it also builds the NSIS
# installer and latest.yml.
#
# Then it uploads them to the R2 bucket wecra-releases (updates/<file>; the installers, zips and blockmaps first, the
# yml feeds last, so a feed never names a file that isn't there yet) and puts this release at the top of
# releases.json (version, date, the notes' Markdown, the DMG's and the installer's names and sizes; the site's
# Download buttons and changelog read it). Installed copies read get.wecra.app/updates (electron-builder.yml `publish`).
#
#   --dry-run      builds and checks as usual, then prints every upload and the new releases.json instead of doing
#                  them; package.json goes back to its version
#   --upload-only  skips the build: uploads the files already in dist/ for <version> (a release whose upload failed)
#   MIRROR_GITHUB=1 (the default): also prints the `gh release create` for github.com/uaburak/designer — copies up to
#                  1.1.2 read the GitHub releases, so the first release on R2 must be there too (docs/site.md §4).
#                  MIRROR_GITHUB=0 once they have all updated (then the repository may go private).
#
# Once per Mac (the same as Glint's Tools/release.sh):
#   - A "Developer ID Application" certificate for team Q6GDNC3V8B in the login keychain:
#       Xcode › Settings › Accounts › Manage Certificates › +.
#   - Notary credentials, with an app-specific password from account.apple.com:
#       xcrun notarytool store-credentials glint-notary --apple-id <apple id> --team-id Q6GDNC3V8B
#     (another profile name: NOTARY_PROFILE=<name> scripts/release.sh …)
#   - The site's tools and wrangler signed in to Cloudflare: npm --prefix site install; npx --prefix site wrangler login
#   - While MIRROR_GITHUB=1: gh signed in (gh auth login)
set -euo pipefail

VERSION=""
NOTES=""
WINDOWS=0
DRY_RUN=0
UPLOAD_ONLY=0
for arg in "$@"; do
    case "$arg" in
        --win) WINDOWS=1 ;;
        --dry-run) DRY_RUN=1 ;;
        --upload-only) UPLOAD_ONLY=1 ;;
        -*) echo "error: unknown option $arg" >&2; exit 64 ;;
        *) if [[ -z "$VERSION" ]]; then VERSION="$arg"; elif [[ -z "$NOTES" ]]; then NOTES="$arg"; fi ;;
    esac
done
if [[ -z "$VERSION" || ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "usage: scripts/release.sh <version> [notes.md] [--win] [--dry-run] [--upload-only]   e.g. scripts/release.sh 0.2.0 notes.md" >&2
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
MIRROR_GITHUB="${MIRROR_GITHUB:-1}"
TAG="v$VERSION"
DIST="$ROOT/dist"
APP="$DIST/mac-arm64/Wecra.app"
# The R2 bucket (site/wrangler.jsonc) and the Cloudflare account it is in
BUCKET="wecra-releases"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-dd8b9e757657d35f82adff075509b048}"
# wrangler's own limit for `r2 object put`
MAX_UPLOAD=$((300 * 1024 * 1024))

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
wrangler() { npx --prefix "$ROOT/site" wrangler "$@"; }
size_of() { stat -f %z "$1" 2>/dev/null || stat -c %s "$1"; }
content_type() {
    case "$1" in
        *.yml) echo "text/yaml; charset=utf-8" ;;
        *.json) echo "application/json; charset=utf-8" ;;
        *.dmg) echo "application/x-apple-diskimage" ;;
        *.zip) echo "application/zip" ;;
        *.exe) echo "application/vnd.microsoft.portable-executable" ;;
        *) echo "application/octet-stream" ;;
    esac
}

cd "$ROOT"

# Everything that can fail for want of setup is checked before the version changes.
step "Checking the setup"
if [[ $UPLOAD_ONLY == 0 ]]; then
    security find-identity -v -p codesigning | grep -q "Developer ID Application: .*($TEAM_ID)" \
        || die "no \"Developer ID Application: … ($TEAM_ID)\" identity in the keychain (see the top of this script)"
    xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 \
        || die "no notary credentials named $NOTARY_PROFILE (see the top of this script)"
    [[ -z "$(git status --porcelain)" ]] || die "the working tree isn't clean: commit or stash first"
    CURRENT="$(node -p 'require("./package.json").version')"
    [[ "$CURRENT" != "$VERSION" ]] || die "package.json is already at $VERSION"
    node -e 'const [a,b]=process.argv.slice(1).map(v=>v.split(".").map(Number));process.exit((a[0]-b[0]||a[1]-b[1]||a[2]-b[2])>0?0:1)' "$VERSION" "$CURRENT" \
        || die "$VERSION isn't newer than $CURRENT (installed copies only take a newer version)"
fi
[[ -x "$ROOT/site/node_modules/.bin/wrangler" ]] || die "the site's tools aren't installed (npm --prefix site install)"
if [[ $DRY_RUN == 0 ]]; then
    wrangler whoami >/dev/null 2>&1 || die "wrangler isn't signed in to Cloudflare (npx --prefix site wrangler login)"
fi
if [[ "$MIRROR_GITHUB" == 1 ]]; then
    gh auth status >/dev/null 2>&1 || die "gh isn't signed in (gh auth login), or MIRROR_GITHUB=0"
    if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then die "$REPO already has a release $TAG"; fi
fi

if [[ $UPLOAD_ONLY == 0 ]]; then
    step "Wecra $VERSION (was $CURRENT)"
    # A release that fails part way (or a dry run) leaves package.json at the version it had.
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
    grep -q "url: https://get.wecra.app/updates" "$APP/Contents/Resources/app-update.yml" \
        || die "the app's app-update.yml doesn't point at get.wecra.app/updates"

    if [[ $WINDOWS == 1 ]]; then
        step "Building the Windows installer (unsigned)"
        npx electron-builder --win nsis --x64 --publish never
    fi
fi

step "The files"
DMG="$DIST/Wecra-$VERSION.dmg"
ZIP="$(ls "$DIST"/Wecra-"$VERSION"-*-mac.zip 2>/dev/null | head -1 || true)"
[[ -f "$DMG" ]] || die "no DMG at $DMG"
[[ -n "$ZIP" && -f "$ZIP" ]] || die "no zip for $VERSION in $DIST"
[[ -f "$DIST/latest-mac.yml" ]] || die "no latest-mac.yml in $DIST"
grep -q "version: $VERSION" "$DIST/latest-mac.yml" || die "latest-mac.yml isn't for $VERSION"
BINARIES=("$DMG" "$ZIP")
FEEDS=("$DIST/latest-mac.yml")
SETUP=""
if [[ $WINDOWS == 1 ]]; then
    SETUP="$DIST/Wecra-Setup-$VERSION.exe"
    [[ -f "$SETUP" && -f "$DIST/latest.yml" ]] || die "no installer or latest.yml in $DIST"
    grep -q "version: $VERSION" "$DIST/latest.yml" || die "latest.yml isn't for $VERSION"
    BINARIES+=("$SETUP")
    FEEDS+=("$DIST/latest.yml")
fi
BLOCKMAPS=()
for f in "$DIST"/*"$VERSION"*.blockmap; do [[ -f "$f" ]] && BLOCKMAPS+=("$f"); done
# Binaries and blockmaps first, the feeds last
FILES=("${BINARIES[@]}" ${BLOCKMAPS[@]+"${BLOCKMAPS[@]}"} "${FEEDS[@]}")
for f in "${FILES[@]}"; do
    (( $(size_of "$f") <= MAX_UPLOAD )) || die "${f#"$ROOT"/} is over wrangler's 300 MiB upload limit"
    printf '  %-48s %s\n' "${f#"$ROOT"/}" "$(size_of "$f") bytes"
done
[[ $UPLOAD_ONLY == 1 ]] || FINISHED=$((1 - DRY_RUN))

# This release at the top of releases.json (docs/site.md §3); one with the same version is replaced (a re-run)
RELEASES="$(mktemp -d)"
NEXT="$RELEASES/releases.json"
make_releases() {
    node -e '
const fs = require("fs");
const [current, out, version, date, notesFile, macName, macSize, winName, winSize] = process.argv.slice(1);
let list = [];
try { const data = JSON.parse(fs.readFileSync(current, "utf8") || "{}"); if (Array.isArray(data.releases)) list = data.releases; }
catch (e) { console.error("releases.json doesn’t parse: " + e.message); process.exit(1); }
const files = { mac: { name: macName, size: Number(macSize) } };
if (winName) files.windows = { name: winName, size: Number(winSize) };
const notes = notesFile ? fs.readFileSync(notesFile, "utf8").trim() : "";
const releases = [{ version, date, notes, files }, ...list.filter((r) => r && r.version !== version)];
// Only the newest KEEP releases keep their files (the newest, and the one before it for a download already under way
// or a step back); older entries stay for the changelog without files, and their versions are listed for deletion
const KEEP = 2;
const prune = [];
releases.forEach((r, i) => { if (i >= KEEP && r.files) { prune.push(r.version); delete r.files; } });
fs.writeFileSync(out, JSON.stringify({ releases }, null, 2) + "\n");
fs.writeFileSync(out + ".prune", prune.join("\n"));
' "$1" "$NEXT" "$VERSION" "$(date +%Y-%m-%d)" "$NOTES" \
        "$(basename "$DMG")" "$(size_of "$DMG")" \
        "${SETUP:+$(basename "$SETUP")}" "${SETUP:+$(size_of "$SETUP")}"
}

put() {
    local key="$1" file="$2"
    local cmd=(wrangler r2 object put "$BUCKET/$key" --file "$file" --content-type "$(content_type "$key")" --remote)
    if [[ $DRY_RUN == 1 ]]; then
        echo "  [dry run] npx --prefix site wrangler r2 object put $BUCKET/$key --file ${file#"$ROOT"/} --content-type \"$(content_type "$key")\" --remote"
    else
        echo "  $key"
        "${cmd[@]}" >/dev/null || die "the upload of $key failed (re-run with --upload-only to resume)"
    fi
}

step "Uploading to R2 ($BUCKET)"
for f in "${FILES[@]}"; do put "updates/$(basename "$f")" "$f"; done

step "Updating releases.json"
CURRENT_JSON="$RELEASES/current.json"
if [[ $DRY_RUN == 1 ]]; then
    echo "  [dry run] npx --prefix site wrangler r2 object get $BUCKET/releases.json --pipe --remote"
    echo '{"releases":[]}' > "$CURRENT_JSON"
else
    if ! wrangler r2 object get "$BUCKET/releases.json" --pipe --remote > "$CURRENT_JSON" 2> "$RELEASES/get.err"; then
        grep -q "The specified key does not exist" "$RELEASES/get.err" \
            || { cat "$RELEASES/get.err" >&2; die "couldn't read releases.json from $BUCKET"; }
        echo "  (none yet: a new list)"
        echo '{"releases":[]}' > "$CURRENT_JSON"
    fi
fi
make_releases "$CURRENT_JSON" || die "couldn't make the new releases.json"
put "releases.json" "$NEXT"

# Older releases' files leave the bucket (releases.json no longer names them, so no download points at them)
step "Removing older releases' files"
while read -r OLD; do
    [[ -n "$OLD" ]] || continue
    for name in "Wecra-$OLD.dmg" "Wecra-$OLD.dmg.blockmap" "Wecra-$OLD-arm64-mac.zip" "Wecra-$OLD-arm64-mac.zip.blockmap" \
        "Wecra-Setup-$OLD.exe" "Wecra-Setup-$OLD.exe.blockmap"; do
        if [[ $DRY_RUN == 1 ]]; then
            echo "  [dry run] npx --prefix site wrangler r2 object delete $BUCKET/updates/$name --remote"
        else
            # A file that was never uploaded (no Windows build that time) is fine
            wrangler r2 object delete "$BUCKET/updates/$name" --remote >/dev/null 2>&1 && echo "  updates/$name"
        fi
    done
done < "$NEXT.prune"
if [[ $DRY_RUN == 1 ]]; then
    echo "  The new releases.json (on an empty list):"
    sed 's/^/    /' "$NEXT"
fi

# One line per file, for the gh command
ARGS=""
for f in "${FILES[@]}"; do ARGS+=" \"${f#"$ROOT"/}\""; done

step "$([[ $DRY_RUN == 1 ]] && echo "Dry run done: nothing uploaded" || echo "Published on get.wecra.app")"
[[ $UPLOAD_ONLY == 1 || $DRY_RUN == 1 ]] || cat <<EOF
package.json is now at $VERSION; commit and push it:
  git commit -am "Wecra $VERSION" && git push
EOF
if [[ "$MIRROR_GITHUB" == 1 ]]; then
    cat <<EOF

Mirror (MIRROR_GITHUB=1; copies up to 1.1.2 read GitHub): a GitHub release tagged $TAG on $REPO with the files above,
marked as the latest.
  gh release create $TAG$ARGS --repo $REPO --title "Wecra $VERSION"${NOTES:+ --notes-file "$NOTES"} --latest
EOF
fi
cat <<EOF

Installed copies see it at their next daily check, or right away with "Check for Updates…".
EOF
