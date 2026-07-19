# ComfyUI-ParamWatch

A small utility node that **collects a named parameter's value from every node in
the workflow**. Give it a comma-separated list of widget names to watch (e.g.
`ckpt_name, unet_name, gguf_name`); it scans the whole prompt graph, lists every matching
node in a dropdown, and outputs the value of the one you select — plus a dump of
all collected values.

> **Status:** functional and unit-tested; not yet widely field-tested. See
> **Limitations** below.

---

## What it does

- **`param_names`** (string) — comma-separated widget names to watch, e.g.
  `"ckpt_name, unet_name, gguf_name"`.
- **`value_filter`** (string) — optional. When non-empty, narrows the `selected`
  dropdown to entries whose **resolved value** contains this text
  (case-insensitive substring) — handy when many nodes match `param_names`. An
  entry whose value isn't resolvable yet is matched on its label instead, so it
  stays findable by node id / param name. Clearing the box shows all matches
  again. This is a frontend convenience only; it doesn't change the output.
- **`selected`** (dropdown) — auto-populated with `"<node_id>: <title> [<param>]"`
  for every node in the workflow that has one of those widgets. The label uses each node's editor Title (falling back to its class name when untitled). Updates **live**
  in the editor as you edit `param_names` (or the String Constant feeding it),
  before you run.
- **display area** — shows the selected node's parameter value.
- **outputs:**
  | output | contents |
  |---|---|
  | `value` | the selected node's parameter value (string) |
  | `all_values` | every collected match, one per line: `"<id>: <title> [<param>] = <value>"` |
  | `param_name` | which watched name the selected node matched on |

### Driving `param_names` from a String Constant
You can convert `param_names` to an input and wire a **String Constant** (or
Primitive String, through Reroutes) into it. The dropdown follows that upstream
value **live** in the editor, and the outputs use it at run time.

---

## How it reads the graph

The node declares the hidden `PROMPT` input, which ComfyUI populates with the
entire prompt graph: `{node_id: {"class_type": str, "inputs": {name: value|link}}}`.
It reports each node whose `inputs` contains a watched name **as a widget value**.

Because the dropdown is populated dynamically on the frontend, the node declares
`VALIDATE_INPUTS(**kwargs) -> True` so the server's combo-membership check is
skipped for the `selected` field.

**Subgraphs are supported.** Nodes nested inside native ComfyUI subgraphs are
found too — the frontend scan recurses into every subgraph, and both the
dropdown label and the backend resolution key them by ComfyUI's composite
execution id (`"<subgraphNodeId>:<innerId>"`, nesting deeper as `"a:b:c"`), so a
watched parameter inside a subgraph shows up as e.g. `2:3: MyLoader [ckpt_name]`.

---

## Installation

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/<you>/ComfyUI-ParamWatch
# then FULLY restart ComfyUI (stop the process and relaunch — not the
# "Restart" button in ComfyUI Manager, which may keep stale modules loaded)
```

No dependencies beyond ComfyUI itself.

---

## Limitations (please read)

- **Widget values, plus link-followed values.** A parameter set by a **widget**
  is read directly. A parameter fed by a **link** (`[node_id, slot]`) is now also
  **listed**: if the link traces back to a readable upstream widget (String /
  Primitive / Int / Float Constant, through Reroutes), its value is resolved and
  shown. If the upstream is genuinely **computed** (a node with no readable
  widget), the node still appears in the dropdown with the value shown as
  `(from linked node)` — it's selectable, but the true value only exists at run
  time and can't be previewed statically.
- **Subgraph input boundaries.** When a node *inside a subgraph* gets a parameter
  from the subgraph's widget/**input slot** (e.g. a Load Diffusion Model whose
  `unet_name` is set on the subgraph and passed in via a subgraph input), the
  value is found. ComfyUI has several widget-promotion mechanisms that differ by
  version (link-to-boundary, store-backed promoted widgets, and `proxyWidgets`),
  so rather than reverse-engineer each one, the live dropdown is populated from
  ComfyUI's **own `graphToPrompt()`** — the same call used to queue a run. It
  flattens subgraphs and resolves every promotion to a literal value keyed by the
  composite execution id (`2:4`), so the editor preview matches exactly what the
  backend executes. A parameter that is a genuine node-to-node connection (not a
  promoted widget) still shows `(from linked node)`.
- **Live dropdown needs a readable upstream.** When `param_names` is fed by a
  link, the editor follows it only if the source is a readable widget (String
  Constant / Primitive String, via Reroutes). A **computed** upstream string
  (e.g. a concat/format node with no widget) can't be previewed live — but the
  **outputs still resolve correctly at run time**.
- **Two-phase behavior.** The dropdown/display update live in the editor (JS
  reads the live graph); the string **outputs** are produced when the workflow
  **runs** (Python reads `PROMPT`).
- **Only nodes in the executed prompt appear.** Muted/bypassed or unconnected
  nodes may be pruned from `PROMPT`.
- **Match on the internal widget name**, not the UI display label.
- **Idle efficiency:** the graph is not scanned until `param_names` has at least
  3 real characters (and ≥1 non-empty name). An empty / comma-only, unlinked node
  runs **no background poll** at all; the poll starts when you enter a watch
  string or connect an input, and stops again when the string is cleared.

---

## License

GNU Affero General Public License v3.0 (AGPL-3.0) — see `LICENSE`.
