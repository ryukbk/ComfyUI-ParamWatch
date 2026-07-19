// Unit test for the AUTHORITATIVE scan path: matchesFromPromptOutput mirrors the
// JS logic in paramwatch.js (kept in sync by hand) and must agree with Python's
// _iter_prompt_matches. graphToPrompt has already flattened subgraphs and
// resolved every promotion (proxyWidgets / promoted / boundary link) to a
// literal keyed by composite execId, so a subgraph-fed unet_name arrives here
// as a plain string on the inner node.
const LINKED_UNRESOLVED = "(from linked node)";
function isPromptLink(val){
  return Array.isArray(val) && val.length===2 &&
    (typeof val[0]==="string"||typeof val[0]==="number") && typeof val[1]==="number";
}
function matchesFromPromptOutput(output, names, selfId){
  const labels=[], valueByLabel={};
  if(!output||typeof output!=="object") return {labels,valueByLabel};
  const self=String(selfId);
  for(const [execId,entry] of Object.entries(output)){
    if(!entry||typeof entry!=="object") continue;
    if(execId===self||execId.endsWith(":"+self)) continue;
    const inputs=entry.inputs;
    if(!inputs||typeof inputs!=="object") continue;
    const title=entry._meta?.title||entry.class_type||"?";
    for(const name of names){
      if(!(name in inputs)) continue;
      let val=inputs[name];
      if(isPromptLink(val)) val=LINKED_UNRESOLVED;
      else if(val&&typeof val==="object"&&"__value__" in val) val=val.__value__;
      const label=`${execId}: ${title} [${name}]`;
      labels.push(label); valueByLabel[label]=val;
    }
  }
  return {labels,valueByLabel};
}

// Flattened prompt as graphToPrompt would emit for a workflow where a subgraph
// (node 2) contains a Load Diffusion Model (inner id 4) whose unet_name is fed
// from the subgraph's widget/input — resolved to a literal at "2:4".
const output = {
  "1":   { class_type:"CheckpointLoaderSimple", _meta:{title:"Root"}, inputs:{ ckpt_name:"root.safetensors" } },
  "2:4": { class_type:"UNETLoader", _meta:{title:"Load Diffusion Model"}, inputs:{ unet_name:"subgraph_set.safetensors", weight_dtype:"default" } },
  "5":   { class_type:"KSampler", _meta:{title:"KSampler"}, inputs:{ seed:12345, model:["2:4",0] } }, // genuine node link
  "9":   { class_type:"ParamWatch", _meta:{title:"PW"}, inputs:{} },
};
const { labels, valueByLabel } = matchesFromPromptOutput(output, ["ckpt_name","unet_name","model"], "9");
console.log("labels:\n"+labels.map(l=>"  "+l).join("\n"));
console.log("values:", JSON.stringify(valueByLabel));

let ok = true;
ok = ok && valueByLabel["2:4: Load Diffusion Model [unet_name]"]==="subgraph_set.safetensors";
ok = ok && valueByLabel["1: Root [ckpt_name]"]==="root.safetensors";
ok = ok && valueByLabel["5: KSampler [model]"]===LINKED_UNRESOLVED; // real node link stays a marker
ok = ok && !labels.some(l=>l.startsWith("9:")); // self excluded
console.log(ok ? "\nPASS (subgraph-fed unet_name resolved via graphToPrompt; real link marked; self excluded)" : "\nFAIL");
process.exit(ok?0:1);
