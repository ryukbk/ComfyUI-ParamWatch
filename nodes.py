"""
ParamWatch — collect a named parameter's value from every node in the workflow.

Give it a comma-separated list of parameter (widget) names to watch, e.g.
"ckpt_name, unet_name, gguf_name". It scans the whole prompt graph, finds every node that
has ANY of those parameters as a widget value, lists them in a dropdown as
"<node_id>: <class> [<param>]", and outputs the selected node's parameter value
as a STRING.

How it reads the graph: the hidden "PROMPT" input gives the full prompt dict
{node_id: {"class_type": str, "inputs": {name: value|link}}}. A widget value is
a literal; a LINKED input is a [src_id, slot] list — those are skipped because
their value isn't resolvable from the static graph alone.
"""
import json


def _iter_prompt_matches(prompt, names):
    """Yield (node_id, class_type, param_name, value) for every node whose inputs
    contain one of `names` as a WIDGET value (not a link)."""
    if not prompt:
        return
    for node_id, node in prompt.items():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict):
            continue
        # Prefer the node's editor Title (_meta.title, written by graphToPrompt);
        # fall back to the class_type when no custom title is present.
        meta = node.get("_meta") or {}
        title = meta.get("title") or node.get("class_type", "?")
        for name in names:
            if name in inputs:
                val = inputs[name]
                # Skip linked inputs: [src_node_id, slot_index].
                if isinstance(val, list) and len(val) == 2 and isinstance(val[0], (str, int)):
                    continue
                yield (str(node_id), title, name, val)


def _label(node_id, title, name):
    return f"{node_id}: {title} [{name}]"


def _stringify(value):
    """Render a parameter value as a clean string (JSON for containers)."""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool):
        return "true" if value else "false"
    return "" if value is None else str(value)


class ParamWatch:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "param_names": ("STRING", {
                    "default": "ckpt_name, unet_name, gguf_name",
                    "tooltip": "Comma-separated widget names to watch across the "
                               "workflow, e.g. 'ckpt_name, unet_name, gguf_name'.",
                }),
                # Populated dynamically by the JS extension with the collected
                # "<id>: <class> [<param>]" labels. Server-side membership check
                # is bypassed via VALIDATE_INPUTS below.
                "selected": (["(run once to populate)"], {
                    "tooltip": "Choose a collected node; its parameter value is "
                               "shown below and sent to the output.",
                }),
                # Serialized mirrors written by the JS extension. A dynamically
                # repopulated COMBO ('selected') does not reliably serialize its
                # value to the backend, so the JS also stores the chosen label and
                # the resolved value here (plain STRINGs always serialize). Both
                # are hidden on the node via the JS extension. Python trusts these
                # first and falls back to PROMPT resolution for headless runs.
                "selected_label": ("STRING", {"default": ""}),
                "resolved_value": ("STRING", {"default": ""}),
            },
            "hidden": {
                "prompt": "PROMPT",          # full workflow graph
                "unique_id": "UNIQUE_ID",    # this node's id (to skip self)
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("value", "all_values", "param_name")
    FUNCTION = "watch"
    CATEGORY = "utils"
    DESCRIPTION = ("Collect a named parameter's value from all nodes in the "
                   "workflow; select one and output its value.")

    # Accept any `selected` value (the dropdown is populated dynamically on the
    # frontend, so the server's combo-membership check must be skipped).
    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def watch(self, param_names, selected, selected_label="", resolved_value="",
              prompt=None, unique_id=None):
        names = [n.strip() for n in param_names.split(",") if n.strip()]
        matches = [
            m for m in _iter_prompt_matches(prompt, names)
            if str(m[0]) != str(unique_id)   # never match ourselves
        ]

        # The effective selection label: trust the JS-serialized `selected_label`
        # first (a dynamically-populated COMBO doesn't reliably serialize its own
        # value), then fall back to the COMBO `selected`.
        sel = selected_label or selected

        # Resolve the label "<id>: <title> [<param>]" against the PROMPT graph:
        # match the full label, else fall back to the leading node id.
        value = ""
        chosen = None
        if sel and matches:
            for (nid, title, name, val) in matches:
                if _label(nid, title, name) == sel:
                    chosen = (nid, title, name, val)
                    break
            if chosen is None and ":" in sel:
                sel_id = sel.split(":", 1)[0].strip()
                for m in matches:
                    if m[0] == sel_id:
                        chosen = m
                        break

        # `value`: the selected node's parameter value.
        # `param_name`: which watched name that node matched on.
        out = ""
        param_name = ""
        if chosen is not None:
            out = _stringify(chosen[3])
            param_name = chosen[2]
        elif resolved_value:
            # Graph resolution failed (e.g. the selected node was pruned from the
            # executed prompt) but the frontend captured a value — use it so the
            # output still matches what the node displays.
            out = resolved_value

        # `all_values`: every collected value, one per line, each prefixed with
        # its label so the origin is unambiguous.
        all_lines = [f"{_label(nid, title, name)} = {_stringify(val)}"
                     for (nid, title, name, val) in matches]
        all_values = "\n".join(all_lines)

        # UI payload: the collected labels (for the dropdown) + a display string.
        labels = [_label(nid, title, name) for (nid, title, name, _v) in matches]
        display = (f"{selected}\n= {out}" if chosen is not None
                   else f"{len(matches)} node(s) collected for "
                        f"[{', '.join(names)}]. Pick one.")
        return {
            "ui": {"paramwatch_options": labels, "paramwatch_display": [display]},
            "result": (out, all_values, param_name),
        }


NODE_CLASS_MAPPINGS = {"ParamWatch": ParamWatch}
NODE_DISPLAY_NAME_MAPPINGS = {"ParamWatch": "Param Watch"}
