// Mock-graph unit test for ParamWatch's frontend scan. Mirrors the logic in
// web/paramwatch.js (kept in sync by hand; the real module imports ComfyUI's
// app.js and can't be loaded standalone). Covers:
//   - root + nested + deep-nested subgraph nodes with composite exec ids
//   - subgraph CONTAINER nodes are recursed into, never emitted as matches
//   - link-fed params: followed through Reroute to a Constant
//   - link-fed params across a SUBGRAPH INPUT boundary (promoted widget)
//   - link-fed params across a boundary wired to an EXTERNAL upstream constant
//   - genuinely computed link: listed but marked "(from linked node)"
const app = { graph: null };
const LINKED_UNRESOLVED = "(from linked node)";
const SUBGRAPH_INPUT_ID = -10;

function getNodesOf(graph){ if(!graph) return []; return graph._nodes||graph.nodes||[]; }
function getSubgraphOf(n){
  if(!n) return null;
  if(typeof n.isSubgraphNode==="function") return n.isSubgraphNode()?(n.subgraph||n.subGraph||null):null;
  return n.subgraph||n.subGraph||null;
}
function getRootGraph(graph){
  let g=graph||app.graph;
  for(let i=0;g&&i<64;i++){
    const pn=g._subgraph_node||g.subgraphNode||null;
    const parent=(pn&&pn.graph)||g.parentGraph||g._parent||null;
    if(!parent||parent===g) break; g=parent;
  }
  return g||app.graph;
}
function collectAllNodes(rootGraph){
  const out=[]; const containerOfGraph=new Map();
  const walk=(graph,prefix,depth)=>{
    if(!graph||depth>20) return;
    for(const n of getNodesOf(graph)){
      const execId=prefix?`${prefix}:${n.id}`:String(n.id);
      const sub=getSubgraphOf(n);
      if(sub){ containerOfGraph.set(sub,n); walk(sub,execId,depth+1); }
      else out.push({node:n,execId});
    }
  };
  walk(rootGraph,"",0);
  return {nodes:out, containerOfGraph};
}
function isSubgraphInputOrigin(o){ return o===SUBGRAPH_INPUT_ID||o===String(SUBGRAPH_INPUT_ID); }
function getLink(graph,linkId){ if(!graph||linkId==null) return null; return graph.links?.[linkId] ?? graph.getLink?.(linkId) ?? null; }
function isReadableScalar(v){ const t=typeof v; return t==="string"||t==="number"||t==="boolean"; }
function readPromotedWidgetValue(container,cin){
  const candidates=[];
  if(cin._widget) candidates.push(cin._widget);
  if(container.widgets){
    const wid=cin.widgetId;
    if(wid!=null){ const byId=container.widgets.find(w=>w&&w.widgetId===wid); if(byId) candidates.push(byId); }
    const byName=container.widgets.find(w=>w&&(w.name===cin.name||w.name===cin.label)); if(byName) candidates.push(byName);
  }
  for(const w of candidates){ if(isReadableScalar(w?.value)) return {ok:true,value:w.value}; }
  return {ok:false};
}
function getContainerNode(graph,containerOfGraph){
  if(!graph) return null;
  const mapped=containerOfGraph?.get?.(graph); if(mapped) return mapped;
  return graph._subgraph_node||graph.subgraphNode||null;
}
function resolveLinkedRaw(node,inputName,containerOfGraph){
  let curNode=node, curName=inputName; const seen=new Set();
  for(let bh=0;bh<64;bh++){
    const graph=curNode.graph; if(!graph) return {ok:false};
    const input=curNode.inputs?.find(i=>i.name===curName);
    if(!input||input.link==null) return {ok:false};
    let linkId=input.link, crossed=false;
    for(let h=0;h<64;h++){
      if(linkId==null||seen.has(linkId)) return {ok:false};
      seen.add(linkId);
      const link=getLink(graph,linkId); if(!link) return {ok:false};
      if(isSubgraphInputOrigin(link.origin_id)){
        const container=getContainerNode(graph,containerOfGraph); if(!container) return {ok:false};
        const cin=container.inputs?.[link.origin_slot]; if(!cin) return {ok:false};
        if(cin.link!=null){ curNode=container; curName=cin.name; crossed=true; break; }
        return readPromotedWidgetValue(container,cin);
      }
      const src=graph.getNodeById?.(link.origin_id); if(!src) return {ok:false};
      const isReroute=src.type==="Reroute"||src.comfyClass==="Reroute";
      if(isReroute&&src.inputs?.[0]?.link!=null){ linkId=src.inputs[0].link; continue; }
      const w=src.widgets?.find(x=>x.name==="value")??src.widgets?.find(x=>x.name===curName)??(src.widgets?.length===1?src.widgets[0]:null);
      if(w!=null&&isReadableScalar(w.value)) return {ok:true,value:w.value};
      return {ok:false};
    }
    if(!crossed) return {ok:false};
  }
  return {ok:false};
}
function scanGraph(node,names){
  const labels=[],valueByLabel={};
  if(!names.length) return {labels,valueByLabel};
  const root=getRootGraph(node.graph||app.graph);
  const {nodes,containerOfGraph}=collectAllNodes(root);
  for(const {node:other,execId} of nodes){
    if(other===node) continue;
    if(!other.widgets) continue;
    const title=other.title||other.comfyClass||other.type||"?";
    for(const name of names){
      const w=other.widgets.find(w=>w.name===name);
      const asInput=other.inputs?.find(i=>i.name===name);
      if(!w&&!asInput) continue;
      const label=`${execId}: ${title} [${name}]`;
      let value;
      if(asInput&&asInput.link!=null){ const r=resolveLinkedRaw(other,name,containerOfGraph); value=r.ok?r.value:LINKED_UNRESOLVED; }
      else if(w){ value=w.value; }
      else continue;
      labels.push(label); valueByLabel[label]=value;
    }
  }
  return {labels,valueByLabel};
}

// ---- Fixtures --------------------------------------------------------------
function ckpt(id,title,val){ return {id,title,widgets:[{name:"ckpt_name",value:val}],inputs:[]}; }

// Deep-nested subgraph (unet_name as widget).
const deepLoader = ckpt(7,"Deep","deep.safetensors");
const innerSubgraphDef = { _nodes:[deepLoader] };
const innerSubNode = { id:5, title:"InnerSub", widgets:[], inputs:[], isSubgraphNode:()=>true, subgraph:innerSubgraphDef };
const nestedLoader = ckpt(3,"Nested","nested.safetensors");

// --- Subgraph BOUNDARY case (the reported bug) ------------------------------
// Inside subgraph #2: a Load Diffusion Model (id 4) whose unet_name is fed by
// the subgraph's INPUT boundary (origin_id === SUBGRAPH_INPUT_ID). The value is
// a PROMOTED widget on the container node (id 2), slot 0.
const boundaryLoaderPromoted = {
  id:4, title:"UnetPromoted",
  widgets:[],
  inputs:[{name:"unet_name", link:410}],
  graph:null,
};
// Inside subgraph #2: another loader (id 6) whose unet_name boundary is wired to
// an EXTERNAL constant in the root graph (container input slot 1 has a link).
const boundaryLoaderExternal = {
  id:6, title:"UnetExternal",
  widgets:[],
  inputs:[{name:"unet_name", link:411}],
  graph:null,
};

const subgraphDef = {
  _nodes:[nestedLoader, innerSubNode, boundaryLoaderPromoted, boundaryLoaderExternal],
  // Links INSIDE the subgraph originate from the boundary input node (-10).
  links:{ 410:{origin_id:SUBGRAPH_INPUT_ID, origin_slot:0},
          411:{origin_id:SUBGRAPH_INPUT_ID, origin_slot:1} },
  getNodeById(id){ return this._nodes.find(n=>n.id===id)||null; },
};
// Container node id 2: input slot 0 = promoted widget (value on container),
// slot 1 = wired to external StrConst (id 40) via link 401 in the root graph.
const subNode = {
  id:2, title:"MySub", isSubgraphNode:()=>true, subgraph:subgraphDef,
  widgets:[{name:"unet_name", widgetId:"wq", value:"promoted.safetensors"}],
  inputs:[
    { name:"unet_name", link:null, widgetId:"wq" },       // slot 0: promoted widget
    { name:"unet_name_ext", link:401 },                    // slot 1: external link
  ],
  graph:null,
};

const rootLoader = ckpt(1,"Root","root.safetensors");
const extConst = { id:40, title:"ExtConst", widgets:[{name:"value",value:"external.safetensors"}], inputs:[], graph:null };

// Root-level link-fed params (from earlier test).
const strConst = { id:20, title:"StrConst", widgets:[{name:"value",value:"linked.safetensors"}], inputs:[], graph:null };
const reroute = { id:21, title:"RR", type:"Reroute", widgets:[], inputs:[{name:"",link:200}], graph:null };
const linkedLoader = { id:10, title:"LinkedLoader", widgets:[], inputs:[{name:"ckpt_name",link:201}], graph:null };
const computeNode = { id:30, title:"Compute", widgets:[], inputs:[{name:"in",link:null}], graph:null };
const computedLoader = { id:11, title:"ComputedLoader", widgets:[], inputs:[{name:"ckpt_name",link:202}], graph:null };

const paramWatch = { id:9, title:"PW", widgets:[], inputs:[], graph:null };
const rootGraph = {
  _nodes:[rootLoader, subNode, strConst, reroute, linkedLoader, computeNode, computedLoader, extConst, paramWatch],
  links:{ 200:{origin_id:20}, 201:{origin_id:21}, 202:{origin_id:30},
          401:{origin_id:40, origin_slot:0} },
  getNodeById(id){ return this._nodes.find(n=>n.id===id)||null; },
};
for(const n of rootGraph._nodes) n.graph = rootGraph;
for(const n of subgraphDef._nodes) n.graph = subgraphDef;

// ---- Run -------------------------------------------------------------------
const {labels,valueByLabel} = scanGraph(paramWatch,["ckpt_name","unet_name"]);
console.log("labels:\n"+labels.map(l=>"  "+l).join("\n"));
console.log("\nvalues:", JSON.stringify(valueByLabel,null,0));

const expect = [
  "1: Root [ckpt_name]",
  "2:3: Nested [ckpt_name]",
  "2:5:7: Deep [ckpt_name]",
  "2:4: UnetPromoted [unet_name]",
  "2:6: UnetExternal [unet_name]",
  "10: LinkedLoader [ckpt_name]",
  "11: ComputedLoader [ckpt_name]",
];
let ok = expect.every(e=>labels.includes(e)) && labels.length===expect.length;
ok = ok && !labels.some(l=>l.includes("MySub")||l.includes("InnerSub"));
// subgraph boundary → promoted widget on the container.
ok = ok && valueByLabel["2:4: UnetPromoted [unet_name]"]==="promoted.safetensors";
// subgraph boundary → container input wired to an external constant.
ok = ok && valueByLabel["2:6: UnetExternal [unet_name]"]==="external.safetensors";
// plain link through Reroute → constant.
ok = ok && valueByLabel["10: LinkedLoader [ckpt_name]"]==="linked.safetensors";
// genuinely computed → marker.
ok = ok && valueByLabel["11: ComputedLoader [ckpt_name]"]===LINKED_UNRESOLVED;

console.log(ok
  ? "\nPASS (subgraph nesting + boundary promoted-widget + boundary external-link + reroute-const + unresolved)"
  : "\nFAIL");
process.exit(ok?0:1);
