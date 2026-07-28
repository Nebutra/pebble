# Research: `RuntimeEnvironmentsPane.tsx` structure and where an "edit address" affordance fits

- **Query**: structure of the add (~:423) and remove (~:512) actions; where an "edit address" affordance belongs per `docs/STYLEGUIDE.md`; which shadcn primitives the pane already uses
- **Scope**: internal
- **Date**: 2026-07-28

## Findings

### File

`packages/product-core/renderer/src/components/settings/RuntimeEnvironmentsPane.tsx` — 1376 lines, opens with an `eslint-disable max-lines` at `:1-3`.

> Per `AGENTS.md`: *"Never add a `max-lines` disable"*. The file already carries one, but any new code should be pulled into a sibling module (e.g. `RuntimeEnvironmentEditAddressDialog.tsx`) rather than growing this file further. The pane already extracts `RuntimePairingUrlGenerator`, `EphemeralVmRuntimesSection`, and `runtime-environments-search` — that is the established pattern.

### shadcn primitives already imported (`:36-52`)

| Primitive | Import path |
|---|---|
| `Button` | `../ui/button` |
| `Input` | `../ui/input` |
| `Label` | `../ui/label` |
| `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue` | `../ui/select` |
| `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle` | `../ui/dialog` |
| `toast` | `sonner` |

Also: `SearchableSetting` (`./SearchableSetting`) as the pane root, `cn` from `@/lib/utils`, `translate` from `@/i18n/i18n`, and lucide icons `AlertTriangle, ChevronDown, Loader2, Plus, RefreshCw, Server, ServerOff, Share2, Trash2` (`:4-14`).

No `Popover`, `DropdownMenu`, `Tooltip`, or `Sheet` in this pane today.

### The add flow

| Line | What |
|---|---|
| `:264` | `const [addServerFormOpen, setAddServerFormOpen] = useState(false)` |
| `:381-388` | `closeAddServerForm()` — guards on `isSaving`, clears `name` + `pairingCode`, closes |
| `:390-471` | `addEnvironment()` — trims, validates non-empty, checks duplicate name case-insensitively, optionally switches away from the active env, calls the API, reloads, optionally switches to the new env (rolling back with `remove` at `:435` if the switch fails), toasts, closes the form |
| `:423-426` | `await window.api.runtimeEnvironments.addFromPairingCode({ name, pairingCode })` |
| `:750-763` | "Add Server" trigger — `<Button variant="outline" size="sm" className="gap-1.5">` with `<Plus />`, hidden while the form is open |
| `:766-849` | The **inline form**: `<form className="space-y-3 rounded-lg border border-border/50 bg-muted/20 p-3">`, a `grid gap-3 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)]` holding two `space-y-1` label groups (`<Label htmlFor>` + `<Input className="h-8 text-xs">`), a helper `<p className="text-xs text-muted-foreground">` wired via `aria-describedby`, and a right-aligned `flex justify-end gap-2` footer with `outline` Cancel + `default` submit |

Note: the add flow is an **inline expanding form**, not a Dialog. The pairing-code input uses `font-mono text-xs` (`:801`).

`AddRemoteHostDialog.tsx:184` is a second, dialog-based entry point to the same `addFromPairingCode` API — worth reading if a modal shape is preferred.

### The remove flow

| Line | What |
|---|---|
| `:263` | `const [pendingRemove, setPendingRemove] = useState<PublicKnownRuntimeEnvironment | null>(null)` |
| `:281` | `removingActiveServer = pendingRemove?.id === settings.activeRuntimeEnvironmentId` |
| `:480-537` | `removeEnvironment(environment)` — sets `removingId`, switches away if it is the active env, calls `remove` at `:512`, reloads, toasts, clears `removingId` in `finally` |
| `:964-988` | The row trigger: `<Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-red-400">` with `<Trash2 className="size-3" />`, `aria-label` from `translate('…', 'Remove {{value0}}', { value0: environment.name })`, swapped for `<Loader2 className="size-3 animate-spin" />` while `removingId === environment.id`. It only sets `pendingRemove` — it does not delete |
| `:1296-1376` | The confirmation `<Dialog>` — `DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}`, `DialogHeader`/`DialogTitle className="text-sm"`/`DialogDescription`, a detail block at `:1329-1340` showing `pendingRemove.name` and `pendingRemove.endpoints[0]?.endpoint`, then a `DialogFooter` |

So the pattern is: **row icon-button → state → modal confirm**.

### The list row anatomy (`:857-993`)

```
<div className="flex items-center gap-3 px-4 py-3">
  <Server className="size-4 shrink-0 text-muted-foreground" />
  <div className="min-w-0 flex-1">
     name + status dot + status label + AlertTriangle/Loader2
     <p className="truncate text-xs text-muted-foreground">…summary…</p>
     optional detail line
  </div>
  <div className="flex shrink-0 items-center gap-1">
     Disconnect | Connect   (Button variant="ghost" size="xs" className="gap-1.5")
     Remove                 (Button variant="ghost" size="icon" className="size-7")
  </div>
</div>
```

`actionBusy` (`:882-886`) is the per-row disable guard: `connectingId | switchingValue | disconnectingId | removingId === environment.id`. Any new per-row action must join that set.

### Where the endpoint is currently *displayed*

Two places, both read-only:

1. **Advanced → "Server details"** (`:1100-1156`): a `grid … sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)]` block rendering `environment.endpoints[0]?.endpoint ?? 'No endpoint'` in `truncate font-mono` at `text-[11px]` (`:1121-1127`). This is inside the collapsible "Advanced" section (`:998-1016`, toggled by `advancedOpen` with a `grid-template-rows` transition).
2. **Remove-confirmation dialog** (`:1333`): `pendingRemove.endpoints[0]?.endpoint`.

Both use `endpoints[0]`, not `preferred_endpoint_id` — a small inconsistency with the Rust resolver (`runtime_environments.rs:765-775`), harmless while there is exactly one endpoint.

### Where "edit address" fits, per `docs/STYLEGUIDE.md`

The style guide's primitive-selection table (`docs/STYLEGUIDE.md:139-155`) says:

| You want… | Reach for | Don't use |
|---|---|---|
| Click-revealed surface with arbitrary content (form, picker) | `Popover` | `Dialog` (it traps focus and dims) |
| Modal that demands a decision before you continue | `Dialog` | `Popover`, inline overlay |
| Hover-only label on an icon-only button | `Tooltip` | `HoverCard`, title attr |

Editing a saved server's address is a **single-field form, not a decision that must block the app** — so the guide points at `Popover`, or at an inline expanding form matching the existing Add-Server treatment. It explicitly warns: *"If you find yourself styling around a primitive (`<Popover>` to act like a `<Dialog>`, or vice versa), stop and reconsider."*

Two shapes that fit the pane's own conventions:

**A. Row action → inline edit row (most consistent with Add Server).** Add a `Pencil` (lucide) `<Button variant="ghost" size="icon" className="size-7">` to the row's action cluster at `:964`, ahead of the Remove button. Toggling it swaps the row's descriptive `<p>` for a compact `space-y-1` label group + `<Input className="h-8 font-mono text-xs">` + `flex justify-end gap-2` Cancel/Save footer, exactly mirroring `:766-849`. Follows the guide's **Form anatomy** section (`docs/STYLEGUIDE.md:213-221`): `space-y-2` for a compact single-control field, `<Label>` + `text-xs text-muted-foreground` description, errors via `aria-invalid` (the `Input` primitive already renders a destructive ring — *"don't paint your own"*).

**B. Row action → `Popover` anchored to the pencil.** Requires importing `../ui/popover` (not currently imported by this pane). Lighter weight, no dimming, and it is what the primitive table nominates for "click-revealed surface with a form".

**Do not** use a `Dialog` here — that is reserved in this pane for the destructive confirm and for the server switch, both of which genuinely demand a decision.

Additional guide rules that apply:

- **Buttons** (`:117-131`): `ghost` for "icon buttons, list-row triggers"; `default` for "the single affirmative action in a flow"; `outline` for Cancel; `destructive` never for Cancel.
- **Icons** (`:181-190`): lucide only, `size-3`/`size-3.5` for dense list rows, canonical spinner `<Loader2 className="size-4 animate-spin" />`.
- **Tooltips** (`:157-179`): an icon-only Pencil needs a `Tooltip` with `<TooltipTrigger asChild>`; the global `TooltipProvider` is already at the App root, do not nest another.
- **UX rule 2** (`:299-306`, "Look for sibling components before designing in isolation"): the Add-Server form and the remove confirm are the siblings to match.
- **Product language** (`:238-250`) — the pane says "server", never "environment", in user-facing copy ("Add Server", "Remove {name}", "No saved servers.", "Switch Server"). Keep that.
- Every user-facing string goes through `translate('auto.components.settings.RuntimeEnvironmentsPane.<hash>', 'English default')`.

### Placement of an auto-rediscovery affordance

When a connect fails and mDNS finds a new address, the natural surfaces are:

- The per-row status line (`:905-923`, `getHostDetailsSummary` / `getHostDetailsDescription`) — the guide's *"Persistent inline status"* row says inline text + `Badge`, **not** a toast, because toasts disappear.
- A `sonner` toast only for the transient confirmation *"Reconnected — address updated to …"* (guide: *"Transient confirmation ('Saved', 'Copied') → `sonner` toast"*). The pane already toasts on add/remove/switch.

`getRuntimeServerConnectionState` / `getRuntimeServerDotClass` / `getRuntimeServerConnectionLabel` (used at `:893-903`) are the existing status-state helpers to extend if a "rediscovering…" state is wanted.

## Related Specs

- `docs/STYLEGUIDE.md` — §Components, §Picking the right primitive (`:136-155`), §Tooltips (`:157-179`), §Icons (`:181-190`), §Form anatomy (`:213-221`), §UX rules (`:232-310`)
- `.trellis/spec/desktop-tauri/frontend/component-guidelines.md`, `hook-guidelines.md`, `state-management.md`, `quality-guidelines.md` (untracked, newly added — read before implementing)

## Caveats / Not Found

- There is no existing "edit" affordance anywhere in this pane; this is net-new UI.
- `packages/product-core/renderer/src/components/ui/popover.tsx` was not read; confirm the export names before choosing shape B.
- The `translate()` keys are content-hashed (`auto.components.settings.RuntimeEnvironmentsPane.<hash>`); there is presumably a generator for them — I did not locate it.
