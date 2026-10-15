export const meta = {
  name: 'rea-batch-b-implementation',
  description: 'Implement Round 17 Batch B (Figma rules, medium items in 4 areas) on worktree branches, each reviewed adversarially',
  phases: [
    { title: 'Implement', detail: 'one worktree branch per area, native + affected vitest tests (Opus high)', model: 'opus' },
    { title: 'Review', detail: 'adversarial review against the REA evidence, fix in place (Opus high)', model: 'opus' },
  ],
}

const REPO = args.repo

const AREAS = [
  { key: 'components', branch: 'r17b-components', report: 'docs/research/rea/components.md',
    tasks: `Its integration plan tasks 2, 4 and 7 (Batch A already did 1, 3, 5, 6, 11 — see git log on main): (2) validation — engine refusals as E_INVALID with a message key the TS toast shows in Figma's wording: empty names; '=' or ',' in VARIANT names / values; default kind mismatch; INSTANCE_SWAP default / preferred value not a SYMBOL or set, or cycling; a component containing an instance of itself (transitively) refused on create / paste / insert / reparent / swap; set cycles on reparent; conflicting overrideKeys repaired at load; the Publish dialog lists unused defs and conflicting names as Figma's publish errors; (4) reset categories — Figma's 15 reset kinds plus Variable modes, RESET_OVERRIDES {kind} (keep the old fields form), plugin removeOverrides / resetOverrides reset overrides but keep componentPropAssignments; leave the UI's reset-all behaviour as it is; (7) variant backfill — a user rename of a variant SYMBOL updates variantPropSpecs / stateGroupPropertyValueOrders / VARIANT defs, invalid names marked conflicting, EDIT refuses defaultValue on VARIANT and SLOT, the plugin refuses VARIANT on a loose component. Every new message through t() with its Turkish entry.` },
  { key: 'effects', branch: 'r17b-effects', report: 'docs/research/rea/effects.md',
    tasks: `Its integration plan items 8, 9, 12, 13 and 15 (Batch A did 1-7 — see git log on main): (8) the effect op list — drawNode walks effects in array order: every layer blur and texture compounds, noise over the content only, only the first background-blur-or-glass, the other rules of §2.10; (9) background blur clamped to the node box (clamp rect + per-tap rejection in the tent pass); (12) Figma's 3-octave gradient-noise fBm for noise and texture (density bands, three modes, centred anchor, texture displacement and clip rule); (13) image colour adjustments in Figma's exact pipeline, contrast stored ±0.3 (convert old values at load), plus the Plugin API contrast mapping; (15) dither and blend epsilon. GL and WGSL shaders together; engine-shot checks for each; engine.md §6.7.` },
  { key: 'vector', branch: 'r17b-vector', report: 'docs/research/rea/vector.md',
    tasks: `Its integration plan steps 5, 6, 7 and 9 (Batch A did 1-4 — see git log on main): (5) scatter defaults per built-in brush (the measured settings written as the BRUSH node's scatterStrokeSettings 449 on install; base gap 0.9 for custom brushes; apply merges base, node, user); (6) Outline stroke and Flatten of Dynamic and Brush strokes through exporter::strokeOf, with the instance-sublayer gates; (7) the Simplify vector tool as Figma has it (live preview, threshold −2…3, tolerance 10^−t, one undo step on Apply, Cancel restores; secondary toolbar replacing the popover); (9) the Offset path tool on the same pattern (engine slider range, Miter / Round). New UI text via t() with Turkish entries.` },
  { key: 'canvas', branch: 'r17b-canvas', report: 'docs/research/rea/canvas.md',
    tasks: `Its integration plan steps 6, 8 and 13 (Batch A did 1, 3, 4, 5; performance steps 9-20 wait for a measured round): (6) image colour handling — decode in a worker with straight alpha, the image's colour profile tagged sRGB / Display P3, premultiply and convert at upload or in the shader, as §2.6 says; (8) input fidelity — wheel source classification (trackpad vs mouse) and normalisation in CanvasController.ts, the per-axis click-count box, touch pinch; (13) pointer-move coalescing during gestures (latest wins per tick) and one drag replay after a reflow. Do not touch the effects shaders (another branch changes them).` },
]

const COMMON = `You work in a fresh git worktree of ${REPO} (your cwd). First: \`git checkout -b <branch>\` with the branch name given below; if node_modules is missing, \`ln -s ${REPO}/node_modules node_modules\` (also for any nested package that has its own node_modules in ${REPO}, e.g. server/ — only if you need it).
Read the report section by section before changing code; its evidence decides the numbers. Follow the repo rules in AGENTS.md (contracts decide; the generated flat API, no embind; design-system tokens; new UI text through t() with its Turkish entry).
Tests (the owner wants speed: affected suites only, not the full check): add native doctest cases for engine changes and run \`npm run engine:test\` (native, ASan; it takes a while — run it once near the end, plus once after fixes); run the affected vitest files with \`npx vitest run <paths>\`; \`npx tsc --noEmit -p tsconfig.web.json\` (and tsconfig.node.json if you touched main/store) and \`npx eslint <changed files>\`.
Do NOT commit src/renderer/src/engine/wasm/engine.wasm or engine.mjs — the main session rebuilds the wasm once after merging all branches. If a vitest file needs the new wasm, you may run \`npm run engine:build\` locally, then \`git checkout -- src/renderer/src/engine/wasm\` before committing, and say so.
Machine limit: 16 GB Mac shared with other agents — no parallel builds of your own, nothing over ~3 GB.
Commit on your branch in small logical commits whose messages follow the repo's style ("Engine: …", "Design panel: …", "Docs: …") and end with the line: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>. Do not push, do not merge into main.
If a task turns out bigger or riskier than the report says, do the safe part, leave the rest, and report it.`

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string' }, worktreePath: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' } },
    done: { type: 'array', items: { type: 'string' } },
    notDone: { type: 'array', items: { type: 'string' }, description: 'tasks skipped or partial, with why' },
    tests: { type: 'string', description: 'what ran and the pass/fail counts' },
    needsWasmRebuild: { type: 'boolean' },
  },
  required: ['branch', 'worktreePath', 'commits', 'done', 'notDone', 'tests'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['merge', 'merge-with-fixes-made', 'do-not-merge'] },
    findings: { type: 'array', items: { type: 'object', properties: {
      issue: { type: 'string' }, fixed: { type: 'boolean' } }, required: ['issue', 'fixed'] } },
    tests: { type: 'string' },
  },
  required: ['verdict', 'findings', 'tests'],
}

let running = 0, implRunning = 0; const waiters = []
async function slot(isImpl, fn) {
  while (running >= 3 || (isImpl && implRunning >= 2)) await new Promise(r => waiters.push(r))
  running++; if (isImpl) implRunning++
  try { return await fn() } finally {
    running--; if (isImpl) implRunning--
    const ws = waiters.splice(0); ws.forEach(w => w())
  }
}

const results = await pipeline(AREAS,
  a => slot(true, () => agent(
`Implement Round 17 Batch B for "${a.key}" in Wecra. Branch: ${a.branch}. Report: ${REPO}/${a.report} (also docs/research/rea/README.md).
Tasks: ${a.tasks}

${COMMON}

Return the branch, the absolute worktree path (pwd), the commits, what is done / not done and the test results.`,
    { label: `impl:${a.key}`, phase: 'Implement', model: 'opus', effort: 'high', isolation: 'worktree', schema: IMPL_SCHEMA })),

  (impl, a) => slot(false, () => agent(
`Adversarially review branch ${impl.branch} in the worktree ${impl.worktreePath} (diff against main: \`git -C ${impl.worktreePath} diff main...HEAD\`). It implements Round 17 Batch B for "${a.key}" from ${REPO}/${a.report}.
The implementer reports: ${JSON.stringify({ done: impl.done, notDone: impl.notDone, tests: impl.tests })}
Check every change against the report's Figma evidence (numbers, enums, defaults, order of operations), look for regressions in callers (grep every changed function's users, including the .fig importer / exporter, the Plugin API, the agents' MCP schema and the panels), GL and WGSL shaders kept in step, undo / NODE_CHANGES correctness, missing Turkish i18n entries, and tests that do not actually pin the behaviour. Fix what you find directly in that worktree and commit on the same branch (same commit rules: repo message style, the Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com> line, never commit engine.wasm / engine.mjs, no push / merge). Re-run the affected tests (\`npm run engine:test\` if C++ changed, affected vitest files, tsc, eslint on changed files). Verdict do-not-merge only for a defect you could not fix.`,
    { label: `review:${a.key}`, phase: 'Review', model: 'opus', effort: 'high', schema: REVIEW_SCHEMA })
    .then(review => ({ area: a.key, impl, review }))),
)

return results.map((r, i) => r || { area: AREAS[i].key, failed: true })
