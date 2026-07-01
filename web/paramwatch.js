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

// If `param_names` is fed by a link, resolve the upstream string value so the
// dropdown can follow a connected String Constant live (before running). Walks
// through Reroute nodes. Returns null when not connected or when the upstream
// value isn't a readable widget (e.g. a runtime-computed string) — the caller
// then falls back to the node's own widget value.
function resolveLinkedString(node, inputName) {
  const graph = node.graph;
  if (!graph) return null;
  const input = node.inputs?.find((i) => i.name === inputName);
  if (!input || input.link == null) return null;

  let linkId = input.link;
  const seen = new Set();
  for (let hops = 0; hops < 64; hops++) {
    if (linkId == null || seen.has(linkId)) return null;
    seen.add(linkId);
    const link = graph.links?.[linkId];
    if (!link) return null;
    const src = graph.getNodeById?.(link.origin_id);
    if (!src) return null;

    // Reroute passes its single input through — keep walking upstream.
    const isReroute = src.type === "Reroute" || src.comfyClass === "Reroute";
    if (isReroute && src.inputs?.[0]?.link != null) {
      linkId = src.inputs[0].link;
      continue;
    }
    // Prefer a string-bearing widget on the source (Primitive/String Constant).
    const w =
      src.widgets?.find((x) => x.name === "value") ??
      src.widgets?.find((x) => x.name === inputName) ??
      (src.widgets?.length === 1 ? src.widgets[0] : null);
    if (w != null && typeof w.value === "string") return w.value;
    return null; // upstream value not readable on the frontend
  }
  return null;
}

// Walk the live graph and return labels + a value lookup, mirroring the Python
// side: "<id>: <title> [<param>]" for each node that has a matching WIDGET.
// The label uses the node's editor Title (falling back to its class), matching
// _meta.title that graphToPrompt writes into PROMPT, so the JS label and the
// Python label agree.
function scanGraph(node, names) {
  const labels = [];
  const valueByLabel = {};
  const graph = node.graph;
  if (!graph || !names.length) return { labels, valueByLabel };
  for (const other of graph._nodes) {
    if (other.id === node.id) continue;                 // skip self
    if (!other.widgets) continue;
    const title = other.title || other.comfyClass || other.type || "?";
    for (const name of names) {
      const w = other.widgets.find((w) => w.name === name);
      if (!w) continue;
      // Skip widgets that are currently converted to a link input (no live value).
      const asInput = other.inputs?.find((i) => i.name === name && i.link != null);
      if (asInput) continue;
      const label = `${other.id}: ${title} [${name}]`;
      labels.push(label);
      valueByLabel[label] = w.value;
    }
  }
  return { labels, valueByLabel };
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
      const { labels, valueByLabel } = scanGraph(node, names);
      node._pwValueByLabel = valueByLabel;
      const opts = labels.length ? labels : ["(no matching nodes)"];
      _lastKey = names.join("|") + "" + opts.join("|");
      selW.options = { values: opts };
      // Keep a valid selection.
      if (!opts.includes(selW.value)) {
        selW.value = opts[0];
        selW.callback?.(selW.value);
      }
      updateDisplay();
      managePoll();
    }

    // Cheap poll: repopulate only if the effective names / matches changed. Below
    // the min-chars threshold it does NO graph scan. Self-suspends when idle and
    // not linked (see managePoll).
    function pollIfChanged() {
      const raw = effectiveRaw();
      if (!scanWorthwhile(raw)) {
        const key = "idle:" + raw;
        if (key !== _lastKey) refreshOptions();
        return;
      }
      const names = parseNames(raw);
      const { labels } = scanGraph(node, names);
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
