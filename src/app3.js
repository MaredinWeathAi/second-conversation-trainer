/* ---------- persistence ---------- */
const LS="sct.runs.v4";
const CAP=1200;
const loadLocal=()=>{try{return JSON.parse(localStorage.getItem(LS)||"[]")}catch(e){return[]}};
/* localStorage is a cache with a hard quota, not the record. Trim the transcripts
   off the oldest runs before dropping runs — the scores are what the analytics need. */
function saveLocal(){
  const slim=r=>{const c=Object.assign({},r); delete c.turns; delete c.feedback; c.slim=1; return c};
  let rows=RUNS.slice(0,CAP);
  for(let attempt=0;attempt<3;attempt++){
    try{ localStorage.setItem(LS,JSON.stringify(rows)); return }
    catch(e){ rows=attempt===0?rows.slice(0,200).concat(rows.slice(200).map(slim))
                              :rows.slice(0,Math.floor(rows.length/2)) }
  }
}
async function postRun(r){
  if(!SERVER) return false;
  try{
    const res=await fetch("/api/runs",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({run:r})});
    return res.ok;
  }catch(e){ return false }
}
async function saveRun(r){
  RUNS.unshift(r); saveLocal();
  const ok=await postRun(r);
  if(ok){ r.synced=true; saveLocal() }
}
/* Anything that never reached the server gets pushed on the next boot.
   A rep saved on a dead connection used to stay on one phone forever. */
async function syncPending(){
  if(!SERVER) return;
  const pend=RUNS.filter(r=>r.synced===false&&!r.slim).slice(0,25);
  let changed=false;
  for(const r of pend){ if(await postRun(r)){ r.synced=true; changed=true } }
  if(changed) saveLocal();
}
async function loadRuns(){
  RUNS=loadLocal();
  if(SERVER){try{
    const r=await fetch("/api/runs");
    if(r.ok){const j=await r.json();const seen={},out=[];
      (j.runs||[]).concat(RUNS).forEach(x=>{if(x&&x.id&&!seen[x.id]){seen[x.id]=1;x.synced=true;out.push(x)}});
      out.sort((a,b)=>b.ts-a.ts); RUNS=out; saveLocal();}
  }catch(e){}}
  await syncPending();
  renderHome(); renderProgress();
}

/* ---------- cost ---------- */
/* Real list prices. The old table had Sonnet at 2/10 and counted no speech at all,
   so the meter read about half of what a rep actually cost. */
const PRICES=[[/opus/i,{i:15,o:75}],[/sonnet/i,{i:3,o:15}],[/haiku/i,{i:1,o:5}]];
const localDay=d=>{const x=d||new Date(),p=n=>String(n).padStart(2,"0");
  return x.getFullYear()+"-"+p(x.getMonth()+1)+"-"+p(x.getDate())};
function addSpend(c){
  if(!(c>0)) return;
  try{const k="sct.spend."+localDay();
    localStorage.setItem(k,String((+localStorage.getItem(k)||0)+c))}catch(e){}
}
function noteUsage(u,model){
  if(!u) return;
  const p=(PRICES.find(x=>x[0].test(String(model||"")))||[0,{i:3,o:15}])[1];
  const c=((+u.input_tokens||0)*p.i+(+u.cache_creation_input_tokens||0)*p.i*1.25
    +(+u.cache_read_input_tokens||0)*p.i*0.1+(+u.output_tokens||0)*p.o)/1e6;
  if(R) R.cost=(R.cost||0)+c;
  addSpend(c);
}
function noteTts(c){ if(!(c>0))return; if(R) R.ttsCost=(R.ttsCost||0)+c; addSpend(c) }
const money=n=>n<0.01?"<$0.01":"$"+n.toFixed(n<1?3:2);
function spend(days){let t=0;try{for(let i=0;i<days;i++){
  t+=+localStorage.getItem("sct.spend."+localDay(new Date(Date.now()-i*864e5)))||0}}catch(e){}return t}

/* ---------- sampler ---------- */
function looseJSON(t){
  if(!t) throw new Error("empty");
  try{return JSON.parse(t)}catch(e){}
  const f=t.match(/```(?:json)?\s*([\s\S]*?)```/); if(f){try{return JSON.parse(f[1])}catch(e){}}
  const b=t.match(/\{[\s\S]*\}/); if(b){try{return JSON.parse(b[0])}catch(e){}}
  throw new Error("unparseable");
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
/* Bounded retry on the failures that are actually transient, and a hard client
   timeout so a hung request cannot leave him in silence at 60mph. */
const sampler=()=>({json:async(input,opt)=>{
  const o=opt||{}, tries=(o.retry||0)+1;
  let lastErr=null;
  for(let i=0;i<tries;i++){
    const ac=new AbortController();
    const timer=setTimeout(()=>ac.abort(),o.timeout||25000);
    try{
      const r=await fetch("/api/chat",{method:"POST",headers:chatHeaders(),signal:ac.signal,
        body:JSON.stringify({input,tier:o.tier||"default",cachePrefix:!!o.cachePrefix,
          temperature:o.temperature})});
      clearTimeout(timer);
      if(r.status===401){location.reload();throw new Error("session")}
      if(r.status===429||r.status>=500){ lastErr=new Error("chat "+r.status);
        if(i<tries-1){ await wait(900*(i+1)); continue } throw lastErr }
      if(!r.ok) throw new Error("chat "+r.status);
      const j=await r.json(); if(j.usage) noteUsage(j.usage,j.model);
      return looseJSON(j.text);
    }catch(e){
      clearTimeout(timer); lastErr=e;
      if(String(e.message)==="session") throw e;
      if(i<tries-1){ await wait(900*(i+1)); continue }
    }
  }
  throw lastErr||new Error("chat failed");
}});

/* ---------- voice ---------- */
const BADV=/bells|boing|bubbles|jester|organ|trinoids|whisper|zarvox|grandma|grandpa|albert|ralph|kathy|bahh|cellos|wobble|superstar|junior|deranged|good news|bad news/i;
const IS_IOS=/iP(hone|ad|od)/.test(navigator.userAgent)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1);
const IS_MAC=/Macintosh/.test(navigator.userAgent)&&!IS_IOS;
const VPREF={ios:{m:["Aaron","Daniel","Arthur","Fred","Reed"],f:["Nicky","Samantha","Martha","Karen","Moira"]},
 mac:{m:["Tom","Evan","Nathan","Aaron","Alex"],f:["Ava","Susan","Zoe","Allison","Samantha"]},
 other:{m:["Google UK English Male","Microsoft Guy","Daniel","Alex"],f:["Google US English","Microsoft Aria","Samantha"]}};
const TTS={ctx:null,cancel:null,tripped:false,trippedAt:0,cache:new Map(),stream:null};
const FILLER=/(^|\s)(um+|uh+|er+|so|and|but|like|i mean|you know|because|cause|the|a|my|to|of|is|it'?s|that'?s|kind of|sort of|well)\s*$/i;
const Voice={
 rec:null,want:false,listening:false,blocked:false,buf:"",interim:"",timer:null,wd:null,kick:null,
 speaking:false,voices:[],picked:null,note:"",last:"",graceOn:false,graceRes:null,graceTimer:null,graceExt:0,
 on(){ return DRIVE.on || $("#chkVoice").checked },
 supported(){ return !!(window.SpeechRecognition||window.webkitSpeechRecognition) },
 init(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(SR){ const r=new SR(); r.continuous=true; r.interimResults=true; r.lang="en-US";
   r.onresult=e=>{let f="",i2="";
     for(let i=e.resultIndex;i<e.results.length;i++){const x=e.results[i][0].transcript;
       e.results[i].isFinal?f+=x+" ":i2+=x}
     if(f) this.buf+=f; this.interim=i2; paintHeard();
     if(this.graceOn){ this.extendGrace(); return }
     if(this.buf.trim()||i2.trim()) this.arm();};
   r.onerror=e=>{ if(e.error==="not-allowed"||e.error==="service-not-allowed"){this.blocked=true;this.want=false;micDenied()} };
   r.onend=()=>{ this.listening=false;
     if(this.want&&!this.blocked) setTimeout(()=>{ if(!this.want||this.blocked)return;
       try{r.start();this.listening=true}catch(_){} paintMic() },250);
     paintMic() };
   this.rec=r; }
  const load=()=>{this.voices=speechSynthesis?speechSynthesis.getVoices()||[]:[]};
  load(); if(window.speechSynthesis) speechSynthesis.onvoiceschanged=load;
 },
 pick(woman,age){
  const en=this.voices.filter(v=>/^en/i.test(v.lang||"")&&!BADV.test(v.name||""));
  if(!en.length){this.picked=null;this.note="No English voice on this device.";return}
  const k=IS_IOS?"ios":IS_MAC?"mac":"other", list=VPREF[k][woman?"f":"m"];
  for(let i=0;i<list.length;i++){
    const m=en.filter(v=>v.name.toLowerCase().includes(list[i].toLowerCase()));
    if(m.length){ this.picked=m.find(v=>/enhanced|premium/i.test(v.name))||m[0];
      this.note=i===0?"":list[0]+" isn't on this device, using "+this.picked.name+".";
      return }
  }
  this.picked=en.find(v=>/^en-US/i.test(v.lang))||en[0];
  this.note="Using "+this.picked.name+".";
 },
 /* A flat 1.5s timer cut him off every time he paused to think at a light.
    A question ends fast; a trailing "so…" is not the end of a sentence. */
 arm(){
   clearTimeout(this.timer);
   const t=(this.buf+" "+this.interim).trim();
   let ms=2300;
   if(/[?]\s*$/.test(t)) ms=1000;
   else if(FILLER.test(t)) ms=3400;
   else if(words(t)<4) ms=2800;
   this.timer=setTimeout(()=>this.flush(),ms);
 },
 flush(){ clearTimeout(this.timer);
   const t=(this.buf+" "+this.interim).replace(/\s+/g," ").trim();
   this.buf=""; this.interim="";
   if(this.graceOn) return this.endGrace(t);
   const cmd=commandOf(t);
   if(cmd) return runCommand(cmd);
   if(words(t)<2){ paintHeard(); return }
   submit(t);
 },
 /* Continuation window: the mic stays open for a beat after he stops, so the
    second half of a sentence lands in the same turn instead of vanishing. */
 grace(ms){
   if(!this.want||this.blocked) return Promise.resolve("");
   this.graceOn=true; this.graceExt=0;
   return new Promise(res=>{ this.graceRes=res;
     this.graceTimer=setTimeout(()=>this.endGrace((this.buf+" "+this.interim).replace(/\s+/g," ").trim()),ms) });
 },
 extendGrace(){
   if(!this.graceOn||this.graceExt>=2) return;
   this.graceExt++; clearTimeout(this.graceTimer);
   this.graceTimer=setTimeout(()=>this.endGrace((this.buf+" "+this.interim).replace(/\s+/g," ").trim()),1400);
 },
 endGrace(t){
   if(!this.graceOn) return;
   clearTimeout(this.graceTimer); this.graceOn=false;
   this.buf=""; this.interim="";
   const res=this.graceRes; this.graceRes=null;
   res&&res(words(t)>=2?t:"");
 },
 clear(){ this.buf=""; this.interim="" },
 start(){ if(!this.rec||this.blocked)return; this.want=true; this.clear();
   try{this.rec.start();this.listening=true}catch(_){}
   clearInterval(this.wd);
   this.wd=setInterval(()=>{ if(this.want&&!this.blocked&&!this.speaking&&!this.listening){
     try{this.rec.start();this.listening=true;paintMic()}catch(_){} } },4000);
   paintMic(); paintHeard() },
 stop(){ this.want=false; clearTimeout(this.timer); clearInterval(this.wd);
   this.endGrace("");
   try{this.rec&&this.rec.abort()}catch(_){} this.listening=false; paintMic() },
 say(text,done,opts){
  const o=opts||{};
  if(!this.on()&&!o.force){ done&&done(); return }
  if(!o.coach) this.last=String(text);
  this.speaking=true; $("#cutIn").hidden=false; paintMic();
  const fin=()=>{ this.speaking=false; $("#cutIn").hidden=true; paintMic(); done&&done() };
  (ttsEngine()==="hosted"?hosted:builtin)(text,!!(R&&R.cast&&R.cast.woman),fin,o);
 },
 repeat(){ if(this.last) this.say(this.last,()=>listen()) },
 hush(){ clearInterval(this.kick); this.speaking=false;
   try{TTS.cancel&&TTS.cancel()}catch(e){}
   try{speechSynthesis.cancel()}catch(e){}
   $("#cutIn").hidden=true; paintMic() }
};
const sentences=t=>(String(t).match(/[^.!?…]+[.!?…]*/g)||[String(t)]).map(x=>x.trim()).filter(Boolean);
/* One bad response used to kill the natural voice for the whole session. Re-arm. */
const ttsEngine=()=>{
  if(TTS.tripped&&Date.now()-TTS.trippedAt>60000){ TTS.tripped=false; paintVoice() }
  const e=pref("tts","auto");
  return (e==="builtin"||TTS.tripped||!HAS_TTS)?"builtin":"hosted";
};
function unlockAudio(){ try{
  if(!TTS.ctx) TTS.ctx=new (window.AudioContext||window.webkitAudioContext)();
  if(TTS.ctx.state!=="running") TTS.ctx.resume();
  const b=TTS.ctx.createBuffer(1,1,22050),s=TTS.ctx.createBufferSource();
  s.buffer=b; s.connect(TTS.ctx.destination); s.start(0);
  if(window.speechSynthesis){const u=new SpeechSynthesisUtterance(" ");u.volume=0;speechSynthesis.speak(u)}
}catch(e){} }
function instructions(){
  const c=R&&R.cast; if(!c) return "Conversational and unpolished, never an announcer.";
  const a=pref("accent","match");
  const acc=a==="match"?c.accent:{cuban:"Miami Cuban-American, quick and clipped.",
    northeast:"Brisk New York register, dry.",latam:"Soft Spanish rhythm, measured.",
    anglo:"General American, relaxed."}[a]||c.accent;
  return "A "+c.age+"-year-old "+c.sex+". "+acc+
   " Conversational and unpolished, never an announcer or narrator. You are at a social event, half-distracted, glancing across the room. Short pauses between thoughts. Friendly but guarded. Keep the accent subtle, never a caricature.";
}
const COACH_INSTR="Flat, direct, unsentimental. A coach reading back a score. No warmth, no encouragement, no rising intonation. Even pace, slightly clipped.";
async function ttsFetch(p,woman,coach,ac){
  const r=await fetch("/api/tts",{method:"POST",headers:{"content-type":"application/json"},signal:ac.signal,
    body:JSON.stringify({text:p,woman,role:coach?"coach":"prospect",
      instructions:coach?COACH_INSTR:instructions()})});
  if(r.status===401){location.reload();throw new Error("session")}
  if(!r.ok) throw new Error("tts "+r.status);
  const cost=parseFloat(r.headers.get("x-cost-est")||"0"); if(cost) noteTts(cost);
  return TTS.ctx.decodeAudioData(await r.arrayBuffer());
}
/* Fetch every sentence at once and start speaking the moment the first one decodes,
   instead of waiting for the whole paragraph. This was most of the dead air. */
async function hosted(text,woman,done,opts){
  const coach=!!(opts&&opts.coach);
  unlockAudio();
  const parts=sentences(text); let dead=false; const srcs=[];
  TTS.cancel=()=>{dead=true;srcs.forEach(s=>{try{s.stop()}catch(e){}})};
  const key=p=>p+"|"+(coach?"c":woman?"f":"m");
  const jobs=parts.map(p=>{
    const k=key(p), hit=TTS.cache.get(k);
    if(hit) return Promise.resolve(hit);
    const ac=new AbortController();
    const t=setTimeout(()=>ac.abort(),9000);
    return ttsFetch(p,woman,coach,ac).then(b=>{clearTimeout(t);
      if(TTS.cache.size>40) TTS.cache.clear(); TTS.cache.set(k,b); return b});
  });
  let cursor=null, ended=0, failed=false;
  try{
    for(let i=0;i<jobs.length;i++){
      let b;
      try{ b=await jobs[i] }
      catch(e){ failed=true; break }
      if(dead){ done&&done(); return }
      const s=TTS.ctx.createBufferSource(); s.buffer=b; s.connect(TTS.ctx.destination);
      const gap=/\?\s*$/.test(parts[i])?0.6:0.16+Math.random()*0.22;
      const now=TTS.ctx.currentTime;
      const at=cursor==null?now+0.06:Math.max(now+0.02,cursor);
      s.start(at); srcs.push(s);
      cursor=at+b.duration+gap; ended=cursor;
    }
  }catch(e){ failed=true }
  if(failed&&cursor==null){
    /* nothing played at all — fall back for this utterance only */
    TTS.tripped=true; TTS.trippedAt=Date.now(); paintVoice();
    return builtin(text,woman,done,opts);
  }
  const ms=Math.max(0,(ended-TTS.ctx.currentTime)*1000);
  setTimeout(()=>{ if(!dead) done&&done() },ms);
}
function builtin(text,woman,done,opts){
  if(!window.speechSynthesis){done&&done();return}
  const coach=!!(opts&&opts.coach);
  try{speechSynthesis.cancel()}catch(e){}
  const parts=sentences(text); let i=0;
  clearInterval(Voice.kick);
  Voice.kick=setInterval(()=>{try{if(speechSynthesis.paused)speechSynthesis.resume()}catch(e){}},3000);
  const fin=()=>{clearInterval(Voice.kick);done&&done()};
  const next=()=>{
    if(!Voice.speaking||i>=parts.length) return fin();
    const chunk=parts[i++].slice(0,180);
    const u=new SpeechSynthesisUtterance(chunk);
    if(Voice.picked&&!coach){u.voice=Voice.picked;u.lang=Voice.picked.lang}
    u.rate=coach?1.02:1+Math.random()*0.06;
    u.pitch=coach?1:(woman?0.98+Math.random()*0.04:0.92+Math.random()*0.04);
    u.onend=()=>setTimeout(next,/\?\s*$/.test(chunk)?600:200);
    u.onerror=next;
    try{speechSynthesis.speak(u)}catch(e){fin()}
  };
  next();
}
function paintMic(){
  const m=$("#mic"); if(!m) return;
  m.className="mic"+(Voice.listening&&Voice.want?" live":Voice.speaking?" talk":"");
  const d=$("#dMic"); if(d) d.className="dmic"+(Voice.listening&&Voice.want?" live":Voice.speaking?" talk":"");
  paintStatus();
}
function paintHeard(){
  const h=$("#heard"); if(!h) return;
  const t=(Voice.buf+" "+Voice.interim).trim();
  if(Voice.speaking) h.innerHTML='<span class="hint">They\'re talking.</span>';
  else if(t) h.innerHTML=esc(Voice.buf)+'<span class="i">'+esc(Voice.interim)+'</span>';
  else if(Voice.want) h.innerHTML='<span class="hint">Listening — pause when you\'re done.</span>';
  else if(Voice.blocked) h.innerHTML='<span class="hint">Mic blocked. Type below.</span>';
  else h.innerHTML='<span class="hint">Tap the mic, or type.</span>';
  paintStatus();
}
function paintStatus(){
  const s=$("#dStat"); if(!s||!DRIVE.on) return;
  if(Voice.speaking){s.textContent="THEY'RE TALKING";s.className="dstat"}
  else if(Voice.want&&Voice.listening){s.textContent="LISTENING";s.className="dstat live"}
  else if(busy){s.textContent="THINKING";s.className="dstat busy"}
  else if(DRIVE.scoring){s.textContent="SCORING";s.className="dstat busy"}
  else {s.textContent="READY";s.className="dstat"}
}
function micDenied(){
  $("#micBanner").innerHTML='<div class="banner">Microphone blocked in this frame. Open the page in its own browser tab and allow the mic. Until then, type your replies.</div>';
  paintMic(); paintHeard();
}
/* Hold one stream open for the whole session. Restarting capture per utterance
   flaps the Bluetooth route in the car and clips the front of every reply. */
async function primeAudio(){
  unlockAudio();
  if(!Voice.supported()){ Voice.blocked=true; return }
  try{ if(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia){
    if(!TTS.stream||!TTS.stream.active) TTS.stream=await navigator.mediaDevices.getUserMedia({audio:true});
  } }
  catch(e){ Voice.blocked=true; setTimeout(micDenied,50) }
}
/* A call, Siri, or a screen lock leaves the audio context interrupted; the old
   code scheduled into the void and the rep continued in silence. */
document.addEventListener("visibilitychange",()=>{
  if(document.visibilityState!=="visible") return;
  try{ if(TTS.ctx&&TTS.ctx.state!=="running") TTS.ctx.resume() }catch(e){}
  if(R&&R.live&&DRIVE.on&&!busy&&!Voice.speaking){
    setTimeout(()=>{ if(R&&R.live&&!busy&&!Voice.speaking) Voice.last?Voice.repeat():listen() },400);
  }
});
