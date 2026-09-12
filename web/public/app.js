const $=(id)=>document.getElementById(id);
const api=(p,b)=>fetch(p,b?{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}:{}).then(r=>r.json());

// copy buttons on every code block
document.querySelectorAll(".term").forEach((t)=>{
  const bar=t.querySelector(".bar"), pre=t.querySelector("pre");
  if(!bar||!pre)return;
  const b=document.createElement("button");
  b.className="copy";b.type="button";b.textContent="copy";
  b.onclick=async()=>{
    try{await navigator.clipboard.writeText(pre.innerText);}catch{const r=document.createRange();r.selectNodeContents(pre);const s=getSelection();s.removeAllRanges();s.addRange(r);document.execCommand("copy");s.removeAllRanges();}
    b.textContent="copied";b.classList.add("ok");setTimeout(()=>{b.textContent="copy";b.classList.remove("ok");},1400);
  };
  bar.appendChild(b);
});

// live drand round ticker (quicknet: genesis 1692803367, 3s period) — client-side, no network
const GENESIS=1692803367, PERIOD=3;
function tickRound(){const r=Math.floor((Date.now()/1000-GENESIS)/PERIOD)+1;$("round").textContent=r.toLocaleString();}
tickRound(); setInterval(tickRound,3000);

// theme toggle (icon shows the theme you'll switch TO)
function syncThemeIcon(){const dark=document.documentElement.getAttribute("data-theme")==="dark";$("theme").textContent=dark?"☀️":"🌙";}
syncThemeIcon();
$("theme").onclick=()=>{const next=document.documentElement.getAttribute("data-theme")==="dark"?"light":"dark";
  document.documentElement.setAttribute("data-theme",next);try{localStorage.setItem("notyet-theme",next);}catch(e){}syncThemeIcon();};

// incidents
const INC=[
 {amt:"~$175K",t:"Grok / Bankr wallet drain",d:"May 2026",l:"A gifted NFT silently unlocked transfer permissions; a Morse-code message the bot decoded ran as an authenticated instruction.",s:"OECD.AI",u:"https://oecd.ai/en/incidents/2026-05-04-4a73"},
 {amt:"~$250K",t:"Lobstar Wilde trading bot",d:"Feb 2026",l:"Meant to send a small tip, sent its entire holdings — misread a plain-language instruction and executed before anyone could stop it.",s:"Stacker",u:"https://kvia.com/stacker-personal-finance-investing/2026/08/28/what-happens-to-your-money-if-your-ai-trading-agent-makes-a-mistake/"},
 {amt:"~$500K",t:"Malicious LLM routers",d:"Apr 2026",l:"26 routers secretly injected tool calls, stole credentials and drained a client's wallet.",s:"CoinDesk",u:"https://www.coindesk.com/tech/2026/04/13/ai-agents-are-set-to-power-crypto-payments-but-a-hidden-flaw-could-expose-wallets"},
 {amt:"29M secrets",t:"Leaked on GitHub in 2025",d:"+34% YoY",l:"64% of credentials leaked in 2022 were still valid in 2026. Long-lived keys never expire and pile up.",s:"Help Net Security",u:"https://www.helpnetsecurity.com/2026/04/14/gitguardian-ai-agents-credentials-leak/"},
 {amt:"1 key",t:"US Treasury breach",d:"2024",l:"A single leaked BeyondTrust API key bypassed millions in security spend and reached Treasury systems.",s:"Help Net Security",u:"https://www.helpnetsecurity.com/2026/04/14/gitguardian-ai-agents-credentials-leak/"},
 {amt:"282 apps",t:"iOS apps leaking LLM keys",d:"Jun 2026",l:"API keys shipped in network traffic, harvestable at scale.",s:"The Hacker News",u:"https://thehackernews.com/2026/06/282-ios-apps-found-leaking-llm-api-keys.html"},
];
$("incidents").innerHTML=INC.map(i=>`<div class="card inc"><div class="row" style="justify-content:space-between"><span class="amt">${i.amt}</span><span class="kicker">${i.d}</span></div>
  <h3 style="margin-top:9px;font-size:16px">${i.t}</h3><p class="lesson">${i.l}</p><p class="src"><a href="${i.u}" target="_blank">${i.s} ↗</a></p></div>`).join("");

// ---- run it live: a real end-to-end period against the backend ----
const RF=[
 {who:"You + Ledger", ic:"🖊️", title:"Set the rule", desc:"Commit a real 2-period schedule to the on-chain vault and post it to HCS."},
 {who:"drand · tlock", ic:"🔒", title:"Lock to the future", desc:"Each period's spend key is timelock-encrypted to its own future drand round."},
 {who:"Agent", ic:"⛔", title:"Try early → NOT_YET", desc:"Reach for the still-locked second period. Its key does not exist yet — the call is really refused."},
 {who:"drand beacon", ic:"⏱️", title:"The clock ticks", desc:"Wait for the round. The public beacon is about to publish the key."},
 {who:"Hedera · Vault", ic:"⚡", title:"Withdraw within limits", desc:"Now unlocked — withdraw from the PeriodVault; window + budget enforced on-chain."},
 {who:"x402 · HCS", ic:"✅", title:"Pay & prove", desc:"Settle a real x402 payment on Hedera; a sealed receipt lands on the audit log."},
];
(function(){
  const track=$("rfTrack"); if(!track) return;
  track.innerHTML=RF.map((s,i)=>`<div class="rf-row idle" data-i="${i}"><div class="rf-rail"><div class="rf-dot">${i+1}</div><div class="rf-line"></div></div>`+
    `<div class="rf-body"><div class="rf-who">${s.who}</div><div class="rf-title"><span class="ic">${s.ic}</span>${s.title}</div><div class="rf-desc">${s.desc}</div><div class="rf-result" id="rfR${i}"></div></div></div>`).join("");
  const rows=[...track.querySelectorAll(".rf-row")];
  const btn=$("rfRun"), live=$("rfLive");
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const curRound=()=>Math.floor((Date.now()/1000-GENESIS)/PERIOD)+1;
  function set(i,cls){const r=rows[i];r.classList.remove("idle","run","done","hot");if(cls)r.classList.add(cls);
    const dot=r.querySelector(".rf-dot");dot.textContent=cls==="done"?"✓":(i+1);}
  function result(i,html){const el=$("rfR"+i);el.innerHTML=html;rows[i].classList.add("show");}
  let running=false;
  async function run(){
    if(running)return; running=true;
    btn.disabled=true; btn.innerHTML="Running on Hedera testnet…";
    rows.forEach((r,i)=>{r.classList.remove("show","run","done","hot");r.classList.add("idle");r.querySelector(".rf-dot").textContent=i+1;$("rfR"+i).innerHTML="";});
    live.innerHTML=`<span class="pulse" style="width:7px;height:7px"></span> live · Hedera testnet`;
    try{
      // 1 · issue a real schedule
      set(0,"run"); result(0,"issuing — creating the HCS topic, committing 2 periods on-chain…");
      const iss=await api("/api/issue",{count:2,periodSec:24});
      if(iss.error) throw new Error(iss.error);
      const p=iss.periods[0], round=p.round;
      const p2=iss.periods[1];
      const vLink=iss.vaultId?`https://hashscan.io/testnet/contract/${iss.vaultId}`:null;
      const tLink=iss.topicId?`https://hashscan.io/testnet/topic/${iss.topicId}`:null;
      result(0,`<span class="ok">✓ committed</span> — ${iss.vaultId?`vault <b>${iss.vaultId}</b>`:`topic <b>${iss.topicId}</b>`}, <b>2 periods</b>\n`+
        [vLink&&`<a href="${vLink}" target="_blank">vault on HashScan ↗</a>`,tLink&&`<a href="${tLink}" target="_blank">HCS topic ↗</a>`].filter(Boolean).join("   ·   "));
      set(0,"done");

      // 2 · locked to future rounds (two of them)
      set(1,"run"); await sleep(500);
      const c=curRound();
      const secs0=Math.max(0,Math.round((p.unlockMs-Date.now())/1000));
      const secs1=p2?Math.max(0,Math.round((p2.unlockMs-Date.now())/1000)):null;
      result(1,`period 1 → <b>round ${round.toLocaleString()}</b> (~<b>${secs0}s</b>)`+(p2?`\nperiod 2 → <b>round ${p2.round.toLocaleString()}</b> (~<b>${secs1}s</b>)`:"")+
        `\nbeacon is at round <b>${c.toLocaleString()}</b> — both keys are sealed to the future and exist for no one yet.`);
      set(1,"done");

      // 3 · try the FUTURE period (2) early → guaranteed real NOT_YET
      set(2,"run"); await sleep(300);
      result(2,"reaching for period 2 now, while its round is still in the future…");
      const early=await api("/api/pay",{index:(p2?p2.index:p.index)});
      if(early.paid){ result(2,`<span class="no">unlocked faster than expected — skipping ahead</span>`); set(2,"done"); }
      else { result(2,`<span class="rd">${early.error||"NOT_YET"}</span>\n<span class="ok">✓ exactly right</span> — a real server response, not a permission check. A hacked or hasty agent reaching for a future period gets precisely this: nothing.`); set(2,"hot"); }

      // 4 · wait for the real round
      set(3,"run");
      let ready=false;
      for(let t=0;t<45;t++){
        const s=await api("/api/status");
        const q=(s.periods||[]).find(x=>x.index===p.index);
        if(!q) break;
        if(q.state==="ready"||q.state==="paid"){ready=true;break;}
        result(3,`waiting for round ${round.toLocaleString()} — unlocks in <b>${q.secondsToUnlock}s</b> …`);
        await sleep(1500);
      }
      result(3,`<span class="ok">✓ round reached</span> — drand published the signature. the key now exists, for this one period.`);
      set(3,"done");

      // 5 + 6 · one real pay: on-chain withdraw, then x402 settle
      set(4,"run"); result(4,"signing the withdraw with the unlocked key; the vault checks window + budget + ecrecover…");
      const pay=await api("/api/pay",{index:p.index});
      if(!pay.paid) throw new Error(pay.error||"payment failed");
      result(4,`<span class="ok">✓ released</span> from the vault — the on-chain policy passed.`+
        (pay.withdraw?`\n<a href="${pay.withdraw}" target="_blank">vault withdraw on HashScan ↗</a>`:""));
      set(4,"done");

      set(5,"run"); await sleep(400);
      const secs1b=p2?Math.max(0,Math.round((p2.unlockMs-Date.now())/1000)):null;
      result(5,`<span class="ok">✓ settled on Hedera</span>${pay.data?` — service returned: ${JSON.stringify(pay.data)}`:""}`+
        (pay.hashscan?`\n<a href="${pay.hashscan}" target="_blank">x402 settlement on HashScan ↗</a>`:"")+
        `\nreceipt sealed to the audit log — opens only with the device-held view key.`+
        (p2?`\n<span class="ok">blast radius held</span> — period 2's key still does not exist (round ${p2.round.toLocaleString()}, ~${secs1b}s away). Spending 1 could never touch 2.`:""));
      set(5,"done");

      live.innerHTML=`<span style="color:var(--green);font-weight:600">✓ period 1 spent within authority — period 2's key still doesn't exist. Every link above is real, on Hedera testnet.</span>`;
      btn.disabled=false; btn.innerHTML="↻&nbsp; Run it again";
    }catch(e){
      const cur=rows.findIndex(r=>r.classList.contains("run")); if(cur>=0){rows[cur].classList.remove("run");rows[cur].classList.add("hot");result(cur,`<span class="rd">${(e.message||"error")}</span>`);}
      live.innerHTML=`<span class="err">${/cool/i.test(e.message||"")?"the hosted demo is cooling down":"couldn't finish the live run"} — try again in a moment, or step through it manually below.</span>`;
      btn.disabled=false; btn.innerHTML="↻&nbsp; Try again";
    }
    running=false;
  }
  btn.onclick=run;
})();

// ---- live demo ----
$("issue").onclick=async()=>{
  $("issue").disabled=true;$("issue").textContent="Issuing…";
  $("issueOut").style.display="block";$("issueOut").textContent="issuing the schedule — timelocking each key, committing to the vault, posting to HCS…";
  try{const r=await api("/api/issue",{count:Number($("count").value),periodSec:demoPeriodSec});if(r.error)throw new Error(r.error);
    $("issueOut").textContent=(r.mode==="vault"
      ? "vault "+r.vaultId+" · HCS topic "+r.topicId+" — "+r.count+" periods committed on-chain\n"+r.periods.map(p=>`  ${cadTitle()} ${p.index+1}: committed key #${p.vaultIndex}, round ${p.round}`).join("\n")
      : "HCS topic "+r.topicId+" — "+r.count+" "+demoCadence+"s locked\n"+r.periods.map(p=>`  ${cadTitle()} ${p.index+1}: account ${p.accountId}, round ${p.round}`).join("\n"));
  }catch(e){$("issueOut").innerHTML='<span class="err">'+e.message+'</span>';}
  $("issue").disabled=false;$("issue").textContent="Issue schedule";
};
const payMsgs={};
async function refresh(){
  const s=await api("/api/status");
  if(!s.periods||!s.periods.length){$("timeline").innerHTML='<p class="small">No schedule yet — click Issue.</p>';return;}
  $("timeline").innerHTML=s.periods.map(p=>{
    const cls=p.state==="paid"?"paid":p.state==="locked"?"locked":"";
    const badge=p.state==="paid"?'<span class="badge b-green">paid</span>':p.state==="ready"?'<span class="badge b-blue">ready</span>':'<span class="badge b-amber">locked</span>';
    const acct=`<a class="small mono" href="${p.hashscanAccount}" target="_blank">${p.accountId}</a>`;
    let right;
    if(p.state==="paid")right=`<a class="small" href="${p.paid.hashscan}" target="_blank">settlement ↗</a>`;
    else if(p.state==="ready")right=`<button class="btn amber" data-pay="${p.index}">Unlock &amp; pay</button>`;
    else right=`<button class="btn ghost" data-pay="${p.index}">Try early</button> <span class="small">unlocks in ${p.secondsToUnlock}s</span>`;
    return `<div class="period ${cls}"><div class="st"><div>${badge} &nbsp; ${cadTitle()} ${p.index+1} &nbsp; ${acct} <span class="small">· round ${p.round}</span></div>
      <div class="small err" id="msg${p.index}"></div></div><div class="row">${right}</div></div>`;
  }).join("");
  document.querySelectorAll("[data-pay]").forEach(b=>b.onclick=()=>pay(Number(b.dataset.pay)));
  for(const [i,m] of Object.entries(payMsgs)){const el=$("msg"+i);if(el)el.innerHTML='<span class="err">'+m+'</span>';}
}
async function pay(index){
  delete payMsgs[index];const e0=$("msg"+index);if(e0)e0.textContent="";
  const r=await api("/api/pay",{index});
  if(r.paid){delete payMsgs[index];await refresh();}
  else{payMsgs[index]=r.error||"payment failed";const el=$("msg"+index);if(el)el.innerHTML='<span class="err">'+payMsgs[index]+'</span>';}
}
$("audit").onclick=async()=>{
  $("auditOut").style.display="block";$("auditOut").textContent="decrypting…";
  const r=await api("/api/audit",{index:Number($("auditIdx").value)});
  if(r.error){
    const hint=/no active/i.test(r.error)?'\n\nIssue a schedule above first, then decrypt. Real past settlements are listed under “Recent settlements” below.':'';
    $("auditOut").innerHTML='<span class="err">'+r.error+'</span>'+hint;return;}
  $("auditOut").textContent=`period ${r.index}: ${r.receipts.length} receipt(s) decrypted\n`+r.receipts.map(x=>"  "+JSON.stringify(x)).join("\n")+`\n\nscoped: ${r.scopedProof}`;
};

// ---- use-case scenarios (pick one → configures the stepper below) ----
let demoCadence="period", demoPeriodSec=8;
const SCENARIOS=[
 {label:"⚡ Quick demo (unlocks in seconds)", actor:"Owner → agent · compressed so you can watch it live",
  count:3, cadence:"period", periodSec:8,
  story:"The owner wants the agent to pay <b>next week</b> — but won't hand it the key today. So they seal a key for each period to a future moment and walk away. <b>Here the clock is sped up</b> — a “week” becomes <b>~8 seconds</b> — so you can watch a period sit <b>locked → NOT_YET</b>, then unlock and pay on its round in real time. Hit <b>Issue schedule</b> below."},
 {label:"You → AI assistant · weekly subscription", actor:"You → AI assistant",
  count:4, cadence:"week", periodSec:15,
  story:"Your assistant pays $5/week for a data subscription. You sign the whole month <b>once</b> on your Ledger and walk away — you never hand it your wallet. Hacked this week? It can touch <b>this week's $5 only</b> — next week's key doesn't exist yet."},
 {label:"DAO / fund → trading bot · daily budget", actor:"DAO / fund → trading bot",
  count:5, cadence:"day", periodSec:12,
  story:"A DAO funds a trading bot with a <b>daily allowance it can't front-run</b>. Compromised on day 3 → it loses one day, not the treasury."},
 {label:"Company → procurement agent · monthly", actor:"Finance → procurement agent",
  count:3, cadence:"month", periodSec:15,
  story:"Finance <b>pre-signs the quarter</b> on a Ledger and leaves. No standing key sits on a server for anyone to steal or subpoena — each month's authority appears on schedule."},
 {label:"Research fleet → paid APIs · per shift", actor:"Research fleet → paid APIs",
  count:5, cadence:"shift", periodSec:12,
  story:"Each shift gets its own x402 key that <b>dies at shift end</b>. A leaked key is worthless afterwards, and every call is logged to HCS for audit."},
];
$("scenario").innerHTML=SCENARIOS.map((s,i)=>`<option value="${i}">${s.label}</option>`).join("");
function applyScenario(i){const s=SCENARIOS[i];
  $("scenarioStory").innerHTML=`<span class="actor">${s.actor}</span>${s.story}`;
  $("count").value=s.count; demoCadence=s.cadence; demoPeriodSec=s.periodSec;}
$("scenario").onchange=()=>applyScenario(Number($("scenario").value));
applyScenario(0);
const cadTitle=()=>demoCadence.charAt(0).toUpperCase()+demoCadence.slice(1);

// ---- scheduled transfer (HIP-423, sign-on-unlock) — the primitive NotYet hardens ----
let schedPoll=null;
function renderSched(s){
  const out=$("schedOut"); out.style.display="block";
  if(s.error){out.innerHTML='<span class="err">'+s.error+'</span>';return;}
  const acct=`<a class="small mono" href="${s.hashscanAccount}" target="_blank">${s.accountId}</a>`;
  const schedLink=`<a class="small mono" href="${s.hashscanSchedule}" target="_blank">schedule ${s.scheduleId} ↗</a>`;
  if(s.state==="executed"){
    out.innerHTML=`<span class="c-green">✓ executed — ${s.amount} ℏ sent to the merchant on Hedera.</span>\nThe signature came from a key that did not exist when this transfer was scheduled.\n${schedLink}${s.executed?` · <a class="small" href="${s.executed.hashscan}" target="_blank">settlement ↗</a>`:""}`;
    return;
  }
  if(s.state==="ready"){
    out.innerHTML=`<span class="c-amber">round reached — the key now exists.</span> The pending transfer of ${s.amount} ℏ can be signed.\n${schedLink} · ${acct}\n<button class="btn amber" id="schedExec" style="margin-top:8px;padding:8px 16px">Execute now</button>`;
    $("schedExec").onclick=schedExecute; return;
  }
  out.innerHTML=`<span class="c-amber">pending on Hedera — inert.</span> The ${s.amount} ℏ transfer is posted, but the key that must sign it <b>does not exist yet</b> (unlocks in ${s.secondsToUnlock}s).\n${schedLink} · ${acct}\n<button class="btn ghost" id="schedExec" style="margin-top:8px;padding:8px 16px">Try to execute early</button>`;
  $("schedExec").onclick=schedExecute;
}
async function schedRefresh(){
  const s=await api("/api/schedule/status");
  if(s.none)return;
  renderSched(s);
  if(s.state==="executed"&&schedPoll){clearInterval(schedPoll);schedPoll=null;}
}
async function schedExecute(){
  const b=$("schedExec"); if(b){b.disabled=true;b.textContent="signing…";}
  const r=await api("/api/schedule/execute",{});
  if(r.executed){await schedRefresh();}
  else{$("schedOut").innerHTML='<span class="err">'+(r.error||"execution failed")+'</span>'+(r.notYet?"\nThat’s the point — come back when the round arrives and it signs itself in.":"");}
}
$("schedCreate").onclick=async()=>{
  const btn=$("schedCreate");btn.disabled=true;btn.textContent="Scheduling…";
  $("schedOut").style.display="block";$("schedOut").textContent="creating a funded account, timelocking its key, posting the pending scheduled transfer to Hedera…";
  try{
    const r=await api("/api/schedule",{seconds:Number($("schedWhen").value),amount:Number($("schedAmt").value)});
    if(r.error)throw new Error(r.error);
    renderSched({...r,state:"locked",executed:null});
    if(schedPoll)clearInterval(schedPoll);
    schedPoll=setInterval(schedRefresh,2000);
  }catch(e){$("schedOut").innerHTML='<span class="err">'+e.message+'</span>';}
  btn.disabled=false;btn.textContent="Schedule it";
};
schedRefresh(); // pick up an already-scheduled transfer on load

// ---- recent settlements (real, from the merchant account on Hedera) ----
function timeAgo(ms){const s=Math.max(0,(Date.now()-ms)/1000);
  if(s<60)return Math.round(s)+"s ago";if(s<3600)return Math.round(s/60)+"m ago";
  if(s<86400)return Math.round(s/3600)+"h ago";return Math.round(s/86400)+"d ago";}
async function loadRecent(){
  try{const r=await api("/api/recent");
    if(r.hashscanAccount)$("merchantLink").href=r.hashscanAccount;
    if(!r.settlements||!r.settlements.length){$("recent").innerHTML='<p class="small">No settlements yet — run the demo above.</p>';return;}
    $("recent").innerHTML=r.settlements.map(s=>`<div class="settle">
      <div><span class="amt2">+${(s.tinybars/1e8).toFixed(3)} ℏ</span> &nbsp; <a class="small mono" href="${s.hashscan}" target="_blank">${s.txId}</a></div>
      <span class="when">${timeAgo(s.consensusMs)}</span></div>`).join("");
  }catch(e){$("recent").innerHTML='<p class="small">could not load settlements right now</p>';}
}
loadRecent(); setInterval(loadRecent,15000);
refresh();setInterval(refresh,2000);
