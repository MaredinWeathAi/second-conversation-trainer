/* ============================================================
   RUNTIME
   ============================================================ */
"use strict";
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const on=(s,e,f)=>{const el=$(s);if(el)el.addEventListener(e,f);return el};
const words=s=>(String(s).trim().match(/\S+/g)||[]).length;

let SAMPLE=null,SERVER=false,HAS_TTS=false,NEEDKEY=false,RUNS=[],R=null,LAST=null,busy=false;
const KEYLS="sct.key.v1";
const getKey=()=>{try{return localStorage.getItem(KEYLS)||""}catch(e){return""}};
const setKey=v=>{try{v?localStorage.setItem(KEYLS,v):localStorage.removeItem(KEYLS)}catch(e){}};
const TKEYLS="sct.ttskey.v1";
const getTtsKey=()=>{try{return localStorage.getItem(TKEYLS)||""}catch(e){return""}};
const setTtsKey=v=>{try{v?localStorage.setItem(TKEYLS,v):localStorage.removeItem(TKEYLS)}catch(e){}};
const chatHeaders=()=>{const h={"content-type":"application/json"},k=getKey();if(k)h["x-user-key"]=k;return h};
const pref=(k,d)=>{try{return localStorage.getItem("sct."+k)||d}catch(e){return d}};
const setPref=(k,v)=>{try{localStorage.setItem("sct."+k,v)}catch(e){}};

const LEVELS={
 warm:{k:"warm",label:"Warm",guard:30,traps:1,desc:"Forthcoming. One trap. Accepts coffee if you ask cleanly."},
 normal:{k:"normal",label:"Normal",guard:45,traps:1,desc:"Polite, a little guarded. One trap, and one bad move costs you."},
 guarded:{k:"guarded",label:"Guarded",guard:58,traps:2,desc:"Busy, been pitched. Two traps, and they will walk."},
 hostile:{k:"hostile",label:"Hostile",guard:70,traps:2,desc:"Short window, low patience, leaves the moment you sell."}
};
/* Adaptive ladder. Scored-by-model runs only — a heuristic fallback score is not evidence. */
function level(){
  const p=pref("level","adaptive");
  if(p!=="adaptive") return LEVELS[p]||LEVELS.normal;
  const d=RUNS.filter(r=>r.total!=null&&r.scoredBy!=="heuristic").slice(0,5);
  if(d.length<3) return LEVELS.warm;
  const avg=d.reduce((a,r)=>a+r.total,0)/d.length;
  return avg<30?LEVELS.warm:avg<42?LEVELS.normal:avg<50?LEVELS.guarded:LEVELS.hostile;
}
/* Guard moves mechanically. The prospect is told the number; it does not invent it. */
const GUARD_UP={product:18,advice:16,pitch:16,banned:18,took_bait:14,overtalk:10,interview:10,early_bridge:12};
function bumpGuard(flag,newGoals,run){
  const r=run||R; if(!r) return;
  let g=r.guard;
  const up=GUARD_UP[flag]||0;
  g+=up*(r.level.k==="guarded"||r.level.k==="hostile"?1.4:1);
  (newGoals||[]).forEach(n=>{ if(n===2||n===3||n===4) g-=10; else if(n===5||n===6) g-=4 });
  r.guard=clamp(Math.round(g),0,100);
}
/* Coffee is not available for the asking. Two questions is not enough — recognition is the price. */
function acceptAllowed(){
  if(!R) return false;
  if(R.slips>=2) return false;
  if(R.guard>=70) return false;
  return R.goals.includes(2)&&R.goals.includes(3)&&(R.goals.includes(4)||R.cueGiven);
}
/* Deterministic exits. The prospect does not decide these; we do. */
function leaveNow(){
  if(!R) return false;
  if(R.guard>=80) return true;
  if(R.slips>=3) return true;
  if(R.m.turns>=14) return true;
  if(R.opened&&R.m.hisSec>R.setting.window&&!R.accepted) return true;
  if(R.accepted&&R.m.hisSec>R.setting.window+45) return true;
  return false;
}

/* ---------- casting ---------- */
const NAMES={
 cuban:{m:["Jorge","Carlos","Luis","Alberto","Orlando","Roberto","Armando","Manny","Rafael","Ernesto"],
        f:["Maritza","Vivian","Isabel","Lourdes","Yolanda","Marta","Elena","Miriam","Ileana","Odalys"]},
 latam:{m:["Andres","Juan Carlos","Camilo","Felipe","Mauricio","Alejandro","Leonardo","Gustavo"],
        f:["Paola","Catalina","Natalia","Claudia","Adriana","Mariana","Veronica","Carolina"]},
 anglo:{m:["Bill","Tom","Rich","Jeff","Scott","Doug","Greg","Chuck"],
        f:["Susan","Karen","Linda","Nancy","Patricia","Cindy","Beth"]},
 northeast:{m:["Frank","Anthony","Mike","Joe","Steve","Marc","Howard","Marty","Vinny"],
        f:["Debbie","Lori","Sheryl","Renee","Joanne","Ellen","Lisa","Donna"]}
};
const ORIGIN={
 cuban:["Cuban-American, grew up in Hialeah.","Miami cadence, quick and clipped, slightly Spanish-influenced vowels."],
 latam:["Born in Bogota, twenty years in Miami.","Fluent American English with a soft Spanish rhythm, measured pace."],
 anglo:["Raised in South Florida.","General American, relaxed, unhurried."],
 northeast:["From Long Island, moved down in his thirties.","Brisk New York register, dry, warm underneath."]
};
const WORK=[
 ["owns a commercial HVAC company",.10],["owns a few dental practices",.35],["runs a logistics company",.15],
 ["owns a distribution business",.20],["is a physician",.35],["owns a construction firm",.10],
 ["runs a staffing company",.45],["is a corporate executive",.35],["owns commercial real estate",.15],
 ["founded a software company",.15],["is an attorney",.40],["is a retired executive",.30],
 ["owns a printing business",.25],["runs a restaurant group",.25],["is an orthodontist",.30]
];
function cast(){
  const w=WORK[Math.floor(Math.random()*WORK.length)];
  const mix=pref("mix","real");
  let p=w[1]; if(mix==="even")p=.5; else if(mix==="men")p=0; else if(mix==="women")p=1;
  const woman=Math.random()<p;
  const buckets=["cuban","cuban","latam","anglo","northeast"];
  const b=buckets[Math.floor(Math.random()*buckets.length)];
  const pool=NAMES[b][woman?"f":"m"];
  let recent=[]; try{recent=JSON.parse(localStorage.getItem("sct.names")||"[]")}catch(e){}
  const fresh=pool.filter(n=>recent.indexOf(n)<0);
  const src=fresh.length?fresh:pool;
  const name=src[Math.floor(Math.random()*src.length)];
  try{localStorage.setItem("sct.names",JSON.stringify([name,...recent].slice(0,6)))}catch(e){}
  const age=44+Math.floor(Math.random()*26);
  return {name,woman,sex:woman?"woman":"man",age,bucket:b,work:w[0],
    blurb:ORIGIN[b][0]+" "+(woman?"She":"He")+" "+w[0]+".",
    accent:ORIGIN[b][1]};
}

/* ---------- client-side move detection ---------- */
const hitAny=(re,t)=>re.some(r=>r.test(t));
function bannedHits(t){const o=[];BANNED.forEach(p=>{const m=t.match(p[0]);if(m)o.push({label:p[1],quote:m[0]})});return o}
/* Regex is a tie-breaker, not the judge. Goal 1 and goal 4 are LLM-only —
   positioning and recognition cannot be pattern-matched without rewarding a script.
   Nothing at all counts until they have actually handed over the opening. */
function detectGoals(t,st){
  const g=[];
  if(!st.opened) return g;
  if(!st.goals.includes(2)&&hitAny(WHYNOW,t)) g.push(2);
  if(!st.goals.includes(3)&&hitAny(BUCKETQ,t)) g.push(3);
  if(!st.goals.includes(5)&&hitAny(BRIDGE,t)) g.push(5);
  if((st.accepted||st.goals.includes(5))&&!st.goals.includes(6)&&hitAny(CAPTURE,t)) g.push(6);
  return g;
}
function commandOf(t){
  const s=String(t).trim();
  for(const c of COMMANDS){ if(c[0].test(s)) return c[1] }
  return null;
}

/* ---------- run lifecycle ---------- */
function startRun(setting,trigger){
  const S=setting||SETTINGS[Math.floor(Math.random()*SETTINGS.length)];
  const T=trigger||TRIGGERS[Math.floor(Math.random()*TRIGGERS.length)];
  const L=level();
  R={id:"r"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),ts:Date.now(),
    live:true,startedAt:Date.now(),setting:S,trigger:T,cast:cast(),level:L,
    turns:[],goals:[],cueGiven:false,cueTurn:null,bridgeTurn:null,accepted:false,slips:0,
    opened:false,scene:null,trapAsked:false,lastFlag:null,fellBack:0,systemMs:0,detTurns:{},longTurns:0,
    guard:L.guard,feedback:[],cost:0,ttsCost:0,
    m:{turns:0,hits:[],talkShare:0,advisorWords:0,prospectWords:0,avgTurnWords:0,maxTurnWords:0,durationSec:0,hisSec:0}};
  LAST={setting:S,trigger:T};
  $("#sSetting").textContent=S.name;
  $("#sWho").textContent=R.cast.name+", "+R.cast.age;
  $("#scroll").innerHTML="";
  $("#fb").hidden=true;
  paintRail(); paintGuard();
  clearInterval(R.tick); R.tick=setInterval(tick,1000);
  go("session");
  Voice.pick(R.cast.woman,R.cast.age);
  prospectTurn(true);
}
function tick(){
  if(!R) return;
  R.m.durationSec=Math.round((Date.now()-R.startedAt)/1000);
  /* System latency is not his pacing. Only his half of the wall clock counts. */
  R.m.hisSec=Math.max(0,Math.round((Date.now()-R.startedAt-R.systemMs)/1000));
  const d=R.m.hisSec, w=R.setting.window, el=$("#sClock");
  el.textContent=Math.floor(d/60)+":"+String(d%60).padStart(2,"0");
  el.className="clk"+(d>w?" bad":d>w*0.7?" warn":"");
}
function recompute(){
  const a=R.turns.filter(t=>t.role==="advisor"), p=R.turns.filter(t=>t.role==="prospect");
  const aw=a.reduce((n,t)=>n+words(t.text),0), pw=p.reduce((n,t)=>n+words(t.text),0);
  R.m.advisorWords=aw; R.m.prospectWords=pw;
  R.m.talkShare=(aw+pw)?Math.round(aw/(aw+pw)*100):0;
  R.m.turns=a.length;
  R.m.avgTurnWords=a.length?Math.round(aw/a.length):0;
}
function addTurn(role,text){
  R.turns.push({role,text,t:Math.round((Date.now()-R.startedAt)/1000)});
  const el=document.createElement("div");
  el.className="t "+(role==="prospect"?"p":"a");
  el.innerHTML='<div class="w">'+esc(role==="prospect"?R.cast.name:"You")+'</div><div class="x">'+esc(text)+'</div>';
  $("#scroll").appendChild(el);
  $("#scroll").scrollTop=$("#scroll").scrollHeight;
  recompute();
  return el;
}
function thinking(on){
  const old=$("#think"); if(old)old.remove();
  if(!on) return;
  const el=document.createElement("div");
  el.className="t p"; el.id="think";
  el.innerHTML='<div class="w">'+esc(R.cast.name)+'</div><div class="x"><span class="dots"><i></i><i></i><i></i></span></div>';
  $("#scroll").appendChild(el); $("#scroll").scrollTop=$("#scroll").scrollHeight;
}
/* No answer key while the rep is live. The rail is scenery until it is over. */
function paintRail(){
  const live=R&&R.live;
  $("#rail").innerHTML=STATES.map(s=>
    '<span class="st'+(!live&&R.goals.includes(s.n)?" on":"")+'">'+esc(s.name)+'</span>').join("");
  const d=$("#dRail");
  if(d) d.innerHTML=STATES.map(s=>'<i class="'+(!live&&R.goals.includes(s.n)?"on":"")+'"></i>').join("");
}
function paintGuard(){
  const pct=clamp(100-R.guard,3,100);
  $("#guardBar").style.width=pct+"%";
  $("#guardBar").style.background=pct>62?"var(--good)":pct>34?"var(--accent)":"var(--ink-3)";
}
/* Coaching is banked, never delivered mid-rep. The prospect never breaks character,
   and he never gets the better line while he can still use it. */
/* The client already judged the obvious failures the instant he said them, and the
   prospect has already reacted to that. Only count what the coach caught on its own. */
function showFeedback(fb,run,turnIdx){
  if(!fb) return;
  const target=run||R;
  if(!target) return;
  target.feedback.push(fb);
  if(!target.live) return;
  if(turnIdx!=null&&target.detTurns&&target.detTurns[turnIdx]) return;
  if(fb.flag&&fb.flag!=="none"){
    if(/^(product|advice|pitch|banned|took_bait)$/.test(fb.flag)) target.slips++;
    bumpGuard(fb.flag,null,target);
  }
}
function localCoach(t,wc,hits){
  if(hits.length) return {goal:0,hit:false,flag:"banned",verdict:"harmful",chip:hits[0].label.length>12?"Product":"Banned phrase",
    note:"That is selling. Ask what made it come up now.",better_line:"What made that come up now?"};
  if(wc>45) return {goal:0,hit:false,flag:"overtalk",verdict:"weak",chip:"Too long",
    note:wc+" words. One question would have been stronger.",better_line:"Is that business, personal, or both?"};
  if(hitAny(WHYNOW,t)) return {goal:2,hit:true,flag:"none",verdict:"strong",chip:"Why now",
    note:"The right question. Now stop talking.",better_line:null};
  if(hitAny(BUCKETQ,t)) return {goal:3,hit:true,flag:"none",verdict:"strong",chip:"Bucketed",
    note:"Narrowed without digging. Give one line of recognition next.",better_line:null};
  if(hitAny(BRIDGE,t)) return {goal:5,hit:true,flag:"none",verdict:"strong",chip:"Bridged",
    note:"Now pin the next step or you lose it.",better_line:null};
  if(hitAny(CAPTURE,t)) return {goal:6,hit:true,flag:"none",verdict:"strong",chip:"Locked it",note:"That is the rep.",better_line:null};
  return {goal:0,hit:false,flag:"none",verdict:"neutral",chip:"Neutral",note:"That did not move it. Ask why now.",better_line:null};
}
