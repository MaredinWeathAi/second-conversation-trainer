/* ---------- progress ---------- */
let PERIOD="week";
/* At 20 reps a day the daily view is the one he actually wants an average on. */
const MINN={day:{s:5,w:8},week:{s:8,w:10},month:{s:15,w:15},year:{s:30,w:30}};
const keyOf=(r,p)=>p==="day"?r.localDate:p==="week"?r.isoWeek:p==="month"?r.month:String(r.year);
const plabel=(k,p)=>p==="day"?new Date(k+"T12:00:00").toLocaleDateString(undefined,{month:"short",day:"numeric"})
  :p==="week"?k.replace("-W"," w"):p==="month"?new Date(k+"-01T12:00:00").toLocaleDateString(undefined,{month:"short",year:"2-digit"}):k;
const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
function stats(rows,p){
  /* Heuristic fallback scores are not measurements. They show as reps, never as an average. */
  const n=MINN[p], S=rows.filter(r=>r.total!=null&&r.scoredBy!=="heuristic");
  const st={n:rows.length,nS:S.length,rows:S,min:n,
    total:S.length>=n.s?mean(S.map(r=>r.total)):null,
    totals:S.map(r=>r.total),
    success:S.filter(r=>r.result==="success").length,
    partial:S.filter(r=>r.result==="partial").length,
    missed:S.filter(r=>r.result==="missed").length,
    product:S.filter(r=>r.productNamed).length,
    talk:mean(S.map(r=>r.m.talkShare)),
    onCue:S.filter(r=>r.cueGiven&&r.bridgeTurn&&r.bridgeTurn-r.cueTurn<=2).length,
    cued:S.filter(r=>r.cueGiven).length,
    ph:{}};
  PHASE.forEach(x=>{ const v=S.map(r=>r.scores[x[0]]).filter(z=>z!=null);
    st.ph[x[0]]=S.length>=n.s&&v.length?mean(v):null });
  const app=PHASE.map(x=>x[0]).filter(k=>st.ph[k]!=null);
  st.weak=app.length?app.sort((a,b)=>st.ph[a]-st.ph[b])[0]:null;
  return st;
}
function nn(h,need){ return '<span class="nn">n='+h+' — need '+need+'</span>' }
function renderProgress(){
  const done=RUNS.filter(r=>r.total!=null).slice().reverse();
  const box=$("#progBody"); if(!box) return;
  if(!done.length){ box.innerHTML='<div class="card"><p class="lede">Run a few reps. The six phases trend here, and periods with too few runs show the raw numbers instead of a fake average.</p></div>'; return }
  const g={},order=[];
  done.forEach(r=>{const k=keyOf(r,PERIOD); if(!g[k]){g[k]=[];order.push(k)} g[k].push(r)});
  const hist=order.map(k=>{const s=stats(g[k],PERIOD); s.key=k; return s});
  const cur=hist[hist.length-1], prev=hist.length>1?hist[hist.length-2]:null;
  const tabs='<div class="tabs2">'+["day","week","month","year"].map(p=>
    '<button class="'+(p===PERIOD?"on":"")+'" data-p="'+p+'">'+p[0].toUpperCase()+p.slice(1)+'</button>').join("")+'</div>';
  const ins=[];
  if(cur.nS>=cur.min.s&&cur.product/cur.nS>=.3)
    ins.push("You named a product in "+cur.product+" of "+cur.nS+" reps. That is the reflex you are here to kill.");
  if(cur.cued>=3&&cur.onCue/cur.cued<.5)
    ins.push("They resonated "+cur.cued+" times and you bridged on the cue "+cur.onCue+" of them. The cue is the moment — stop asking another question.");
  if(cur.nS>=cur.min.s&&cur.partial>cur.success)
    ins.push("More reps ended vague than locked. Getting the yes is not the rep. Getting the number is.");
  if(cur.talk!=null&&cur.talk>45)
    ins.push("You are doing "+Math.round(cur.talk)+"% of the talking. Under 35 is where this works.");
  const tiles='<div class="grid">'
    +'<div class="stat"><span class="k">Reps</span><b>'+cur.n+'</b><span class="d">'+cur.success+' locked · '+cur.partial+' vague · '+cur.missed+' missed'+(cur.n>cur.nS?' · '+(cur.n-cur.nS)+' unscored':'')+'</span></div>'
    +'<div class="stat"><span class="k">Average</span><b>'+(cur.total!=null?Math.round(cur.total):"—")+'</b>'
      +'<span class="d">'+(cur.total!=null?"of 60":nn(cur.nS,cur.min.s)+" · "+cur.totals.slice(-4).join(", "))+'</span></div>'
    +'<div class="stat"><span class="k">Locked a next step</span><b>'+(cur.nS?Math.round(100*cur.success/cur.nS)+"%":"—")+'</b><span class="d">the only outcome that counts</span></div>'
    +'<div class="stat"><span class="k">Bridged on the cue</span><b>'+(cur.cued?cur.onCue+"/"+cur.cued:"—")+'</b><span class="d">within one turn of them resonating</span></div>'
    +'<div class="stat"><span class="k">Products named</span><b class="'+(cur.product?"bad":"good")+'">'+cur.product+'</b><span class="d">of '+cur.nS+' reps</span></div>'
    +'<div class="stat"><span class="k">Your talk share</span><b>'+(cur.talk!=null?Math.round(cur.talk)+"%":"—")+'</b><span class="d">target under 35</span></div>'
    +'</div>';
  let chart="";
  if(PERIOD==="day"){
    chart='<div class="card"><h2>Today</h2><table><thead><tr><th>Time</th><th>Opening</th><th class="n">Score</th><th>Result</th></tr></thead><tbody>'
      +cur.rows.slice().reverse().map(r=>'<tr><td class="dim mono">'+new Date(r.ts).toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"})+'</td>'
      +'<td>'+esc(r.triggerSay.slice(0,42))+'…</td><td class="n" style="color:'+bar(r.total/6)+'">'+r.total+'</td>'
      +'<td>'+({success:'<span class="chip good">locked</span>',partial:'<span class="chip warn">vague</span>',missed:'<span class="chip bad">missed</span>'}[r.result]||"")+'</td></tr>').join("")
      +'</tbody></table></div>';
  } else {
    chart='<div class="card"><div class="row"><h2>The six phases</h2><span class="eyebrow">1–10</span></div>'
      +'<div class="scrollx">'+phaseChart(hist)+'</div></div>';
  }
  const tbl='<div class="card"><div class="row"><h2>Where it breaks</h2>'
    +(cur.weak?'<span class="chip bad">'+esc(PHASE.find(p=>p[0]===cur.weak)[1])+'</span>':"")+'</div>'
    +'<table><thead><tr><th>Phase</th><th class="n">Now</th><th class="n">Last</th><th class="n">Δ</th></tr></thead><tbody>'
    +PHASE.slice().sort((a,b)=>(cur.ph[a[0]]==null?99:cur.ph[a[0]])-(cur.ph[b[0]]==null?99:cur.ph[b[0]])).map(p=>{
      const a=cur.ph[p[0]], b2=prev?prev.ph[p[0]]:null, d=(a!=null&&b2!=null)?a-b2:null;
      return '<tr'+(p[0]===cur.weak?' class="hot"':'')+'><td>'+esc(p[1])+'</td><td class="n">'+(a!=null?a.toFixed(1):"—")+'</td>'
        +'<td class="n dim">'+(b2!=null?b2.toFixed(1):"—")+'</td>'
        +'<td class="n" style="color:'+(d==null?"var(--ink-3)":d>.3?"var(--good)":d<-.3?"var(--bad)":"var(--ink-3)")+'">'
        +(d==null?"—":(d>0?"+":"")+d.toFixed(1))+'</td></tr>'}).join("")+'</tbody></table></div>';
  const sp='<div class="card"><div class="row"><h2>Spend</h2><span class="eyebrow">your API cost</span></div><div class="grid">'
    +'<div class="stat"><span class="k">Today</span><b>'+money(spend(1))+'</b><span class="d">'
      +RUNS.filter(r=>new Date(r.ts).toDateString()===new Date().toDateString()).length+' reps</span></div>'
    +'<div class="stat"><span class="k">Last 7 days</span><b>'+money(spend(7))+'</b><span class="d">'+money(spend(7)/7)+' a day</span></div>'
    +(()=>{const c=RUNS.filter(r=>r.cost).map(r=>r.cost); const a=mean(c);
      return '<div class="stat"><span class="k">Per rep</span><b>'+(a!=null?money(a):"—")+'</b><span class="d">'
        +(a!=null?"20 a day = "+money(a*20):"after your first rep")+'</span></div>'})()
    +'</div></div>';
  const head=cur.weak&&cur.ph[cur.weak]!=null
    ? '<div class="head1"><p class="eyebrow">Work on this</p><h2>'+esc(PHASE.find(p=>p[0]===cur.weak)[1])
      +' <span>'+cur.ph[cur.weak].toFixed(1)+'</span></h2><p>'+esc((STATES.find(x=>x.name===PHASE.find(p=>p[0]===cur.weak)[1])||{goal:""}).goal)+'</p></div>'
    : "";
  box.innerHTML=tabs+head+(ins.length?'<div class="ins">'+ins.slice(0,2).map(t=>'<div>'+esc(t)+'</div>').join("")+'</div>':"")
    +tiles+'<details class="fold"><summary>Detail</summary>'+chart+tbl+sp+'</details>';
  $$("#progBody [data-p]").forEach(b=>b.onclick=()=>{PERIOD=b.dataset.p;renderProgress()});
}
const PCOL={positioning:"#8C2F3B",whynow:"#2E6B52",bucket:"#3D6A9E",insight:"#B5622C",bridge:"#7A5AA8",capture:"#2A7E86"};
function phaseChart(hist){
  const n=hist.length,W=Math.max(520,n*80+130),H=230,L=40,Rr=60,T=12,B=32,iw=W-L-Rr,ih=H-T-B;
  const x=i=>n===1?L+iw/2:L+i*(iw/(n-1)), y=v=>T+ih-((v-1)/9)*ih;
  let g="";
  for(let v=1;v<=10;v+=3) g+='<line x1="'+L+'" y1="'+y(v).toFixed(1)+'" x2="'+(L+iw)+'" y2="'+y(v).toFixed(1)+'" stroke="var(--line)"/>'
    +'<text x="'+(L-8)+'" y="'+(y(v)+4).toFixed(1)+'" text-anchor="end" font-family="ui-monospace,monospace" font-size="10" fill="var(--ink-3)">'+v+'</text>';
  hist.forEach((h,i)=>g+='<text x="'+x(i).toFixed(1)+'" y="'+(H-10)+'" text-anchor="middle" font-family="ui-monospace,monospace" font-size="10" fill="var(--ink-3)">'+esc(plabel(h.key,PERIOD))+'</text>');
  PHASE.forEach(p=>{
    const pts=[];
    hist.forEach((h,i)=>{ const v=h.ph[p[0]]; if(v!=null) pts.push(x(i).toFixed(1)+","+y(v).toFixed(1)) });
    if(pts.length>1) g+='<polyline points="'+pts.join(" ")+'" fill="none" stroke="'+PCOL[p[0]]+'" stroke-width="2" stroke-linejoin="round"/>';
    if(pts.length===1){const c=pts[0].split(",");g+='<circle cx="'+c[0]+'" cy="'+c[1]+'" r="3" fill="'+PCOL[p[0]]+'"/>'}
    const lastI=hist.map(h=>h.ph[p[0]]).lastIndexOf(hist.map(h=>h.ph[p[0]]).filter(v=>v!=null).slice(-1)[0]);
    const lv=hist[hist.length-1].ph[p[0]];
    if(lv!=null) g+='<text x="'+(L+iw+7)+'" y="'+(y(lv)+3.5).toFixed(1)+'" font-family="ui-monospace,monospace" font-size="9.5" fill="'+PCOL[p[0]]+'">'+esc(p[1])+'</text>';
  });
  return '<svg viewBox="0 0 '+W+' '+H+'" width="'+W+'" height="'+H+'" role="img" aria-label="Phase scores by period">'+g+'</svg>';
}
function renderLibrary(){
  let h='<p class="lede">The method is six moves. Everything else is repetition.</p><div class="steps">';
  STATES.forEach(s=>h+='<div class="sd"><b>'+s.n+'. '+esc(s.name)+'</b><span>'+esc(s.goal)+'</span></div>');
  h+='</div><div class="card"><h2>The default</h2><div class="lines">'
    +[["They ask what you do","I'm a wealth advisor. Most of my work is with business owners and families whose financial lives have gotten too complex to manage casually — cash, taxes, investments, retirement, estate planning."],
      ["They hand you an opening","What made that come up now?"],
      ["They tell you why","Is that mostly business, personal, or both?"],
      ["They narrow it","The first question usually isn't where to invest it. It's what each pool of money is supposed to do."],
      ["They resonate","This is probably better over coffee than trying to solve it here. Would grabbing coffee in the next couple weeks be a terrible idea?"],
      ["They say yes","Good. What's the best number for you?"]]
      .map(l=>'<div class="ln"><span class="lk">'+esc(l[0])+'</span><p>&ldquo;'+esc(l[1])+'&rdquo;</p></div>').join("")
    +'</div></div><div class="card"><h2>What ends a rep</h2><div class="bad-list">'
    +["Naming a product, an account type or a strategy","Explaining how something works","Telling them what they should do",
      "Talking about your firm","“I’d love to help” or “we can help with that”",
      "Asking a fourth question when they just resonated","Getting the yes and leaving it at “sounds good”"]
      .map(t=>'<div>'+esc(t)+'</div>').join("")+'</div></div>';
  $("#libBody").innerHTML=h;
}
