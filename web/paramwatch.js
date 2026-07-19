import { app } from "../../scripts/app.js";

// ParamWatch frontend:
//  - live-populates the `selected` dropdown by scanning the graph for nodes
//    whose widgets match the comma-separated `param_names` (works while editing,
//    before running);
//  - shows the selected node's current widget value in a read-only text area,
//    updated both live (from the graph) and after execution (from the node's
//    ui payload, which resolves values the frontend can't see, e.g. link-fed).

// Don't scan the graph until the watch string has real content — avoids churn
// while the user is still typing the first parameter name.
const MIN_CHARS = 3;

function parseNames(s) {
  return (s || "").split(",").map((x) => x.trim()).filter(Boolean);
}

// True only when the watch string is worth scanning for: at least MIN_CHARS
// non-whitespace/comma characters AND at least one non-empty name.
function scanWorthwhile(rawStr) {
  const stripped = (rawStr || "").replace(/[\s,]/g, "");
  return stripped.length >= MIN_CHARS && parseNames(rawStr).length > 0;
}

// Shown for a watched param whose value is fed by a link we can't statically
// read (e.g. the output of a compute node). The node is still listed so it can
// be selected; the real value only exists at runtime.
const LINKED_UNRESOLVED = "(from linked node)";

// litegraph constant: a link whose origin is a subgraph's boundary INPUT node
// carries this origin_id instead of a normal node id. (constants.ts:
// SUBGRAPH_INPUT_ID = toNodeId(-10).)
const SUBGRAPH_INPUT_ID = -10;

function isSubgraphInputOrigin(originId) {
  return originId === SUBGRAPH_INPUT_ID || originId === String(SUBGRAPH_INPUT_ID);
}

// Link lookup that tolerates both the object-map (`graph.links[id]`) and the
// method (`graph.getLink(id)`) forms across litegraph versions.
function getLink(graph, linkId) {
  if (!graph || linkId == null) return null;
  return graph.links?.[linkId] ?? graph.getLink?.(linkId) ?? null;
}

// True for a value we can display as-is (skip objects/arrays/functions).
function isReadableScalar(v) {
  const t = typeof v;
  return t === "string" || t === "number" || t === "boolean";
}

// Read a subgraph container's PROMOTED widget value for boundary input slot
// `cin`. A promoted widget is store-backed and projected onto the container's
// `widgets`; match it by widgetId first, then by name/label, then the slot's
// own `_widget`. Returns { ok, value }.
function readPromotedWidgetValue(container, cin) {
  const candidates = [];
  if (cin._widget) candidates.push(cin._widget);
  if (container.widgets) {
    const wid = cin.widgetId;
    if (wid != null) {
      const byId = container.widgets.find((w) => w && w.widgetId === wid);
      if (byId) candidates.push(byId);
    }
    const byName = container.widgets.find(
      (w) => w && (w.name === cin.name || w.name === cin.label)
    );
    if (byName) candidates.push(byName);
  }
  for (const w of candidates) {
    if (isReadableScalar(w?.value)) return { ok: true, value: w.value };
  }
  return { ok: false };
}

// Container (SubgraphNode) whose inner graph is `graph`. Prefer the map built
// during the top-down walk; fall back to litegraph backrefs for callers that
// didn't build one (e.g. the param_names path).
function getContainerNode(graph, containerOfGraph) {
  if (!graph) return null;
  const mapped = containerOfGraph?.get?.(graph);
  if (mapped) return mapped;
  return graph._subgraph_node || graph.subgraphNode || null;
}

// Follow an input link to the upstream widget value, walking through Reroute
// nodes AND across subgraph input boundaries. Returns { ok:true, value } when
// the chain ends at a readable widget (Primitive/String/Int/Float Constant, a
// single-widget node, or a promoted subgraph widget), else { ok:false }.
//
// Subgraph boundary: when a link inside a child graph originates from the
// subgraph INPUT node (origin_id === SUBGRAPH_INPUT_ID), the value lives one
// level up — either as a promoted widget on the container SubgraphNode, or fed
// by the container's own external input, which we then resolve in the parent
// graph. This mirrors ComfyUI's ExecutableNodeDTO.resolveInput.
function resolveLinkedRaw(node, inputName, containerOfGraph) {
  let curNode = node;
  let curName = inputName;
  const seen = new Set();

  for (let boundaryHops = 0; boundaryHops < 64; boundaryHops++) {
    const graph = curNode.graph;
    if (!graph) return { ok: false };
    const input = curNode.inputs?.find((i) => i.name === curName);
    if (!input || input.link == null) return { ok: false };

    let linkId = input.link;
    let crossedBoundary = false;

    for (let hops = 0; hops < 64; hops++) {
      if (linkId == null || seen.has(linkId)) return { ok: false };
      seen.add(linkId);
      const link = getLink(graph, linkId);
      if (!link) return { ok: false };

      // --- Subgraph input boundary: hop up to the container node. ---
      if (isSubgraphInputOrigin(link.origin_id)) {
        const container = getContainerNode(graph, containerOfGraph);
        if (!container) return { ok: false };
        const cin = container.inputs?.[link.origin_slot];
        if (!cin) return { ok: false };
        if (cin.link != null) {
          // Container input is wired externally: resolve it in the parent graph.
          curNode = container;
          curName = cin.name;
          crossedBoundary = true;
          break;
        }
        // Otherwise it's a promoted widget value on the container.
        return readPromotedWidgetValue(container, cin);
      }

      const src = graph.getNodeById?.(link.origin_id);
      if (!src) return { ok: false };

      // Reroute passes its single input through — keep walking upstream.
      const isReroute = src.type === "Reroute" || src.comfyClass === "Reroute";
      if (isReroute && src.inputs?.[0]?.link != null) {
        linkId = src.inputs[0].link;
        continue;
      }
      // Prefer a value-bearing widget on the source (Primitive/String Constant).
      const w =
        src.widgets?.find((x) => x.name === "value") ??
        src.widgets?.find((x) => x.name === curName) ??
        (src.widgets?.length === 1 ? src.widgets[0] : null);
      if (w != null && isReadableScalar(w.value)) {
        return { ok: true, value: w.value };
      }
      return { ok: false }; // upstream value not readable on the frontend
    }

    if (!crossedBoundary) return { ok: false };
    // Loop: re-resolve the container's (external) input in the parent graph.
  }
  return { ok: false };
}

// String-only convenience wrapper used for the `param_names` input, which must
// be a comma-separated string. Returns null unless the resolved value is a string.
function resolveLinkedString(node, inputName, containerOfGraph) {
  const r = resolveLinkedRaw(node, inputName, containerOfGraph);
  return r.ok && typeof r.value === "string" ? r.value : null;
}

// --- Subgraph-aware graph traversal --------------------------------------
// ComfyUI native subgraphs put nested nodes in a separate child graph, so a
// single graph._nodes scan misses them. We walk the whole tree from the ROOT
// graph and tag every node with its execution-id path. ComfyUI flattens
// subgraph nodes into the prompt with colon-joined ids
// ("<subgraphNodeId>:<innerId>", nesting deeper as "a:b:c"); mirroring that here
// keeps the JS dropdown label in agreement with the Python PROMPT resolution.

// The node array of a graph (property name varies across litegraph versions).
function getNodesOf(graph) {
  if (!graph) return [];
  return graph._nodes || graph.nodes || [];
}

// The inner (child) graph of a subgraph container node, or null. Litegraph's
// SubgraphNode exposes `.subgraph` and `isSubgraphNode()`; fall back to the
// property alone for older/other builds.
function getSubgraphOf(n) {
  if (!n) return null;
  if (typeof n.isSubgraphNode === "function") {
    return n.isSubgraphNode() ? (n.subgraph || n.subGraph || null) : null;
  }
  return n.subgraph || n.subGraph || null;
}

// Walk up to the root graph so the scan covers the entire workflow regardless of
// whether ParamWatch sits at the top level or inside a subgraph.
function getRootGraph(graph) {
  let g = graph || app.graph;
  for (let guard = 0; g && guard < 64; guard++) {
    const parentNode = g._subgraph_node || g.subgraphNode || null;
    const parent =
      (parentNode && parentNode.graph) || g.parentGraph || g._parent || null;
    if (!parent || parent === g) break;
    g = parent;
  }
  return g || app.graph;
}

// Depth-first collect of { node, execId } across the root graph and every nested
// subgraph. Depth-guarded (not identity-deduped) so a subgraph DEFINITION reused
// by multiple instance nodes is scanned once per instance, each with its own
// distinct execId prefix — matching how the prompt flattens them.
// Returns { nodes: [{node, execId}], containerOfGraph: Map<childGraph, containerNode> }.
// The containerOfGraph map lets boundary resolution hop from a child graph up to
// the exact SubgraphNode instance that owns it (litegraph backrefs alone can't
// distinguish two instances of the same subgraph definition).
function collectAllNodes(rootGraph) {
  const out = [];
  const containerOfGraph = new Map();
  const walk = (graph, prefix, depth) => {
    if (!graph || depth > 20) return;
    for (const n of getNodesOf(graph)) {
      const execId = prefix ? `${prefix}:${n.id}` : String(n.id);
      const sub = getSubgraphOf(n);
      // A subgraph CONTAINER node is replaced by its inner nodes in the flattened
      // prompt (its own execId never appears there), so recurse into it but don't
      // emit it as a selectable match.
      if (sub) {
        containerOfGraph.set(sub, n);
        walk(sub, execId, depth + 1);
      } else {
        out.push({ node: n, execId });
      }
    }
  };
  walk(rootGraph, "", 0);
  return { nodes: out, containerOfGraph };
}

// Walk the live graph (including subgraphs) and return labels + a value lookup,
// mirroring the Python side: "<execId>: <title> [<param>]" for each node that
// has a matching WIDGET. The label uses the node's editor Title (falling back to
// its class), matching _meta.title that graphToPrompt writes into PROMPT, so the
// JS label and the Python label agree.
function scanGraph(node, names) {
  const labels = [];
  const valueByLabel = {};
  if (!names.length) return { labels, valueByLabel };
  const root = getRootGraph(node.graph || app.graph);
  const { nodes, containerOfGraph } = collectAllNodes(root);
  for (const { node: other, execId } of nodes) {
    if (other === node) continue;                       // skip self (by identity)
    const title = other.title || other.comfyClass || other.type || "?";
    for (const name of names) {
      const w = other.widgets?.find((w) => w.name === name);
      // A watched param can be present as a widget, as an input that was
      // converted to a link, or both (a subgraph-PROMOTED widget keeps its
      // widget AND gains a boundary link — see the proxyWidgets mechanism).
      const asInput = other.inputs?.find((i) => i.name === name);
      if (!w && !asInput) continue;

      const label = `${execId}: ${title} [${name}]`;
      let value;
      // Priority: the node's OWN retained widget value. For subgraph-promoted
      // widgets litegraph keeps the value on the inner node itself (that's what
      // widgets_values holds), so this is the correct, always-available source —
      // and it avoids chasing the boundary link up to a container that stores no
      // value.
      if (w && isReadableScalar(w.value)) {
        value = w.value;
      } else if (asInput && asInput.link != null) {
        // No local widget value: the param is fed purely by a link (a real
        // widget-to-input conversion, or an external subgraph input). Follow it.
        const r = resolveLinkedRaw(other, name, containerOfGraph);
        value = r.ok ? r.value : LINKED_UNRESOLVED;
      } else if (w) {
        value = w.value;                                 // present but non-scalar
      } else {
        continue; // declared as an input but not connected and no widget
      }
      labels.push(label);
      valueByLabel[label] = value;
    }
  }
  return { labels, valueByLabel };
}

// --- Corroborating scan via ComfyUI's own graphToPrompt --------------------
// The live-graph walk reads a subgraph-promoted widget from the inner node's
// own retained widget value (litegraph keeps it there — it's what widgets_values
// stores). As a second source we also consult ComfyUI's OWN graphToPrompt() —
// the same call used to queue a run — which flattens subgraphs into the exact
// composite-execId prompt the Python side reads. It can surface a value the
// live walk missed (e.g. a value that only lives in the widget-value store), so
// we MERGE it in: it may add labels or upgrade an unresolved/empty entry, but it
// never downgrades a good live value to a marker (guards against graphToPrompt
// resolving a promoted input to undefined in some versions).

// True for a serialized link connection: [src_node_id, output_slot].
function isPromptLink(val) {
  return (
    Array.isArray(val) &&
    val.length === 2 &&
    (typeof val[0] === "string" || typeof val[0] === "number") &&
    typeof val[1] === "number"
  );
}

// JS mirror of the Python _iter_prompt_matches: from a flattened prompt
// `output` ({execId: {inputs, class_type, _meta:{title}}}), build the dropdown
// labels + resolved values for every node carrying one of `names` as an input.
// graphToPrompt has already resolved promoted/boundary widget values to
// literals, so a value that is STILL a [src, slot] link is a genuine node
// connection we can't preview → marked LINKED_UNRESOLVED.
function matchesFromPromptOutput(output, names, selfId) {
  const labels = [];
  const valueByLabel = {};
  if (!output || typeof output !== "object") return { labels, valueByLabel };
  const self = String(selfId);
  for (const [execId, entry] of Object.entries(output)) {
    if (!entry || typeof entry !== "object") continue;
    // Skip ourselves — our id may be composite if ParamWatch sits in a subgraph.
    if (execId === self || execId.endsWith(":" + self)) continue;
    const inputs = entry.inputs;
    if (!inputs || typeof inputs !== "object") continue;
    const title = entry._meta?.title || entry.class_type || "?";
    for (const name of names) {
      if (!(name in inputs)) continue;
      let val = inputs[name];
      if (isPromptLink(val)) {
        val = LINKED_UNRESOLVED;
      } else if (val && typeof val === "object" && "__value__" in val) {
        val = val.__value__; // array-valued widget wrapper graphToPrompt writes
      }
      const label = `${execId}: ${title} [${name}]`;
      labels.push(label);
      valueByLabel[label] = val;
    }
  }
  return { labels, valueByLabel };
}

async function scanViaPrompt(node, names) {
  if (!names.length || typeof app.graphToPrompt !== "function") return null;
  let output;
  try {
    const res = await app.graphToPrompt();
    output = res?.output;
  } catch (_) {
    return null; // graph not ready / serialization failed — caller keeps sync result
  }
  if (!output) return null;
  return matchesFromPromptOutput(output, names, node.id);
}

app.registerExtension({
  name: "ParamWatch.Collector",
  async nodeCreated(node) {
    if (node.comfyClass !== "ParamWatch") return;

    const namesW = node.widgets?.find((w) => w.name === "param_names");
    const selW = node.widgets?.find((w) => w.name === "selected");
    if (!namesW || !selW) return;

    // Serialized mirrors of the current selection + its resolved value. A
    // dynamically-repopulated COMBO doesn't reliably serialize its value to the
    // backend, so we keep these plain-STRING widgets in sync and Python reads
    // them. Hide them from the node UI (they're plumbing, not user inputs).
    const labelW = node.widgets?.find((w) => w.name === "selected_label");
    const valueW = node.widgets?.find((w) => w.name === "resolved_value");
    for (const w of [labelW, valueW]) {
      if (!w) continue;
      w.type = "hidden";
      w.hidden = true;
      w.computeSize = () => [0, -4];
    }
    function syncMirror() {
      if (labelW) labelW.value = String(selW.value ?? "");
      if (valueW) {
        const v = node._pwValueByLabel?.[selW.value];
        valueW.value = v === undefined ? "" : String(v);
      }
    }

    // Read-only multiline display of the selected value.
    const display = node.addDOMWidget(
      "paramwatch_value",
      "info",
      Object.assign(document.createElement("textarea"), {
        readOnly: true,
        placeholder: "Selected parameter value appears here after you pick a node.",
        style:
          "width:100%;min-height:48px;resize:vertical;background:#222;color:#ddd;" +
          "border:1px solid #444;border-radius:4px;padding:4px;font-family:monospace;",
      }),
      { serialize: false }
    );
    node._pwValueByLabel = {};

    // Raw effective watch string: upstream value if `param_names` is linked to a
    // (readable) String Constant, else the node's own widget value.
    function effectiveRaw() {
      const linked = resolveLinkedString(node, "param_names");
      return linked != null ? linked : namesW.value;
    }
    function effectiveNames() {
      return parseNames(effectiveRaw());
    }
    // Is param_names currently fed by a link? Poll must stay alive if so, since
    // an upstream String Constant edit won't notify us.
    function isLinked() {
      const inp = node.inputs?.find((i) => i.name === "param_names");
      return !!(inp && inp.link != null);
    }
    let _lastKey = null;

    function refreshOptions() {
      const raw = effectiveRaw();
      // Below the min-chars threshold: DON'T scan the graph — show a hint.
      if (!scanWorthwhile(raw)) {
        node._pwValueByLabel = {};
        const hint = [`(type ${MIN_CHARS}+ chars to search)`];
        selW.options = { values: hint };
        selW.value = hint[0];
        _lastKey = "idle:" + raw;
        display.element.value = "";
        syncMirror();
        managePoll();
        return;
      }
      const names = parseNames(raw);
      // Instant render from the live-graph walk (top-level nodes + plain
      // widgets), then upgrade asynchronously with ComfyUI's own graphToPrompt,
      // which is authoritative for subgraph-boundary / promoted-widget values
      // the live walk can't reliably read.
      const live = scanGraph(node, names);
      applyScan(live, names);
      scanViaPrompt(node, names).then((viaPrompt) => {
        if (!viaPrompt) return;
        if (parseNames(effectiveRaw()).join("|") !== names.join("|")) return;
        applyScan(mergeScans(live, viaPrompt), names);
      });
      managePoll();
    }

    // Merge the corroborating graphToPrompt scan into the live one. Union the
    // labels; for a shared label, keep the live value UNLESS it was unresolved/
    // empty and the prompt has a real one (upgrade-only). Never let the prompt
    // pass downgrade a good live value to a marker.
    function mergeScans(live, viaPrompt) {
      const bad = (v) => v == null || v === "" || v === LINKED_UNRESOLVED;
      const valueByLabel = { ...live.valueByLabel };
      const labels = [...live.labels];
      for (const lbl of viaPrompt.labels) {
        const pv = viaPrompt.valueByLabel[lbl];
        if (!(lbl in valueByLabel)) { labels.push(lbl); valueByLabel[lbl] = pv; }
        else if (bad(valueByLabel[lbl]) && !bad(pv)) { valueByLabel[lbl] = pv; }
      }
      return { labels, valueByLabel };
    }

    // Apply a {labels, valueByLabel} scan result to the dropdown + display,
    // keeping the current selection when it is still valid.
    function applyScan({ labels, valueByLabel }, names) {
      node._pwValueByLabel = valueByLabel;
      const opts = labels.length ? labels : ["(no matching nodes)"];
      _lastKey = names.join("|") + "" + opts.join("|");
      selW.options = { values: opts };
      if (!opts.includes(selW.value)) {
        selW.value = opts[0];
        selW.callback?.(selW.value);
      }
      updateDisplay();
    }

    // Cheap poll: repopulate only if the effective names / matches changed. Below
    // the min-chars threshold it does NO graph scan. Self-suspends when idle and
    // not linked (see managePoll).
    async function pollIfChanged() {
      const raw = effectiveRaw();
      if (!scanWorthwhile(raw)) {
        const key = "idle:" + raw;
        if (key !== _lastKey) refreshOptions();
        return;
      }
      const names = parseNames(raw);
      // Prefer the authoritative graphToPrompt scan for change detection so
      // silent upstream edits (incl. through subgraph boundaries) are noticed;
      // fall back to the sync walk if graphToPrompt is unavailable.
      const viaPrompt = await scanViaPrompt(node, names);
      const { labels } = viaPrompt || scanGraph(node, names);
      const opts = labels.length ? labels : ["(no matching nodes)"];
      const key = names.join("|") + "" + opts.join("|");
      if (key !== _lastKey) refreshOptions();
    }

    // Start/stop the poll timer. Poll only when there's something to watch: a
    // worthwhile local string, OR a connected input (whose upstream value can
    // change silently). An empty/short unlinked node runs no timer at all.
    function managePoll() {
      const needed = isLinked() || scanWorthwhile(effectiveRaw());
      if (needed && !node._pwPoll) {
        node._pwPoll = setInterval(() => { try { pollIfChanged(); } catch (_) {} }, 400);
      } else if (!needed && node._pwPoll) {
        clearInterval(node._pwPoll);
        node._pwPoll = null;
      }
    }

    function updateDisplay() {
      const v = node._pwValueByLabel?.[selW.value];
      display.element.value =
        v === undefined ? String(selW.value ?? "") : String(v);
      syncMirror();
    }

    // Repopulate when the watch list changes, and refresh the value on select.
    const prevNamesCb = namesW.callback;
    namesW.callback = function (...a) {
      const r = prevNamesCb?.apply(this, a);
      refreshOptions();
      return r;
    };
    const prevSelCb = selW.callback;
    selW.callback = function (...a) {
      const r = prevSelCb?.apply(this, a);
      updateDisplay();
      return r;
    };

    // Re-resolve immediately when param_names is connected/disconnected.
    const prevConn = node.onConnectionsChange;
    node.onConnectionsChange = function (...a) {
      const r = prevConn?.apply(this, a);
      refreshOptions();
      return r;
    };

    // Initial population (defer until the graph is settled). refreshOptions()
    // calls managePoll(), which starts the 400ms poll ONLY if the node is linked
    // or has a worthwhile (>= MIN_CHARS) watch string — so an empty/short,
    // unlinked node runs no timer at all. Editing the string / connecting an
    // input re-runs refreshOptions() and thus re-arms or suspends the poll.
    setTimeout(refreshOptions, 100);

    const prevRemoved = node.onRemoved;
    node.onRemoved = function (...a) {
      if (node._pwPoll) { clearInterval(node._pwPoll); node._pwPoll = null; }
      return prevRemoved?.apply(this, a);
    };

    // After execution, the node returns the authoritative display string (which
    // can include values the frontend couldn't read) via its ui payload.
    const prevExecuted = node.onExecuted;
    node.onExecuted = function (message) {
      const r = prevExecuted?.apply(this, arguments);
      const d = message?.paramwatch_display?.[0];
      if (typeof d === "string") display.element.value = d;
      return r;
    };
  },
});
