// === State & Utilities ===
const $ = (sel)=>document.querySelector(sel);
const app = $("#app");
const loginBtn=$("#login-btn"); const logoutBtn=$("#logout-btn");
const installBtn=$("#install-btn");

let deferredPrompt=null;
window.addEventListener('beforeinstallprompt',(e)=>{e.preventDefault();deferredPrompt=e;installBtn.hidden=false;});
installBtn.addEventListener('click',async()=>{if(!deferredPrompt)return;deferredPrompt.prompt();await deferredPrompt.userChoice;installBtn.hidden=true;deferredPrompt=null;});

// Google Identity Services
const SCOPES='https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly';
let googleTokenClient=null; let accessToken=null; let userHintEmail=null;

function initGoogle() {
  if (!google?.accounts?.oauth2) { setTimeout(initGoogle, 200); return; }
  googleTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: getClientId(),
    scope: SCOPES,
    callback: (resp)=>{
      if (resp.error) { alert('Google-inloggning misslyckades.'); return; }
      accessToken = resp.access_token;
      loginBtn.hidden=true; logoutBtn.hidden=false;
      startAfterLogin();
    }
  });
  // Try silent token on load to avoid prompting every time if previously granted
  trySilentToken();
}

function getClientId(){
  // You can hardcode your Client ID here if you prefer; otherwise prompt the user once.
  const CID=localStorage.getItem('googleClientId');
  if(CID) return CID;
  const v=prompt('Ange ditt Google OAuth Client ID (Web):');
  if(!v){ alert('Client ID krävs för att fortsätta.'); throw new Error('Missing Client ID'); }
  localStorage.setItem('googleClientId', v.trim());
  return v.trim();
}

function trySilentToken(){
  try {
    googleTokenClient.requestAccessToken({ prompt: '' }); // no prompt if already granted & session exists
  } catch {}
}

loginBtn.addEventListener('click',()=>{
  if(!googleTokenClient) initGoogle();
  else googleTokenClient.requestAccessToken({ prompt: 'consent' });
});
logoutBtn.addEventListener('click',()=>{
  accessToken=null;
  loginBtn.hidden=false; logoutBtn.hidden=true;
  renderWelcome();
});

async function gapi(path, method='GET', body=null, headers={}){
  if(!accessToken) throw new Error('Inte inloggad.');
  const res = await fetch(`https://www.googleapis.com${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${accessToken}`, ...headers },
    body
  });
  if(!res.ok) throw new Error(await res.text());
  return res;
}

// === Views ===
function renderWelcome(){
  app.innerHTML = `
    <section class="card">
      <h1>Välkommen</h1>
      <p>Logga in med Google för att fortsätta.</p>
      <div class="notice small">
        Försöker hämta token tyst om du gett tillåtelse tidigare och fortfarande är inloggad på Google i webbläsaren.
      </div>
    </section>
  `;
}
renderWelcome();
window.addEventListener('load', initGoogle);

// After login: check for league.json
async function startAfterLogin(){
  app.innerHTML = `<section class="card"><h2>Läser in...</h2></section>`;
  try{
    const file = await findLeagueFile();
    if(!file){
      renderCreateLeague();
    }else{
      const data = await loadLeague(file.id);
      renderEditor(data, file.id);
    }
  }catch(e){
    alert('Fel vid inläsning: '+e.message);
    renderWelcome();
  }
}

async function findLeagueFile(){
  const q = encodeURIComponent("name = 'league.json' and trashed = false");
  const res = await gapi(`/drive/v3/files?q=${q}&pageSize=1&fields=files(id,name)`);
  const data = await res.json();
  return (data.files && data.files[0]) || null;
}

async function loadLeague(fileId){
  const res = await gapi(`/drive/v3/files/${fileId}?alt=media`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return null; }
}

function renderCreateLeague(){
  app.innerHTML = `
    <section class="card">
      <h2>Skapa ny liga</h2>
      <div class="grid">
        <label>Ligans namn <input id="league-name" placeholder="Allsvenskan Sim"></label>
        <label>Antal divisioner <input id="num-div" type="number" min="1" max="10" value="1"></label>
        <label>Lag per division <input id="teams-per" type="number" min="2" max="24" value="12"></label>
        <label>Matchtid (sek) <input id="match-sec" type="number" min="10" max="60" value="30"></label>
        <label>Upp/Ner per division <input id="prom-rel" type="number" min="0" max="6" value="2"></label>
      </div>
      <div class="row">
        <button id="create-btn" class="primary">Skapa liga</button>
        <button id="cancel-btn" class="ghost">Avbryt</button>
      </div>
      <p class="small muted">Du redigerar lag och koefficienter på nästa skärm.</p>
    </section>
  `;
  $("#cancel-btn").addEventListener('click', renderWelcome);
  $("#create-btn").addEventListener('click', async ()=>{
    const name=$("#league-name").value.trim()||"Min Liga";
    const numDiv=clamp(parseInt($("#num-div").value||"1"),1,10);
    const teamsPer=clamp(parseInt($("#teams-per").value||"12"),2,24);
    const matchSec=clamp(parseInt($("#match-sec").value||"30"),10,60);
    const promRel=clamp(parseInt($("#prom-rel").value||"2"),0,6);

    const league = makeEmptyLeague(name, numDiv, teamsPer, matchSec, promRel);
    try{
      const fileId = await saveLeague(league, null);
      renderEditor(league, fileId);
    }catch(e){
      alert('Kunde inte spara liga: '+e.message);
    }
  });
}

function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }

function makeEmptyLeague(name, numDiv, teamsPer, matchSec, promRel){
  const divisions = [];
  for(let d=0; d<numDiv; d++){
    const teams=[];
    for(let i=0;i<teamsPer;i++){
      teams.push({ name:`Lag ${d+1}-${i+1}`, attack:1.0, defense:1.0 });
    }
    divisions.push({ name:`Division ${d+1}`, teams });
  }
  return {
    schemaVersion:1,
    name,
    matchSeconds: matchSec,
    promotionRelegation: promRel,
    divisions
  };
}

async function saveLeague(obj, existingId){
  const boundary='-------314159265358979323846';
  const meta={ name:'league.json' };
  const content = JSON.stringify(obj, null, 2);
  const body=`--${boundary}\r
Content-Type: application/json; charset=UTF-8\r
\r
${JSON.stringify(meta)}\r
--${boundary}\r
Content-Type: application/json\r
\r
${content}\r
--${boundary}--`;
  if(existingId){
    await gapi(`/upload/drive/v3/files/${existingId}?uploadType=multipart`, 'PATCH', body, {'Content-Type': 'multipart/related; boundary='+boundary});
    return existingId;
  }else{
    const res = await gapi('/upload/drive/v3/files?uploadType=multipart', 'POST', body, {'Content-Type': 'multipart/related; boundary='+boundary});
    const data = await res.json();
    return data.id;
  }
}

function renderEditor(league, fileId){
  // Build team editor table
  const divTabs = league.divisions.map((d,idx)=>`<option value="${idx}">${d.name}</option>`).join('');
  app.innerHTML = `
    <section class="card">
      <h2>Redigera liga</h2>
      <div class="grid">
        <label>Ligans namn <input id="e-league-name" value="${escapeHtml(league.name)}"></label>
        <label>Matchtid (10–60s) <input id="e-match-sec" type="number" min="10" max="60" value="${league.matchSeconds}"></label>
        <label>Upp/Ner per division <input id="e-prom-rel" type="number" min="0" max="6" value="${league.promotionRelegation}"></label>
      </div>
      <div class="row" style="align-items:center">
        <label class="col">Division <select id="division-select">${divTabs}</select></label>
        <button id="add-div" class="ghost">+ Lägg till division</button>
        <button id="rem-div" class="ghost">– Ta bort division</button>
      </div>
      <div id="teams-wrap"></div>
      <div class="row">
        <button id="save-btn" class="primary">Spara liga</button>
        <button id="simulate-btn" class="ghost">Starta simulering</button>
      </div>
    </section>
  `;

  const divSelect = $("#division-select");
  function renderTeamsTable(){
    const d = league.divisions[parseInt(divSelect.value)];
    const rows = d.teams.map((t, i)=>`
      <tr>
        <td>${i+1}</td>
        <td><input data-i="${i}" data-k="name" value="${escapeHtml(t.name)}"></td>
        <td><input type="number" step="0.1" min="0" max="10" data-i="${i}" data-k="attack" value="${t.attack}"></td>
        <td><input type="number" step="0.1" min="0" max="10" data-i="${i}" data-k="defense" value="${t.defense}"></td>
        <td><button data-i="${i}" class="ghost del-team">Ta bort</button></td>
      </tr>
    `).join('');
    $("#teams-wrap").innerHTML = `
      <div class="row">
        <button id="add-team" class="ghost">+ Lägg till lag</button>
      </div>
      <table class="table">
        <thead><tr><th>#</th><th>Lag</th><th>Anfall</th><th>Försvar</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    $("#add-team").addEventListener('click', ()=>{
      d.teams.push({name:`Nytt lag ${d.teams.length+1}`, attack:1.0, defense:1.0});
      renderTeamsTable();
    });
    Array.from(document.querySelectorAll('button.del-team')).forEach(btn=>{
      btn.addEventListener('click',()=>{
        const i=parseInt(btn.dataset.i);
        d.teams.splice(i,1);
        renderTeamsTable();
      });
    });
    Array.from(document.querySelectorAll('#teams-wrap input')).forEach(inp=>{
      inp.addEventListener('input',()=>{
        const i=parseInt(inp.dataset.i); const k=inp.dataset.k;
        let v = inp.value;
        if(k!=='name'){ v = clamp(parseFloat(v||'0'),0,10); }
        d.teams[i][k]=k==='name'? v : Number(v);
      });
    });
  }

  divSelect.addEventListener('change', renderTeamsTable);
  $("#add-div").addEventListener('click', ()=>{
    league.divisions.push({name:`Division ${league.divisions.length+1}`, teams:[]});
    divSelect.innerHTML = league.divisions.map((d,idx)=>`<option value="${idx}">${d.name}</option>`).join('');
    divSelect.value = String(league.divisions.length-1);
    renderTeamsTable();
  });
  $("#rem-div").addEventListener('click', ()=>{
    if(league.divisions.length<=1) return alert('Minst en division krävs.');
    const idx=parseInt(divSelect.value);
    league.divisions.splice(idx,1);
    divSelect.innerHTML = league.divisions.map((d,idx)=>`<option value="${idx}">${d.name}</option>`).join('');
    divSelect.value = "0";
    renderTeamsTable();
  });

  $("#e-league-name").addEventListener('input',(e)=>league.name=e.target.value);
  $("#e-match-sec").addEventListener('input',(e)=>league.matchSeconds=clamp(parseInt(e.target.value||'30'),10,60));
  $("#e-prom-rel").addEventListener('input',(e)=>league.promotionRelegation=clamp(parseInt(e.target.value||'2'),0,6));

  $("#save-btn").addEventListener('click', async ()=>{
    try{ 
      const id = await saveLeague(league, fileId);
      alert('Ligan sparad.');
    } catch(e){ alert('Fel vid sparning: '+e.message); }
  });

  $("#simulate-btn").addEventListener('click', ()=>{
    alert('Simulering implementeras i nästa steg – nu fokuserar vi på strukturen & lagredigeringen enligt din spec.');
  });

  renderTeamsTable();
}

function escapeHtml(s){ return (s??'').replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;' }[m])); }

// Helpers
function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }
