// Reconstruct the live litegraph structure from ~/Downloads/param_watch_test.json:
// subgraph (node 2) contains UNETLoader (id 1) whose unet_name is a PROMOTED
// widget — retained on the inner node (widgets_values) AND linked to boundary -10.
const LINKED_UNRESOLVED = "(from linked node)";
const SUBGRAPH_INPUT_ID = -10;
function getNodesOf(g){ if(!g) return []; return g._nodes||g.nodes||[]; }
function getSubgraphOf(n){ if(!n) return null; if(typeof n.isSubgraphNode==="function") return n.isSubgraphNode()?(n.subgraph||null):null; return n.subgraph||null; }
function getRootGraph(g){ return g; }
function collectAllNodes(root){ const out=[],c=new Map(); const walk=(g,p,d)=>{ if(!g||d>20)return; for(const n of getNodesOf(g)){ const e=p?`${p}:${n.id}`:String(n.id); const s=getSubgraphOf(n); if(s){c.set(s,n);walk(s,e,d+1);} else out.push({node:n,execId:e}); } }; walk(root,"",0); return {nodes:out,containerOfGraph:c}; }
function isReadableScalar(v){ const t=typeof v; return t==="string"||t==="number"||t==="boolean"; }
function isSubgraphInputOrigin(o){ return o===SUBGRAPH_INPUT_ID||o===String(SUBGRAPH_INPUT_ID); }
function getLink(g,id){ if(!g||id==null)return null; return g.links?.[id]??g.getLink?.(id)??null; }
function getContainerNode(g,c){ if(!g)return null; return c?.get?.(g)||g._subgraph_node||null; }
function readPromotedWidgetValue(container,cin){
  const cand=[]; if(cin._widget)cand.push(cin._widget);
  if(container.widgets){ const wid=cin.widgetId; if(wid!=null){const b=container.widgets.find(w=>w&&w.widgetId===wid); if(b)cand.push(b);} const bn=container.widgets.find(w=>w&&(w.name===cin.name||w.name===cin.label)); if(bn)cand.push(bn); }
  for(const w of cand){ if(isReadableScalar(w?.value)) return {ok:true,value:w.value}; }
  return {ok:false};
}
function resolveLinkedRaw(node,inputName,c){
  let cur=node,nm=inputName; const seen=new Set();
  for(let bh=0;bh<64;bh++){ const g=cur.graph; if(!g)return{ok:false}; const inp=cur.inputs?.find(i=>i.name===nm); if(!inp||inp.link==null)return{ok:false}; let lid=inp.link,crossed=false;
    for(let h=0;h<64;h++){ if(lid==null||seen.has(lid))return{ok:false}; seen.add(lid); const link=getLink(g,lid); if(!link)return{ok:false};
      if(isSubgraphInputOrigin(link.origin_id)){ const cont=getContainerNode(g,c); if(!cont)return{ok:false}; const cin=cont.inputs?.[link.origin_slot]; if(!cin)return{ok:false}; if(cin.link!=null){cur=cont;nm=cin.name;crossed=true;break;} return readPromotedWidgetValue(cont,cin); }
      const src=g.getNodeById?.(link.origin_id); if(!src)return{ok:false};
      const rr=src.type==="Reroute"; if(rr&&src.inputs?.[0]?.link!=null){lid=src.inputs[0].link;continue;}
      const w=src.widgets?.find(x=>x.name==="value")??src.widgets?.find(x=>x.name===nm)??(src.widgets?.length===1?src.widgets[0]:null);
      if(w!=null&&isReadableScalar(w.value))return{ok:true,value:w.value}; return{ok:false}; }
    if(!crossed)return{ok:false}; }
  return{ok:false};
}
function scanGraph(node,names,root){
  const labels=[],valueByLabel={}; const {nodes,containerOfGraph}=collectAllNodes(root);
  for(const {node:other,execId} of nodes){ if(other===node)continue; const title=other.title||other.type||"?";
    for(const name of names){ const w=other.widgets?.find(w=>w.name===name); const asInput=other.inputs?.find(i=>i.name===name); if(!w&&!asInput)continue;
      const label=`${execId}: ${title} [${name}]`; let value;
      if(w&&isReadableScalar(w.value)) value=w.value;
      else if(asInput&&asInput.link!=null){ const r=resolveLinkedRaw(other,name,containerOfGraph); value=r.ok?r.value:LINKED_UNRESOLVED; }
      else if(w) value=w.value; else continue;
      labels.push(label); valueByLabel[label]=value; } }
  return {labels,valueByLabel};
}

// --- Build the real structure ---
const innerUnet = {
  id:1, type:"UNETLoader",
  widgets:[{name:"unet_name",value:"0.3(V08_V08a) + 0.7(BracingEvoMix_v1).safetensors"},{name:"weight_dtype",value:"default"}],
  inputs:[{name:"unet_name",link:3},{name:"weight_dtype",link:null}],
  graph:null,
};
const subgraphDef = {
  _nodes:[innerUnet],
  links:{ 3:{origin_id:-10, origin_slot:0} },
  getNodeById(id){ return this._nodes.find(n=>n.id===id)||null; },
};
const container = {
  id:2, isSubgraphNode:()=>true, subgraph:subgraphDef,
  widgets:[],                                            // container has NO value (widgets_values: [])
  inputs:[{name:"unet_name", link:null}],                // proxyWidget, no widgetId, no link
  graph:null,
};
const paramWatch = { id:4, type:"ParamWatch", widgets:[], inputs:[], graph:null };
const root = { _nodes:[container, paramWatch], links:{}, getNodeById(id){return this._nodes.find(n=>n.id===id)||null;} };
container.graph = paramWatch.graph = root;
innerUnet.graph = subgraphDef;

const { labels, valueByLabel } = scanGraph(paramWatch, ["ckpt_name","unet_name","gguf_name"], root);
console.log("labels:", labels);
console.log("values:", JSON.stringify(valueByLabel));
const got = valueByLabel["2:1: UNETLoader [unet_name]"];
console.log("\nunet_name resolved to:", JSON.stringify(got));

// --- merge-guard: async graphToPrompt must NOT downgrade a good live value ---
function mergeScans(live, viaPrompt){
  const bad=(v)=>v==null||v===""||v===LINKED_UNRESOLVED;
  const valueByLabel={...live.valueByLabel}; const labels=[...live.labels];
  for(const lbl of viaPrompt.labels){ const pv=viaPrompt.valueByLabel[lbl];
    if(!(lbl in valueByLabel)){ labels.push(lbl); valueByLabel[lbl]=pv; }
    else if(bad(valueByLabel[lbl])&&!bad(pv)){ valueByLabel[lbl]=pv; } }
  return {labels,valueByLabel};
}
const liveScan = { labels:["2:1: UNETLoader [unet_name]"],
  valueByLabel:{"2:1: UNETLoader [unet_name]":"0.3(V08_V08a) + 0.7(BracingEvoMix_v1).safetensors"} };
// Hypothetical bad prompt pass that resolved the promoted input to a marker.
const badPrompt = { labels:["2:1: UNETLoader [unet_name]"],
  valueByLabel:{"2:1: UNETLoader [unet_name]":LINKED_UNRESOLVED} };
const merged = mergeScans(liveScan, badPrompt);
const mok = merged.valueByLabel["2:1: UNETLoader [unet_name]"]==="0.3(V08_V08a) + 0.7(BracingEvoMix_v1).safetensors";
// And a good prompt pass that ADDS a new label is unioned in.
const addPrompt = { labels:["7: CkptLoader [ckpt_name]"], valueByLabel:{"7: CkptLoader [ckpt_name]":"x.ckpt"} };
const merged2 = mergeScans(liveScan, addPrompt);
const mok2 = merged2.labels.includes("7: CkptLoader [ckpt_name]") && merged2.valueByLabel["7: CkptLoader [ckpt_name]"]==="x.ckpt";
console.log("merge-guard (no downgrade):", mok, "| union new label:", mok2);
if(!(mok&&mok2)){ console.log("MERGE FAIL"); process.exit(1); }
console.log("MERGE PASS");

const ok = got === "0.3(V08_V08a) + 0.7(BracingEvoMix_v1).safetensors";
console.log(ok ? "PASS (retained inner widget value read directly)" : "FAIL");
process.exit(ok?0:1);
