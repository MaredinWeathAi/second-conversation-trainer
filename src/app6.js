/* ---------- settings + wiring + boot ---------- */
function paintVoice(){
  const el=$("#voiceStat"); if(!el) return;
  let t;
  if(ttsEngine()==="hosted") t=TTS.tripped?"Natural voice unavailable this session — using the built-in one."
    :"Natural voice on. Accent follows the prospect.";
  else if(!HAS_TTS) t="Built-in voice. Add an OpenAI key for a natural Miami voice."+(IS_IOS?" Safari on iPhone can only reach Apple's basic voices — that's an Apple restriction.":"");
  else t="Built-in voice by choice.";
  if(ttsEngine()==="builtin"&&Voice.note) t+=" "+Voice.note;
  el.textContent=t;
}
function paintKey(msg,cls){
  const k=getKey();
  $("#keyState").innerHTML=msg?'<b class="'+(cls||"")+'">'+esc(msg)+'</b>'
    :(k?'<b class="good">Key saved on this device.</b>':'<b class="bad">No key yet — the prospect is scripted.</b>');
  $("#keyIn").value=""; $("#keyIn").placeholder=k?"sk-ant-…  (saved)":"sk-ant-...";
}
function loadPrefs(){
  [["selTts","tts"],["selAccent","accent"],["selMix","mix"],["selScore","scoretier"],["selLevel","level"]]
    .forEach(([id,k])=>{const v=pref(k,null),el=$("#"+id); if(v&&el) el.value=v});
}
on("#start","click",()=>primeAudio().then(()=>{ if(isPhone())driveOn(); startRun(null,null) }));
on("#pick","click",()=>{ renderPicker(); $("#pickSheet").classList.add("on") });
on("#gear","click",()=>{ $("#setSheet").classList.add("on"); paintKey(); paintVoice(); paintHist() });
$$("[data-close]").forEach(b=>b.onclick=()=>$$(".sheet").forEach(s=>s.classList.remove("on")));
$$(".sheet").forEach(sh=>sh.addEventListener("click",e=>{ if(e.target===sh) sh.classList.remove("on") }));
$$("[data-go]").forEach(b=>b.onclick=()=>go(b.dataset.go));
on("#endRun","click",()=>endRun(R&&R.goals.includes(6)?"captured":"early"));
on("#quitRun","click",()=>{ if(R){R.live=false;clearInterval(R.tick)} Voice.stop(); Voice.hush(); DRIVE.on&&driveOff(); go("home") });
on("#mic","click",()=>{ Voice.want?Voice.stop():(Voice.hush(),Voice.start()) });
on("#cutIn","click",()=>{ Voice.hush(); Voice.start() });
on("#again2","click",()=>{ const l=R&&R.turns.filter(t=>t.role==="prospect").pop(); if(l){Voice.stop();Voice.say(l.text,()=>listen())} });
on("#send","click",()=>{ const v=$("#typed").value; $("#typed").value=""; submit(v) });
on("#typed","keydown",e=>{ if(e.key==="Enter"){e.preventDefault();$("#send").click()} });
on("#chkVoice","change",function(){ if(!this.checked){Voice.stop();Voice.hush()} });
on("#dStart","click",()=>primeAudio().then(()=>{ driveOn(); startRun(null,null) }));
on("#dEnd","click",driveOff);
on("#dCut","click",()=>{ Voice.hush(); Voice.start() });
on("#dSkip","click",()=>runCommand("next"));
on("#dAgain","click",()=>runCommand("again"));
on("#dRepeat","click",()=>runCommand("repeat"));
on("#dTap","click",()=>{ Voice.want?Voice.flush():(Voice.hush(),Voice.start());
  $("#dTap").textContent=Voice.want?"Tap when you're done":"Tap to talk" });
[["selTts","tts"],["selAccent","accent"],["selMix","mix"],["selScore","scoretier"],["selLevel","level"]]
  .forEach(([id,k])=>on("#"+id,"change",function(){ setPref(k,this.value); paintVoice() }));
on("#keySave","click",async function(){
  const v=$("#keyIn").value.trim();
  if(!v){ paintKey("Paste a key first.","bad"); return }
  setKey(v); paintKey("Checking…","");
  try{ const r=await fetch("/api/key",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({key:v,persist:$("#keyShare").checked})});
    const j=await r.json();
    if(j.ok){ SAMPLE=sampler(); NEEDKEY=false; paintKey("Key works — "+(j.model||"connected")+".","good") }
    else { setKey(""); paintKey(j.message||"Rejected.","bad") }
  }catch(e){ paintKey("Could not reach the server.","bad") }
});
on("#keyClear","click",async()=>{ setKey(""); try{await fetch("/api/key",{method:"DELETE"})}catch(e){} paintKey("Key removed.","bad") });
on("#ttsSave","click",async function(){
  const v=$("#ttsIn").value.trim(); const st=$("#voiceStat");
  if(!v){ st.textContent="Paste an OpenAI key first."; return }
  st.textContent="Checking…";
  try{ const r=await fetch("/api/ttskey",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({key:v})});
    const j=await r.json(); $("#ttsIn").value="";
    if(j.ok){ HAS_TTS=true; TTS.tripped=false; setTtsKey(v); setPref("tts","auto"); if($("#selTts"))$("#selTts").value="auto"; paintVoice() }
    else st.textContent=j.message||"Rejected.";
  }catch(e){ st.textContent="Could not reach the server." }
});
on("#preview","click",()=>{
  unlockAudio(); primeAudio();
  const woman=Math.random()<.5;
  if(!R) R={cast:{woman,age:56,sex:woman?"woman":"man",accent:ORIGIN.cuban[1]},live:false};
  R.cast.woman=woman; Voice.pick(woman,56);
  Voice.say(woman?"Honestly? My CPA handles most of it. But go ahead, you've got two minutes."
                 :"Yeah, no, I've got a guy for that. Been with him since oh-nine. Why, what do you do?",paintVoice);
});
on("#exportRuns","click",()=>{ window.open("/api/export","_blank") });
on("#wipeRuns","click",async()=>{
  if(!confirm("Delete every stored rep and start the record from zero?\nThe server keeps a dated backup file; this app will show nothing.")) return;
  const st=$("#histStat"); st.textContent="Clearing…";
  try{ await fetch("/api/runs/reset",{method:"POST"}) }catch(e){}
  try{ localStorage.removeItem(LS) }catch(e){}
  Object.keys(localStorage).filter(k=>k.indexOf("sct.spend.")===0).forEach(k=>{try{localStorage.removeItem(k)}catch(e){}});
  RUNS=[]; renderHome(); renderProgress(); paintHist();
});
function paintHist(){ const st=$("#histStat"); if(!st) return;
  const n=RUNS.length, s=RUNS.filter(r=>r.scoredBy==="model").length;
  st.textContent=n?(n+" reps stored, "+s+" model-scored."):"No reps stored yet."; }
on("#lock","click",async()=>{ if(!confirm("Lock this device?"))return;
  try{await fetch("/api/logout",{method:"POST"})}catch(e){} location.reload() });

Voice.init();
renderLibrary();
(async function boot(){
  try{
    const h=await fetch("/api/health",{headers:chatHeaders(),cache:"no-store"});
    if(h.status===401){location.reload();return}
    if(h.ok){ const j=await h.json(); SERVER=true; HAS_TTS=!!j.tts;
      if(j.ai||getKey()) SAMPLE=sampler(); else NEEDKEY=true;
      if(!j.server_ai&&getKey()){ try{ const k=await fetch("/api/key",{method:"POST",
        headers:{"content-type":"application/json"},body:JSON.stringify({key:getKey(),persist:true})});
        if((await k.json()).ok){ SAMPLE=sampler(); NEEDKEY=false } }catch(e){} }
      if(!j.tts&&getTtsKey()){ try{ const t=await fetch("/api/ttskey",{method:"POST",
        headers:{"content-type":"application/json"},body:JSON.stringify({key:getTtsKey()})});
        if((await t.json()).ok){ HAS_TTS=true; TTS.tripped=false } else setTtsKey("") }catch(e){} }
    }
  }catch(e){}
  Voice.voices=speechSynthesis?speechSynthesis.getVoices()||[]:[];
  loadPrefs(); paintVoice(); paintHeard();
  if(NEEDKEY) $("#needkey").hidden=false;
  await loadRuns();
  try{ await fetch("/api/ping") }catch(e){}
})();
