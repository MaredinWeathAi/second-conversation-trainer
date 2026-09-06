/* ---------- drive / hands-free ---------- */
const DRIVE={on:false,reps:0,scoring:false,awaitChoice:false,choiceTimer:null};
const isPhone=()=>window.matchMedia("(max-width:900px)").matches;
let wakeLock=null;
async function keepAwake(on){ try{
  if(on){ if(!wakeLock&&navigator.wakeLock) wakeLock=await navigator.wakeLock.request("screen") }
  else if(wakeLock){ await wakeLock.release(); wakeLock=null }
}catch(e){wakeLock=null} }
document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="visible"&&DRIVE.on) keepAwake(true) });
function driveOn(){
  DRIVE.on=true; $("#drive").classList.add("on");
  $("#dStart").hidden=true; $("#dCtl").hidden=false; $("#dTap").hidden=false;
  /* The live panel used to stay hidden for the whole first rep, so the one
     screen he might glance at said "Ready when you are" while it was listening. */
  $("#dHero").hidden=true; $("#dLive").hidden=false;
  $("#dSay").textContent=""; $("#dYou").hidden=true;
  keepAwake(true); paintStatus();
}
function driveOff(){
  DRIVE.on=false; DRIVE.awaitChoice=false; clearTimeout(DRIVE.choiceTimer);
  if(R&&R.live){R.live=false;clearInterval(R.tick)}
  Voice.stop(); Voice.hush(); keepAwake(false);
  $("#drive").classList.remove("on");
  $("#dStart").hidden=false; $("#dCtl").hidden=true; $("#dTap").hidden=true;
  $("#dHero").hidden=false; $("#dLive").hidden=true;
  go("progress");
}
/* The coach reads this, not the prospect. Score, then the one thing to fix,
   then the line to say instead, then a choice he can answer out loud. */
function driveScored(run){
  DRIVE.reps++;
  $("#dHero").hidden=true; $("#dLive").hidden=false;
  $("#dSay").textContent=run.total+" / 60";
  $("#dYou").hidden=false; $("#dYou").textContent=run.primaryFailure||run.result;
  const weakKey=PHASE.map(p=>p[0]).sort((a,b)=>run.scores[a]-run.scores[b])[0];
  const weakName=(PHASE.find(p=>p[0]===weakKey)||["",""])[1];
  const spoken=[run.total+" out of 60.",
    run.result==="success"?"Coffee set and locked.":run.result==="partial"?"You got coffee but left the next step vague.":"No coffee.",
    run.primaryFailure||"",
    weakName?("Weakest: "+weakName+", "+run.scores[weakKey]+"."):"",
    run.drill||"",
    run.rewrite&&run.rewrite.better?"Say instead: "+run.rewrite.better:"",
    "Again, or next?"].filter(Boolean).join(" ");
  Voice.say(spoken,()=>{ if(DRIVE.on) askChoice() },{coach:true});
}
function askChoice(){
  DRIVE.awaitChoice=true;
  Voice.start();
  clearTimeout(DRIVE.choiceTimer);
  DRIVE.choiceTimer=setTimeout(()=>{ if(DRIVE.awaitChoice){ DRIVE.awaitChoice=false; Voice.stop(); startRun(null,null) } },6000);
}
/* Spoken controls. Without these "again" and "repeat" were submitted to the
   prospect as dialogue — a wasted turn, a wasted call and a confused answer. */
function runCommand(cmd){
  if(DRIVE.awaitChoice){
    DRIVE.awaitChoice=false; clearTimeout(DRIVE.choiceTimer); Voice.stop();
    if(cmd==="again") return primeAudio().then(()=>startRun(LAST&&LAST.setting,LAST&&LAST.trigger));
    if(cmd==="stop") return driveOff();
    return primeAudio().then(()=>startRun(null,null));
  }
  if(cmd==="repeat"){ Voice.clear(); return Voice.repeat() }
  if(cmd==="stop"){ if(R&&R.live){R.live=false;clearInterval(R.tick)} return driveOff() }
  if(cmd==="score"){ if(R&&R.live) return endRun("early"); return }
  if(cmd==="again"){ if(R&&R.live){R.live=false;clearInterval(R.tick)}
    Voice.stop(); Voice.hush(); return primeAudio().then(()=>startRun(LAST&&LAST.setting,LAST&&LAST.trigger)) }
  if(cmd==="next"){ if(R&&R.live){R.live=false;clearInterval(R.tick)}
    Voice.stop(); Voice.hush(); return primeAudio().then(()=>startRun(null,null)) }
}

/* ---------- views ---------- */
function go(v){
  $$(".view").forEach(s=>s.classList.toggle("on",s.id==="v-"+v));
  $$("[data-go]").forEach(b=>{
    const active=(b.dataset.go==="home"&&(v==="home"||v==="session"||v==="score"))||b.dataset.go===v;
    active?b.setAttribute("aria-current","page"):b.removeAttribute("aria-current");
  });
  $$(".sheet").forEach(s=>s.classList.remove("on"));
  window.scrollTo({top:0});
}
function renderHome(){
  const last=RUNS.filter(r=>r.total!=null)[0];
  const el=$("#homeLast");
  if(!last){ el.innerHTML='<p class="first">Someone hands you an opening. Ask two questions, say one thing, move it to coffee. That is the whole rep.</p>'; }
  else{
    const cls=last.result==="success"?"good":last.result==="partial"?"warn":"bad";
    el.innerHTML='<p class="eyebrow">Last rep</p><div class="lastn '+cls+'">'+last.total+'<span>/60</span></div>'
      +'<p class="lastd">'+esc(last.setting)+' · '+esc({success:"coffee locked",partial:"coffee, no next step",missed:"no coffee"}[last.result]||"")+'</p>';
  }
  const done=RUNS.filter(r=>r.total!=null);
  const s=done.slice(0,10);
  $("#streak").textContent=s.length?(s.filter(r=>r.result==="success").length+" of your last "+s.length+" locked a next step"):"";
}
function renderPicker(){
  const best={};
  RUNS.forEach(r=>{ if(r.total!=null){ const k=r.trigger; if(best[k]==null||r.total>best[k]) best[k]=r.total } });
  let h='<p class="sect">What they hand you</p>';
  TRIGGERS.forEach(t=>{
    h+='<button class="prow" data-trig="'+t.id+'"><span class="p1">'+esc(t.family)+'</span>'
      +'<span class="p2">the specifics change every run</span><span class="p3">'+(best[t.id]!=null?best[t.id]:"—")+'</span></button>';
  });
  h+='<p class="sect" style="margin-top:26px">Where</p>';
  SETTINGS.forEach(s=>{ h+='<button class="prow" data-set="'+s.id+'"><span class="p1">'+esc(s.name)+'</span>'
    +'<span class="p2">&ldquo;'+esc(s.open[0])+'&rdquo;</span><span class="p3"></span></button>' });
  $("#pickBody").innerHTML=h;
  $$("#pickBody [data-trig]").forEach(b=>b.onclick=()=>{
    const t=TRIGGERS.find(x=>x.id===b.dataset.trig);
    primeAudio().then(()=>{ if(isPhone())driveOn(); startRun(null,t) }) });
  $$("#pickBody [data-set]").forEach(b=>b.onclick=()=>{
    const s=SETTINGS.find(x=>x.id===b.dataset.set);
    primeAudio().then(()=>{ if(isPhone())driveOn(); startRun(s,null) }) });
}
function bar(v){ return v>=8?"var(--good)":v>=6?"var(--warn)":"var(--bad)" }
function renderScore(run){
  const R2={success:["good","Success","Coffee set, next step locked."],
            partial:["warn","Partial","You got the coffee and left the next step vague."],
            missed:["bad","Missed","No coffee, or you solved it in the room."]}[run.result]||["bad","Missed",""];
  const rows=PHASE.map(p=>{
    const v=run.scores[p[0]], w=(run.why&&run.why[p[0]])||{};
    return '<div class="pr"><span class="pn">'+esc(p[1])+'</span>'
      +'<span class="pb"><i style="width:'+(v*10)+'%;background:'+bar(v)+'"></i></span>'
      +'<span class="pv" style="color:'+bar(v)+'">'+v+'</span>'
      +'<span class="pw">'+esc(w.why||"")+(w.ev&&w.ev!=="NONE FOUND"?'<em>&ldquo;'+esc(w.ev)+'&rdquo;</em>':"")+'</span></div>';
  }).join("");
  const c=[];
  c.push('<div class="rhead"><div><p class="eyebrow">'+esc(run.setting)+' · '+esc(run.cast.name)+'</p>'
    +'<h1>&ldquo;'+esc(run.triggerSay)+'&rdquo;</h1></div></div>');
  c.push('<div class="card"><div class="tot"><b class="'+R2[0]+'">'+run.total+'</b><span>/ 60</span>'
    +'<em class="'+R2[0]+'">'+R2[1]+'</em></div><p class="resw">'+esc(R2[2])+'</p>'
    +'<div class="chips"><span class="chip">'+run.m.durationSec+'s</span>'
    +'<span class="chip'+(run.m.talkShare>45?" bad":"")+'">'+run.m.talkShare+'% you</span>'
    +'<span class="chip'+(run.m.hits.length?" bad":" good")+'">'+run.m.hits.length+' flagged</span>'
    +'<span class="chip">'+run.goals.length+'/6 goals</span></div>'
    +'<div class="phases">'+rows+'</div></div>');
  if(run.bridgeTiming) c.push('<div class="box acc"><h3>Bridge timing</h3><p>'+esc(run.bridgeTiming)+'</p></div>');
  if(run.primaryFailure) c.push('<div class="box lo"><h3>Primary failure</h3><p>'+esc(run.primaryFailure)+'</p></div>');
  if(run.gained&&run.gained.quote) c.push('<div class="box hi"><h3>Where you gained</h3><p class="q">&ldquo;'+esc(run.gained.quote)+'&rdquo;</p><p>'+esc(run.gained.why||"")+'</p></div>');
  if(run.lost&&run.lost.quote) c.push('<div class="box lo"><h3>Where you lost it</h3><p class="q">&ldquo;'+esc(run.lost.quote)+'&rdquo;</p><p>'+esc(run.lost.why||"")+'</p></div>');
  if(run.rewrite&&run.rewrite.better) c.push('<div class="box acc"><h3>Rewrite</h3>'
    +(run.rewrite.quote?'<p class="bad">You said: &ldquo;'+esc(run.rewrite.quote)+'&rdquo;</p>':"")
    +'<p class="q">Say instead: &ldquo;'+esc(run.rewrite.better)+'&rdquo;</p></div>');
  if(run.drill) c.push('<div class="box acc"><h3>Drill</h3><p>'+esc(run.drill)+'</p></div>');
  if(run.feedback&&run.feedback.length) c.push('<div class="card"><h2>Turn by turn</h2>'
    +run.feedback.map(f=>{const k={strong:"good",good:"good",neutral:"",weak:"warn",harmful:"bad"}[f.verdict]||"";
      return '<div class="fbr"><span class="chip '+k+'">'+esc(f.chip||"")+'</span><span>'+esc(f.note||"")+'</span></div>'}).join("")+'</div>');
  c.push('<div class="acts"><button class="btn primary" id="again">Same setup again</button>'
    +'<button class="btn" id="next">New rep</button><button class="btn ghost" id="toProg">Progress</button></div>');
  c.push('<details><summary>Full transcript</summary><div class="card">'
    +run.turns.map(t=>'<div class="t '+(t.role==="prospect"?"p":"a")+'"><div class="w">'
      +esc(t.role==="prospect"?run.cast.name:"You")+'</div><div class="x">'+esc(t.text)+'</div></div>').join("")+'</div></details>');
  $("#scoreBody").innerHTML=c.join("");
  on("#again","click",()=>primeAudio().then(()=>{if(isPhone())driveOn();startRun(LAST&&LAST.setting,LAST&&LAST.trigger)}));
  on("#next","click",()=>go("home"));
  on("#toProg","click",()=>go("progress"));
}
