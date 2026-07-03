const app = { graph: null };
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
  const out=[];
  const walk=(graph,prefix,depth)=>{
    if(!graph||depth>20) return;
    for(const n of getNodesOf(graph)){
      const execId=prefix?`${prefix}:${n.id}`:String(n.id);
      const sub=getSubgraphOf(n);
      if(sub) walk(sub,execId,depth+1);
      else out.push({node:n,execId});
    }
  };
  walk(rootGraph,"",0);
  return out;
}
function scanGraph(node,names){
  const labels=[],valueByLabel={};
  if(!names.length) return {labels,valueByLabel};
  const root=getRootGraph(node.graph||app.graph);
  for(const {node:other,execId} of collectAllNodes(root)){
    if(other===node) continue;
    if(!other.widgets) continue;
    const title=other.title||other.comfyClass||other.type||"?";
    for(const name of names){
      const w=other.widgets.find(w=>w.name===name); if(!w) continue;
      const asInput=other.inputs?.find(i=>i.name===name&&i.link!=null); if(asInput) continue;
      const label=`${execId}: ${title} [${name}]`;
      labels.push(label); valueByLabel[label]=w.value;
    }
  }
  return {labels,valueByLabel};
}
function ckpt(id,title,val){ return {id,title,widgets:[{name:"ckpt_name",value:val}],inputs:[]}; }
const deepLoader = ckpt(7,"Deep","deep.safetensors");
const innerSubgraphDef = { _nodes:[deepLoader] };
const innerSubNode = { id:5, title:"InnerSub", widgets:[], inputs:[], isSubgraphNode:()=>true, subgraph:innerSubgraphDef };
const nestedLoader = ckpt(3,"Nested","nested.safetensors");
const subgraphDef = { _nodes:[nestedLoader, innerSubNode] };
const subNode = { id:2, title:"MySub", widgets:[], inputs:[], isSubgraphNode:()=>true, subgraph:subgraphDef };
const rootLoader = ckpt(1,"Root","root.safetensors");
const paramWatch = { id:9, title:"PW", widgets:[], inputs:[], graph:null };
const rootGraph = { _nodes:[rootLoader, subNode, paramWatch] };
rootLoader.graph = subNode.graph = paramWatch.graph = rootGraph;
const {labels,valueByLabel} = scanGraph(paramWatch,["ckpt_name"]);
console.log("labels:\n"+labels.map(l=>"  "+l).join("\n"));
const expect = ["1: Root [ckpt_name]","2:3: Nested [ckpt_name]","2:5:7: Deep [ckpt_name]"];
let ok = expect.every(e=>labels.includes(e)) && labels.length===expect.length;
ok = ok && !labels.some(l=>l.includes("MySub")||l.includes("InnerSub"));
console.log("\nvalues:", JSON.stringify(valueByLabel));
console.log(ok ? "\nPASS (root + nested + deep-nested found with composite ids; containers skipped)" : "\nFAIL");
process.exit(ok?0:1);
