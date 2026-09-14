# DeepSeek review log — Dashboard Design Preview spec

Plan/spec file: `docs/superpowers/specs/2026-09-14-dashboard-design-preview-design.md`

## Round 1 — DeepSeek

Full reply preserved for the record (lightly reformatted, content unchanged):

> **Critical Issues**
> 1. Computed style returns RGB, not hex — `getComputedStyle().getPropertyValue()` returns colors in
>    `rgb()`/`rgba()` format, not `#0A0A0A`. Every color field would start blank or error.
> 2. Unserializable `--font-*` values on mount — computed values of `--font-display` etc. will be the
>    *resolved* font stacks (e.g. the font loader's internal name), not the literal
>    `var(--font-sentient), Georgia, serif` chain, so the mounted value will never match a dropdown
>    option.
> 3. `SETTINGS_PAGES` example is stale/conflicting — the pasted reference file doesn't show the new
>    6th card, and appears truncated.
> 4. `themePreview.ts` shown is irrelevant, but fine as context.
> 5. `--accent-ink`/`--accent` contrast is low but pre-existing, not this feature's bug.
> 6. No explicit sync rule between the color picker and its hex text field — a classic two-inputs
>    desync footgun.
> 7. `--radius` mount case — `"7px"` needs `parseInt`, an unmentioned conversion step.
> 8. Token count says 19, but 16 colors + 1 radius + 3 fonts = 20.
>
> Minor: Clipboard API isn't a secure context over a LAN IP, only on `localhost` itself; note the
> failure mode. Unit test for `serializeTokensToCss` should check token ordering and the literal font
> chains, not just any ordering.
>
> VERDICT: REVISE

### Claude's triage (verified against real code/a live browser, not just reasoned about)

**Rejected — #1 (hex → rgb), confirmed false.** Tested directly in a live browser
(`mcp__playwright__browser_evaluate` against a synthetic `:root { --bg: #0A0A0A; }` rule): a CSS
custom property with no nested `var()` in its value returns its *literal authored text* from
`getComputedStyle().getPropertyValue()` — `"#0A0A0A"`, not `rgb(10, 10, 10)`. This is a real,
well-defined difference between custom properties (untyped token sequences until something consumes
them with `var()`) and actual typed CSS properties like `color`/`background-color` (which DO resolve to
`rgb()`). DeepSeek conflated the two. No spec change needed for the 16 color tokens or `--radius`.

**Confirmed real — #2 (font tokens), the one load-bearing finding.** Tested the same way, this time
WITH a nested `var()` reference (`--font-sentient: "X"; --font-display: var(--font-sentient), Georgia,
serif;`): reading `--font-display` back returned the *substituted* value
(`'"X", Georgia, serif'`), not the literal `var(--font-sentient), Georgia, serif` chain. In the real
app this means reading the 3 font tokens via `getComputedStyle` on mount would return next/font/local's
internal generated font-family names, which would never match any of the 3 dropdown options. **Fixed**
in the spec: the 3 font tokens are no longer read via `getComputedStyle` at all — their starting
selection is hardcoded to the known default mapping (display→Sentient, body→Satoshi, mono→Plex Mono),
which is exactly what `globals.css` assigns today.

**Rejected — #3 (SETTINGS_PAGES "stale/conflicting").** The file was deliberately pasted as *current,
pre-change* reference material for DeepSeek to judge feasibility against — the same way every other
spec in this project shows "what exists today" separately from "what this feature adds." Not a defect
in the spec document itself, just how the review prompt framed reference material. No change needed.

**Rejected — #4, #5.** DeepSeek itself marked these as non-issues ("fine as context",
"not this feature's bug"). No action.

**Fixed — #6 (hex/picker sync).** Added an explicit rule: the color picker is primary and pushes to
the hex field on every `input` event; the hex field only pushes back to the picker on blur/Enter, and
only when it parses as a valid 6-digit hex color.

**Fixed — #7 (radius parse step).** Made explicit: computed `"7px"` → `parseInt(value, 10)` → `7` for
the number input; `7` → `` `${value}px` `` on write. Added as an explicit unit-tested case alongside
`serializeTokensToCss`.

**Fixed — #8 (token count).** Corrected "19 tokens" → "20 tokens" (16 colors + 1 radius + 3 fonts);
verified by recounting the actual `globals.css` `:root` block entries one by one.

**Fixed — Clipboard/LAN minor note.** Added an explicit fallback: if `navigator.clipboard` is
unavailable (non-secure-context LAN access), render the CSS text in a visible `<textarea readOnly>`
instead of silently failing.

**Folded in — test-ordering minor note.** Testing section now explicitly calls out asserting token
order and the literal font-chain strings, not just "assert the output string."

Net: 1 critical finding confirmed real and fixed (font-token mount read), 1 critical finding checked
and found false with direct empirical evidence, 1 real arithmetic error fixed, 2 minor completeness
gaps closed, 2 non-issues (already self-dismissed by DeepSeek) left as-is, 1 finding about reference
framing (not the spec itself) needed no spec change.

## Round 2 — DeepSeek

`VERDICT: APPROVED`, with 5 more items raised alongside confirming rounds 1's fixes landed.

### Claude's triage

**Fixed — "19 tokens" survived in the Copy CSS section's code-comment example.** Checked directly
(`grep -n "19"` against the actual spec file) rather than trusting the claim: confirmed real, one
leftover occurrence at the old line 113 (the prose count elsewhere had already been corrected to 20,
this one code-comment example hadn't). Fixed to 20.

**Fixed — font-token state representation was genuinely ambiguous.** DeepSeek correctly identified
that the spec never said whether each font token's React state holds the option's *label* ("Sentient")
or its full *chain string* (`'var(--font-sentient), Georgia, serif'`) — leaving a real
label-vs-value mismatch risk for whoever implements the `<select>`. Resolved: state holds the chain
string directly, so `<option value={chain}>{label}</option>` and the serializer both consume the same
value with no lookup table needed.

**Fixed — empty/cleared radius input would serialize to invalid CSS.** Real gap: the spec's error
handling only covered the *read* path (computed value comes back empty), not the *write* path
(operator clears the number input, producing `--radius: px;`). Fixed: the serializer falls back to
`7` (the real current default) for an empty/non-numeric radius value.

**Accepted as noted, no spec change — hardcoded font-default drift risk.** DeepSeek flagged that if
`globals.css`'s actual `--font-display` assignment ever changes from Sentient to something else, the
hardcoded starting selection would silently show the wrong default. Correct, but accepted as-is: this
is a manual-only, single-operator preview tool with no other consumers, the mismatch is purely
cosmetic (wrong *starting* selection, immediately correctable by the operator picking the right
option), and the alternative (parsing `globals.css`'s raw text server-side) reintroduces the exact
server-side coupling this design deliberately avoids. Worth revisiting only if a 4th font role or a
genuinely dynamic font set is ever added.

**Fixed — hex case normalization.** `globals.css` itself mixes letter case (`#0A0A0A` vs `#8ea885`);
added an explicit serializer rule normalizing every hex value to uppercase on output, so Copy CSS's
result doesn't depend on whatever case the operator typed or the native color-picker input returned.

**Skipped, self-dismissed by DeepSeek itself — `--accent-ink`/`--accent` contrast.** Pre-existing
design, explicitly out of scope for this feature per DeepSeek's own note ("not this feature's bug").

Net for round 2: 3 real, worth-fixing gaps (stale count, state-representation ambiguity, empty-radius
serialization) fixed; 1 minor completeness addition (hex case) folded in; 1 flagged risk accepted as a
deliberate, documented trade-off rather than fixed; 1 non-issue left alone.

**Final verdict: APPROVED.** Spec is ready for `writing-plans`.
