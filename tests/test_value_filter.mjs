// Unit test for the value-filter logic (mirrors filteredLabels in paramwatch.js).
// The filter narrows the dropdown to labels whose RESOLVED VALUE contains the
// query (case-insensitive); empty query shows all; missing value falls back to
// matching the label text.
const LINKED_UNRESOLVED = "(from linked node)";
function filteredLabels(allLabels, valueByLabel, rawFilter) {
  const q = String(rawFilter ?? "").trim().toLowerCase();
  if (!q) return allLabels;
  return allLabels.filter((lbl) => {
    const v = valueByLabel[lbl];
    const hasValue = v !== undefined && v !== null && v !== LINKED_UNRESOLVED;
    const hay = (hasValue ? String(v) : lbl).toLowerCase();
    return hay.includes(q);
  });
}

const labels = [
  "1: Root [ckpt_name]",
  "2:4: Load Diffusion Model [unet_name]",
  "5: KSampler [sampler_name]",
  "7: GGUF [gguf_name]",
];
const valueByLabel = {
  "1: Root [ckpt_name]": "sd_xl_base_1.0.safetensors",
  "2:4: Load Diffusion Model [unet_name]": "0.3(V08_V08a) + 0.7(BracingEvoMix_v1).safetensors",
  "5: KSampler [sampler_name]": "euler",
  "7: GGUF [gguf_name]": LINKED_UNRESOLVED,
};

let ok = true;
// empty filter -> all
ok = ok && filteredLabels(labels, valueByLabel, "").length === 4;
// substring on value, case-insensitive
ok = ok && JSON.stringify(filteredLabels(labels, valueByLabel, "EVOMIX")) ===
  JSON.stringify(["2:4: Load Diffusion Model [unet_name]"]);
// matches multiple by common ".safetensors"
ok = ok && filteredLabels(labels, valueByLabel, ".safetensors").length === 2;
// value "euler"
ok = ok && JSON.stringify(filteredLabels(labels, valueByLabel, "euler")) ===
  JSON.stringify(["5: KSampler [sampler_name]"]);
// no value match -> empty
ok = ok && filteredLabels(labels, valueByLabel, "zzz-nope").length === 0;
// unresolved entry: falls back to matching label text (find by param name)
ok = ok && JSON.stringify(filteredLabels(labels, valueByLabel, "gguf_name")) ===
  JSON.stringify(["7: GGUF [gguf_name]"]);
// whitespace-only filter treated as empty
ok = ok && filteredLabels(labels, valueByLabel, "   ").length === 4;

console.log(ok ? "PASS (value filter: substring, case-insensitive, empty, no-match, label-fallback)" : "FAIL");
process.exit(ok ? 0 : 1);
