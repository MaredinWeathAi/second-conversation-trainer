/* ---------- the loop ---------- */
/* The brief is byte-identical for the whole run, so it caches. Everything mutable
   rides in the tail, after the cache breakpoint. */
function buildTurns(){
  const t=[{role:"user",content:prospectBrief()}];
  R.turns.forEach(x=>t.push(x.role==="prospect"
    ? {role:"assistant",content:JSON.stringify({say:x.text})}
    : {role:"user",content:"ADVISOR: "+x.text}));
  const sc=R.scene;
  const tail="\n\n=== NOW ===\n"
    +(sc?("YOUR SCENE, unchanged — reason: "+sc.reason+" | opening: "+sc.opening+" | cue: "+sc.cue+"\n"):"")
    +"TURN "+(R.m.turns+1)+" · OPENED "+(R.opened?"yes":"not yet")
    +" · GOALS MET ["+R.goals.join(",")+"] · CUE "+(R.cueGiven?"given":"not yet")
    +" · COFFEE "+(R.accepted?"accepted":"not accepted")+" · SLIPS "+R.slips+"\n"
    +"GUARD: "+R.guard+" · TRAPS ASKED: "+(R.trapAsked?"1 or more":"none yet")
    +" · TRAPS FOR THIS RUN: "+R.level.traps+"\n"
    +"ACCEPT ALLOWED: "+(acceptAllowed()?"yes":"no")+"\n"
    +"LEAVE: "+(leaveNow()?"yes — this is your last turn":"no")+"\n"
    +"(Reply as JSON only.)";
  const last=t[t.length-1];
  if(last.role==="user") last.content+=tail; else t.push({role:"user",content:tail});
  return t;
}
/* Offline only. It is marked on the run and excluded from averages —
   a rep against a state machine is not evidence of anything. */
function fallbackProspect(first){
  const S=R.setting,T=R.trigger,g=R.goals,n=R.m.turns;
  const say=(t,o,extra)=>Object.assign({say:t,cue_given:false,goals:[],flag:null,outcome:o||"open"},extra||{});
  if(first) return say(S.open[0]);
  if(n===1) return say(S.open[1]+" What do you do?");
  if(n===2) return say(T.say,"open",{goals:[1],opened:true});
  if(R.accepted){
    if(g.includes(6)) return say("Sure — 305 555 0148. Text me and we'll find a time.","captured");
    R.vague=(R.vague||0)+1;
    if(R.vague>=2) return say("Alright — good running into you.","lost");
    return say("Yeah, sounds good.");
  }
  if(!g.includes(2)) return say("It's been on my mind a while, that's all.");
  if(!R.trapAsked) return say(T.traps[0],"open",{flag:"trap"});
  if(!g.includes(3)) return say(T.truth);
  if(!R.cueGiven) return say(T.cue,"open",{cue_given:true});
  if(g.includes(5)) return say(acceptAllowed()?"No, that'd be good actually.":"Maybe — send me something.",acceptAllowed()?"accepted":"open");
  R.stall=(R.stall||0)+1;
  if(R.stall>=3) return say("Anyway — I should grab another drink before "+S.exit+".","lost");
  return say("Yeah. That's kind of where I'm stuck.");
}
async function prospectTurn(first){
  const run=R;
  thinking(true);
  const t0=Date.now();
  let out=null,fell=false;
  if(SAMPLE){
    try{ out=await SAMPLE.json(buildTurns(),{tier:"default",cachePrefix:true,retry:2}) }catch(e){}
  }
  if(R!==run||!run.live){ thinking(false); return }
  run.systemMs+=Date.now()-t0;
  thinking(false);
  if(!out||!out.say){ out=fallbackProspect(first); fell=true; run.fellBack++ }

  if(out.scene&&!run.scene&&out.scene.reason){
    run.scene={reason:String(out.scene.reason),opening:String(out.scene.opening||run.trigger.say),
               cue:String(out.scene.cue||run.trigger.cue)};
  }
  if(out.opened) run.opened=true;
  const newGoals=[];
  (out.goals||[]).forEach(n=>{n=Number(n); if(n>=1&&n<=6&&run.opened&&!run.goals.includes(n)){run.goals.push(n);newGoals.push(n)}});
  run.goals.sort();
  if(newGoals.includes(5)&&!run.bridgeTurn) run.bridgeTurn=run.m.turns;
  run.lastFlag=out.flag||null;
  if(out.flag==="trap") run.trapAsked=true;
  if(out.flag==="advice"||out.flag==="product"||out.flag==="pitch") run.slips++;
  bumpGuard(null,newGoals,run);
  if(out.cue_given&&!run.cueGiven){ run.cueGiven=true; run.cueTurn=run.m.turns }

  /* Outcomes are ours, not the model's. It cannot hand out coffee we did not authorise. */
  let oc=String(out.outcome||"open");
  if((oc==="accepted"||oc==="captured")&&!run.accepted&&!acceptAllowed()) oc="open";
  if(oc==="accepted"||oc==="captured") run.accepted=true;
  if(oc==="captured"&&!run.goals.includes(6)) oc="accepted";
  if(oc!=="captured"&&leaveNow()) oc="lost";

  addTurn("prospect",String(out.say));
  paintRail(); paintGuard();
  const done=(oc==="captured"||oc==="lost");
  /* Their speaking time is real conversation. Only the thinking was ours. */
  Voice.say(String(out.say),()=>{
    if(R!==run||!run.live) return;
    done?endRun(oc):listen();
  });
}
function listen(){ if(R&&R.live&&Voice.on()) Voice.start(); }

async function submit(text){
  if(!R||!R.live||busy) return;
  text=String(text).trim(); if(!text) return;
  const run=R;
  /* Give him a beat to finish the sentence before the mic closes. */
  const extra=await Voice.grace(1300);
  if(R!==run||!run.live) return;
  if(extra) text=(text+" "+extra).replace(/\s+/g," ").trim();
  busy=true; Voice.stop(); Voice.clear(); paintHeard();
  const wc=words(text), hits=bannedHits(text);
  hits.forEach(h=>run.m.hits.push(h));
  if(wc>run.m.maxTurnWords) run.m.maxTurnWords=wc;
  if(wc>45) run.longTurns=(run.longTurns||0)+1;
  const newGoals=detectGoals(text,run);
  newGoals.forEach(n=>{ if(!run.goals.includes(n)) run.goals.push(n) });
  run.goals.sort();
  if(run.goals.includes(5)&&!run.bridgeTurn) run.bridgeTurn=run.m.turns+1;
  /* Deterministic, instant, and the prospect sees it on this very turn. */
  const turnIdx=run.m.turns;
  const det=hits.length?(/product/i.test(hits[0].label)?"product":"banned"):(wc>45?"overtalk":null);
  if(det){ run.detTurns[turnIdx]=det; if(det!=="overtalk") run.slips++; bumpGuard(det,null,run) }
  bumpGuard(null,newGoals,run);
  addTurn("advisor",text);
  paintRail();
  if(SAMPLE) SAMPLE.json(coachPrompt(text,wc),{tier:"quick"}).then(fb=>showFeedback(fb,run,turnIdx)).catch(()=>{});
  else showFeedback(localCoach(text,wc,hits),run,turnIdx);
  if(run.m.turns>=14){ busy=false; return endRun("lost") }
  await prospectTurn(false);
  busy=false;
}

/* ---------- scoring ---------- */
const PHASE=[["positioning","Positioning"],["whynow","Why now"],["bucket","Bucket"],
             ["insight","Pattern insight"],["bridge","Coffee bridge"],["capture","Contact capture"]];
function heuristicScore(){
  const g=R.goals,m=R.m,s={};
  s.positioning=g.includes(1)?6:2;
  s.whynow=g.includes(2)?8:1;
  s.bucket=g.includes(3)?7:2;
  s.insight=m.hits.length?2:(g.includes(4)?7:3);
  s.bridge=!R.bridgeTurn?1:(R.cueGiven&&R.bridgeTurn-R.cueTurn<=2?8:(g.includes(2)&&g.includes(3)?6:3));
  s.capture=g.includes(6)?8:(R.accepted?3:1);
  return applyPenalties(s);
}
/* A cliff punished his best reps hardest — a good positioning line plus a real
   insight is simply more words. Graded, and aimed only at what length damages. */
function applyPenalties(sc){
  const m=R.m, lt=R.longTurns||0;
  if(lt>=1) sc.insight=Math.min(sc.insight,7);
  if(lt>=2){ sc.insight=Math.min(sc.insight,6); sc.positioning=Math.min(sc.positioning,6) }
  const pen=clamp(Math.ceil((m.talkShare-60)/8),0,3);
  if(pen) PHASE.forEach(p=>sc[p[0]]=Math.max(1,sc[p[0]]-pen));
  return sc;
}
function totalOf(sc){ return PHASE.reduce((a,p)=>a+(sc[p[0]]||0),0) }
/* The outcome is a fact of the transcript, not an opinion. */
function trueResult(claim){
  if(!R.accepted) return "missed";
  if(!R.goals.includes(6)) return "partial";
  if(R.m.hits.some(h=>/product/i.test(h.label))) return "partial";
  return claim==="missed"?"partial":claim;
}
async function scoreRun(){
  const fb=()=>({scores:heuristicScore(),why:{},scoredBy:"heuristic",
      result:trueResult(R.goals.includes(6)?"success":"partial"),
      gained:null,lost:null,
      rewrite:{quote:R.m.hits.length?R.m.hits[0].quote:"",why_it_failed:"",better:"What made that come up now?"},
      bridge_timing:R.bridgeTurn?(R.cueGiven?(R.bridgeTurn-R.cueTurn<=2?"On the cue.":"Late — they had already resonated."):"Before they resonated."):"You never asked.",
      primary_failure:R.goals.includes(2)?"You did not pin a next step.":"You never asked what made it come up now.",
      drill:"Run it again. You may not say anything that is not a question until they resonate.",verdict:""});
  if(!SAMPLE) return fb();
  try{
    const o=await SAMPLE.json(scoringPrompt(),{tier:pref("scoretier","default"),temperature:0,retry:2});
    const sc={},why={};
    PHASE.forEach(p=>{
      const row=(o.scores||{})[p[0]]||{};
      const v=clamp(Math.round(Number(row.score)||5),1,10);
      sc[p[0]]=v; why[p[0]]={why:String(row.why||""),ev:String(row.evidence||"")};
    });
    if(R.m.hits.some(h=>/product/i.test(h.label))) sc.insight=Math.min(sc.insight,3);
    if(R.feedback.some(f=>f&&f.flag==="took_bait")) sc.insight=Math.min(sc.insight,4);
    if(!R.goals.includes(2)){ sc.whynow=Math.min(sc.whynow,2); sc.insight=Math.min(sc.insight,5) }
    if(R.bridgeTurn&&!(R.goals.includes(2)&&R.goals.includes(3))) sc.bridge=Math.min(sc.bridge,4);
    if(R.cueGiven&&(!R.bridgeTurn||R.bridgeTurn-R.cueTurn>2)) sc.bridge=Math.min(sc.bridge,5);
    if(!R.accepted) sc.capture=Math.min(sc.capture,2);
    else if(!R.goals.includes(6)) sc.capture=Math.min(sc.capture,3);
    applyPenalties(sc);
    return {scores:sc,why,scoredBy:"model",result:trueResult(String(o.result||"missed")),gained:o.gained||null,lost:o.lost||null,
      rewrite:o.rewrite||{},bridge_timing:String(o.bridge_timing||""),
      primary_failure:String(o.primary_failure||""),drill:String(o.drill||""),verdict:String(o.verdict||"")};
  }catch(e){ return fb() }
}
async function endRun(reason){
  if(!R||!R.live) return;
  const run=R;
  run.live=false; clearInterval(run.tick); Voice.stop(); Voice.hush();
  recompute();
  run.result=reason==="captured"?"Coffee set and next step locked":reason==="lost"?"Lost it":"Ended early";
  go("score"); DRIVE.scoring=true;
  $("#scoreBody").innerHTML='<div class="card"><p class="eyebrow">Scoring</p><h2>Reading the tape…</h2><div class="dots" style="margin-top:12px"><i></i><i></i><i></i></div></div>';
  if(DRIVE.on) Voice.say("Scoring.",null,{coach:true});
  const s=await scoreRun();
  const d=new Date(run.ts), pad=n=>String(n).padStart(2,"0");
  const localDate=d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
  const flagged={};
  run.feedback.forEach(f=>{ if(f&&f.flag&&f.flag!=="none") flagged[f.flag]=(flagged[f.flag]||0)+1 });
  run.m.hits.forEach(h=>{ const k=/product/i.test(h.label)?"product":"banned"; flagged[k]=(flagged[k]||0)+1 });
  const rec={id:run.id,ts:run.ts,localDate,isoWeek:isoWeek(d),month:localDate.slice(0,7),year:d.getFullYear(),
    setting:run.setting.name,settingId:run.setting.id,trigger:run.trigger.id,
    triggerSay:(run.scene&&run.scene.opening)||run.trigger.say,
    scene:run.scene||null,
    cast:{name:run.cast.name,woman:run.cast.woman,age:run.cast.age,work:run.cast.work},
    level:run.level.k,goals:run.goals.slice(),cueGiven:run.cueGiven,cueTurn:run.cueTurn,bridgeTurn:run.bridgeTurn,
    accepted:run.accepted,productNamed:run.m.hits.some(h=>/product/i.test(h.label)),
    slips:run.slips,guard:run.guard,trapAsked:run.trapAsked,flags:flagged,
    scores:s.scores,total:totalOf(s.scores),result:s.result,why:s.why,scoredBy:s.scoredBy,
    fellBack:run.fellBack||0,
    gained:s.gained,lost:s.lost,rewrite:s.rewrite,bridgeTiming:s.bridge_timing,
    primaryFailure:s.primary_failure,drill:s.drill,verdict:s.verdict,
    m:run.m,feedback:run.feedback,cost:(run.cost||0)+(run.ttsCost||0),synced:false,
    turns:run.turns.map(t=>({role:t.role,text:t.text,t:t.t}))};
  DRIVE.scoring=false;
  await saveRun(rec);
  renderScore(rec); renderHome(); renderProgress();
  if(DRIVE.on) driveScored(rec);
}
function isoWeek(d){
  const t=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));
  const day=t.getUTCDay()||7; t.setUTCDate(t.getUTCDate()+4-day);
  const y0=new Date(Date.UTC(t.getUTCFullYear(),0,1));
  return t.getUTCFullYear()+"-W"+String(Math.ceil((((t-y0)/864e5)+1)/7)).padStart(2,"0");
}
