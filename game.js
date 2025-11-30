/* ===========================
   Skystones — Campaign + Labeler
   - Uses JS manifest (assets/stones.manifest.js) if present
   - Campaign map (10 levels), Local 2P
   - Fixed capture + AI
   - 3D tilt
   - Labeler for spikes + rarity + file paths; Export JS manifest
=========================== */

(function(){
  /* --- Error banner --- */
  window.onerror = function(msg, src, line, col){
    const b = document.getElementById("errorBanner");
    if(b){ b.innerHTML = `JS Error: ${msg}<br><small>${src||""} ${line||""}:${col||""}</small>`; b.classList.remove("hide"); }
  };
  const showError  = (html)=>{ const b=document.getElementById("errorBanner"); if(b){ b.innerHTML=html; b.classList.remove("hide"); } };
  const hideError  = ()=>{ document.getElementById("errorBanner")?.classList.add("hide"); };

  /* --- Helpers --- */
  const q  = (s,r=document)=> r.querySelector(s);
  const qa = (s,r=document)=> Array.from(r.querySelectorAll(s));
  const v  = (n)=> (n==null?0:Number(n));

  /* --- Music --- */
  let audio = null;

  /* --- Manifest (window.ALL_STONES) --- */
  let ALL = [];
  try{ if(Array.isArray(window.ALL_STONES)) ALL = window.ALL_STONES; }catch{}
  if(!ALL.length){
    // Won't crash: you can still open Labeler and export a manifest
    showError(`No stones loaded. Add <code>assets/stones.manifest.js</code> or use the Labeler to export one.`);
  }

  /* --- Game state --- */
  const SIZE=3;
  const LABELER_PASSWORD = "colliniscool8";
  const ONLINE_SERVER_URL = window.ONLINE_SERVER_URL || "ws://localhost:3001";
  const ONLINE_SERVER_LABEL = (()=> {
    try{
      const parsed = new URL(ONLINE_SERVER_URL);
      return `${parsed.protocol}//${parsed.host}`;
    }catch{
      return ONLINE_SERVER_URL;
    }
  })();
  const MAX_LEVELS=15;
  let board, P1, P2, current, selected=null;
  let lastEnemyDeckEntries = [];
  let gameMode = "menu"; // "menu"|"campaign"|"local"|"online"
  let currentLevelIndex = 1;
  let labelerUnlocked = false;
  let onlineSession = {
    ws:null,
    connected:false,
    roomId:null,
    role:null,
    myTurn:false,
    active:false,
    pendingLoadout:null
  };
  const CHAR_STORE="skystones_characters_v1";
  const defaultCharacter = (index)=>({
    id:`level_${index+1}`,
    name:`Rival ${index+1}`,
    avatar:"assets/avatars/default.png",
    lines:{
      capture:["Got one!"],
      captured:["You won't keep that!"],
      win:["Victory is mine!"],
      lose:["I won't forget this..."]
    }
  });
  const defaultCharacters = ()=> Array.from({length:MAX_LEVELS}, (_,i)=> defaultCharacter(i));
  let campaignCharacters = loadCharacterData();
  campaignCharacters.forEach(char=>{ if(char) ensureCharacterLines(char); });
  let currentOpponent = null;
  let opponentLineTimeout = null;
  let turnBannerTimeout = null;
  const HYPE_WINDOW = 700;
  const SURVIVAL_STORE="skystones_survival_v1";
  let survivalState = loadSurvivalState();
  let survivalHistory = loadSurvivalHistory();
  let survivalDeckEntries = [];
  let survivalDraftPool = [];
  const SURVIVAL_PICK_COUNT = 5;

  /* --- Campaign progress --- */
  const STORE="skystones_campaign_v2";
  const defProg = ()=>({unlocked:1, collection:[], loadout:[], beaten:Array(MAX_LEVELS).fill(false)});
  let progress = (()=>{
    try{
      const raw=localStorage.getItem(STORE);
      if(!raw) return defProg();
      const p=JSON.parse(raw);
      p.unlocked=Math.min(MAX_LEVELS,Math.max(1,p.unlocked||1));
      if(!Array.isArray(p.collection)) p.collection=[];
      if(!Array.isArray(p.loadout)) p.loadout=[];
      if(!Array.isArray(p.beaten)) p.beaten=Array(MAX_LEVELS).fill(false);
      while(p.beaten.length<MAX_LEVELS) p.beaten.push(false);
      return p;
    }catch{ return defProg(); }
  })();
  const saveProgress = ()=>{ try{ localStorage.setItem(STORE, JSON.stringify(progress)); }catch{} };
  function loadCharacterData(){
    try{
      const raw=localStorage.getItem(CHAR_STORE);
      if(!raw) return defaultCharacters();
      const data=JSON.parse(raw);
      if(!Array.isArray(data)) return defaultCharacters();
      while(data.length<MAX_LEVELS) data.push(defaultCharacter(data.length));
      return data.slice(0,MAX_LEVELS);
    }catch{ return defaultCharacters(); }
  }
  const saveCharacters = ()=>{ try{ localStorage.setItem(CHAR_STORE, JSON.stringify(campaignCharacters)); }catch{} };
  function getCharacter(level){
    return campaignCharacters[Math.max(0, Math.min(MAX_LEVELS-1, (level|0)-1))] || defaultCharacter((level|0)-1);
  }
  const normalizeLines = (txt)=> (txt||"").split(/\n+/).map(s=>s.trim()).filter(Boolean);

  /* --- Boot wiring --- */
  document.addEventListener("DOMContentLoaded", ()=>{
    // Toolbar
    q("#btnMenu")?.addEventListener("click", ()=> showView("menu"));
    audio = new Audio("assets/audio/theme.mp3"); audio.loop=true; audio.volume=0.5;
    q("#btnMusic")?.addEventListener("click", async()=>{ try{ if(audio.paused) await audio.play(); else audio.pause(); }catch{} });
    const toolsMenu = q("#toolbarToolsMenu");
    const toolsButton = q("#btnLabelerToolbar");
    const closeToolsMenu = ()=> toolsMenu?.classList.remove("show");
    toolsButton?.addEventListener("click", (ev)=>{
      ev.preventDefault();
      ev.stopPropagation();
      toolsMenu?.classList.toggle("show");
    });
    q("#toolbarToolLabeler")?.addEventListener("click", ()=>{
      closeToolsMenu();
      requestLabelerAccess();
    });
    q("#toolbarToolOpponents")?.addEventListener("click", ()=>{
      closeToolsMenu();
      requestCharacterAccess();
    });
    document.addEventListener("click", (ev)=>{
      if(!toolsMenu?.classList.contains("show")) return;
      if(ev.target===toolsButton) return;
      if(toolsMenu.contains(ev.target)) return;
      closeToolsMenu();
    });
    document.addEventListener("keydown", (ev)=>{
      if(ev.key==="Escape") closeToolsMenu();
    });
    q("#volumeRange")?.addEventListener("input", e=> audio.volume = Number(e.target.value));
    audio.play().catch(()=>{ /* click dYZ? to start if blocked */ });

    // Menu buttons
    q("#btnCampaign")?.addEventListener("click", openCampaign);
    q("#btnLocal")?.addEventListener("click", startLocal);
    q("#btnSurvival")?.addEventListener("click", openSurvivalView);
    q("#btnStartSurvival")?.addEventListener("click", startSurvivalRun);
    q("#btnResetSurvival")?.addEventListener("click", resetSurvivalProgress);
    q("#btnOnline")?.addEventListener("click", openOnlineLobby);
    q("#btnOnlineCreate")?.addEventListener("click", createOnlineRoom);
    q("#btnOnlineJoin")?.addEventListener("click", joinOnlineRoom);
    q("#btnCharacters")?.addEventListener("click", requestCharacterAccess);
    q("#survivalDraftCancel")?.addEventListener("click", ()=>{
      closeSurvivalDraft();
      survivalRunActive=false;
      openSurvivalView();
    });
    q("#survivalDraftLock")?.addEventListener("click", finalizeSurvivalDraft);

    // Campaign header
    q("#btnEditLoadout")?.addEventListener("click", ()=> openLoadoutPicker(progress.collection,5,"Edit Campaign Loadout"));
    q("#btnResetCampaign")?.addEventListener("click", ()=> { progress=defProg(); saveProgress(); ensureStartingCollection(); buildLevelMap(); });

    // Game header
    q("#btnBackToMap")?.addEventListener("click", ()=> {
      if(gameMode==="campaign"){
        buildLevelMap(); showView("campaign");
      }else if(gameMode==="online"){
        exitOnlineMatch(true);
        openOnlineLobby();
      }else if(gameMode==="survival"){
        finishSurvivalRun({record:false});
        openSurvivalView();
      } else {
        showView("menu");
      }
    });
    q("#btnRestart")?.addEventListener("click", ()=> {
      if(gameMode==="campaign") startLevel(currentLevelIndex);
      else if(gameMode==="local") startLocal();
      else if(gameMode==="online") alert("Restart isn't available during online matches.");
      else if(gameMode==="survival") startSurvivalWave();
    });
    q("#btnForfeit")?.addEventListener("click", ()=> {
      if(gameMode==="campaign") openModal("Defeat","You forfeited.","Back to Map", ()=>{ buildLevelMap(); showView("campaign"); },"Close");
      else if(gameMode==="online"){ exitOnlineMatch(true); openOnlineLobby(); }
      else if(gameMode==="survival"){
        const final=finishSurvivalRun({record:true});
        presentOutcome({
          title:"Run Abandoned",
          details:`Final streak: ${final}`,
          primary:{label:"Back to Survival", action:openSurvivalView},
          secondary:null
        });
      } else showView("menu");
    });

    // Modal
    q("#modalPrimary")?.addEventListener("click", ()=> closeModal());
    q("#modalSecondary")?.addEventListener("click", ()=> closeModal());

    // Labeler wiring
    q("#labelerFiles")?.addEventListener("change", handleLabelerFiles);
    q("#labelerLoadCurrent")?.addEventListener("click", ()=> loadLabelerFromALL());
    q("#labelerAddBlank")?.addEventListener("click", ()=> addLabelRow({id:genId(), name:"", file:"assets/stones/your-file.png", sides:{top:0,right:0,bottom:0,left:0}, rarity:"Common"}));
    q("#labelerExportJS")?.addEventListener("click", exportLabelerJS);

    // Start on menu
    showView("menu");
    setOpponentVisual(null);
    updateSurvivalUI();
  });




  /* --- Views --- */
  function showView(name){
    qa(".view").forEach(v=>v.classList.remove("active"));
    q(`#view-${name}`)?.classList.add("active");
    if(name==="game") return;
    clearTurnBanner();
    if(name==="campaign" || name==="local" || name==="menu" || name==="survival") gameMode = name;
  }

  /* --- Utilities --- */
  const sumSides = (s)=> v(s?.top)+v(s?.right)+v(s?.bottom)+v(s?.left);
  const RARITY_ORDER = ["Common","Uncommon","Rare","Epic","Legendary","Ultra"];
  const rarityRank = (rarity)=>{
    const idx = RARITY_ORDER.indexOf((rarity||"Common").trim());
    return idx<0?0:idx;
  };
  const makeStone = (entry, owner)=>{
    const s=entry.sides||{};
    return { id:entry.id, name:entry.name||entry.id, img:entry.file||"", rarity: entry.rarity||"Common",
             top:v(s.top), right:v(s.right), bottom:v(s.bottom), left:v(s.left), owner };
  };
  const emptyBoard = ()=> Array.from({length:SIZE},()=>Array(SIZE).fill(null));
  const boardFilled = ()=> board?.every(row=>row.every(cell=>cell!==null));
  function setOpponentVisual(info){
    const avatar=q("#opponentAvatar");
    const nameEl=q("#opponentName");
    const avatarSrc = info?.avatar || "assets/avatars/default.png";
    const label = info?.name || "Opponent";
    if(avatar){ avatar.src=avatarSrc; avatar.alt=label; }
    if(nameEl) nameEl.textContent=label;
    clearOpponentBubble();
  }
  function clearOpponentBubble(){
    const bubble=q("#opponentBubble");
    if(bubble){
      bubble.classList.add("hide");
      bubble.textContent="";
    }
    if(opponentLineTimeout){ clearTimeout(opponentLineTimeout); opponentLineTimeout=null; }
  }
  function showOpponentLine(text){
    if(gameMode!=="campaign") return;
    const bubble=q("#opponentBubble");
    if(!bubble) return;
    bubble.textContent=text;
    bubble.classList.remove("hide");
    if(opponentLineTimeout) clearTimeout(opponentLineTimeout);
    opponentLineTimeout=setTimeout(()=>{ bubble.classList.add("hide"); }, 3000);
  }
  function cueOpponentLine(type){
    if(gameMode!=="campaign" || !currentOpponent) return;
    const pool=currentOpponent.lines?.[type];
    if(!pool || !pool.length) return;
    const line=pool[Math.floor(Math.random()*pool.length)];
    showOpponentLine(line);
  }
  function announceTurn(){
    const banner=q("#turnBanner");
    if(!banner || gameMode==="local") return;
    banner.classList.remove("hide");
    banner.classList.remove("show");
    void banner.offsetWidth;
    banner.textContent = current===P1?"Your Move":"Enemy Move";
    banner.classList.add("show");
    clearTimeout(turnBannerTimeout);
    turnBannerTimeout = setTimeout(()=>{
      banner.classList.remove("show");
      banner.classList.add("hide");
    },1400);
  }
  function clearTurnBanner(){
    const banner=q("#turnBanner");
    if(!banner) return;
    banner.classList.add("hide");
    banner.classList.remove("show");
    if(turnBannerTimeout){ clearTimeout(turnBannerTimeout); turnBannerTimeout=null; }
  }
  function loadSurvivalState(){
    try{
      const raw=localStorage.getItem(SURVIVAL_STORE+"_state");
      if(!raw) return {best:0, streak:0};
      return JSON.parse(raw);
    }catch{ return {best:0, streak:0}; }
  }
  function saveSurvivalState(){
    try{ localStorage.setItem(SURVIVAL_STORE+"_state", JSON.stringify(survivalState)); }catch{}
  }
  function loadSurvivalHistory(){
    try{
      const raw=localStorage.getItem(SURVIVAL_STORE+"_history");
      if(!raw) return [];
      return JSON.parse(raw);
    }catch{ return []; }
  }
  function saveSurvivalHistory(){
    try{ localStorage.setItem(SURVIVAL_STORE+"_history", JSON.stringify(survivalHistory.slice(0,12))); }catch{}
  }

  /* --- Campaign map --- */
  function ensureStartingCollection(){
    if(!ALL.length) return;
    if(!progress.collection.length){
      const weak10 = [...ALL].map(e=>({e,tot:sumSides(e.sides)})).sort((a,b)=>a.tot-b.tot).slice(0, Math.min(10,ALL.length)).map(x=>x.e.id);
      progress.collection = weak10;
      progress.loadout = [];
      saveProgress();
    }
    if(progress.loadout.length!==5) openLoadoutPicker(progress.collection,5,"Choose 5 Stones");
  }
  function openCampaign(){ ensureStartingCollection(); buildLevelMap(); showView("campaign"); }
  function buildLevelMap(){
    const host=q("#levelMap"); host.innerHTML="";
    for(let i=1;i<=MAX_LEVELS;i++){
      const node=document.createElement("button"); node.type="button"; node.className="node card";
      if(i>progress.unlocked) node.classList.add("locked");
      if(progress.beaten[i-1]) node.classList.add("done");
      node.innerHTML = `<div class="lvl">Level ${i}</div><div class="badge">${difficultyLabel(i)}</div><div class="stars">${progress.beaten[i-1]?"★":"☆"}</div>`;
      node.onclick = ()=>{ if(i>progress.unlocked) return; preBattleDialog(i); };
      host.appendChild(node);
    }
  }
  function difficultyLabel(i){
    if(i<=3) return "Very Easy";
    if(i<=6) return "Easy";
    if(i<=10) return "Normal";
    if(i<=13) return "Hard";
    return "Boss";
  }

  /* --- Pre-battle dialog --- */
  function preBattleDialog(level){
    const byId=Object.fromEntries(ALL.map(e=>[e.id,e]));
    const loadoutEntries = (progress.loadout||[]).map(id=>byId[id]).filter(Boolean);
    const loadoutHtml = loadoutEntries.length
      ? `<div class="loadout-preview">${loadoutEntries.map(e=>
          `<div class="loadout-mini">
             <div class="mini"><img src="${e.file||""}" alt="${e.name||e.id}"></div>
             <div class="caption">${e.name||e.id}</div>
           </div>`
        ).join("")}</div>`
      : `<div class="loadout-preview empty">No stones selected yet.</div>`;
    const bodyHtml = `
      <div class="modal-section">
        <div class="section-title">Your Loadout</div>
        ${loadoutHtml}
      </div>
    `;
    openModal(`Level ${level}`, bodyHtml,
      "Start Level", ()=>{ currentLevelIndex=level; startLevel(level); },
      "Edit Loadout", ()=> openLoadoutPicker(progress.collection,5,`Edit Loadout for L${level}`));
  }

  /* --- Enemy scaling --- */
  const ENEMY_LEVELS = [
    { maxCap:5,  mix:[5,0,0,0,0,0] },
    { maxCap:6,  mix:[4,1,0,0,0,0] },
    { maxCap:7,  mix:[3,2,0,0,0,0] },
    { maxCap:8,  mix:[2,2,1,0,0,0] },
    { maxCap:9,  mix:[1,2,2,0,0,0] },
    { maxCap:10, mix:[1,1,2,1,0,0] },
    { maxCap:11, mix:[0,1,2,2,0,0] },
    { maxCap:12, mix:[0,1,1,2,1,0] },
    { maxCap:13, mix:[0,0,1,2,2,0] },
    { maxCap:14, mix:[0,0,0,2,2,1] },
    { maxCap:15, mix:[0,0,0,1,2,2] },
    { maxCap:16, mix:[0,0,0,1,1,3] },
    { maxCap:17, mix:[0,0,0,0,2,3] },
    { maxCap:18, mix:[0,0,0,0,1,4] },
    { maxCap:19, mix:[0,0,0,0,0,5] }
  ];
  function enemyProfile(level){
    const idx = Math.max(0, Math.min(ENEMY_LEVELS.length-1, (level|0)-1));
    const base = ENEMY_LEVELS[idx] || ENEMY_LEVELS[ENEMY_LEVELS.length-1];
    const mix = Array.from({length:RARITY_ORDER.length}, (_,i)=> base.mix?.[i] || 0);
    const maxRarityFromMix = mix.reduce((max,val,i)=> val>0? Math.max(max,i):max, 0);
    return {
      maxCap: base.maxCap,
      maxRarity: base.maxRarity ?? maxRarityFromMix,
      mix
    };
  }
  function enemyDiffForLevel(level){
    if(level<=3) return "story-baby";
    if(level<=6) return "easy";
    if(level<=10) return "normal";
    if(level<=13) return "hard";
    return "boss";
  }
  function generateEnemyDeck(level){
    const profile = enemyProfile(level);
    const lvlIndex = Math.max(0,(level|0)-1);
    const hardness = Math.max(0, Math.min(1, lvlIndex / Math.max(1, MAX_LEVELS-1)));
    const allowedRank = profile.maxRarity;
    const pool = ALL.filter(e=>{
      const rank = rarityRank(e.rarity);
      return sumSides(e.sides)<=profile.maxCap && rank<=allowedRank;
    });
    const buckets = Array.from({length:RARITY_ORDER.length}, ()=>[]);
    pool.forEach(entry=>{
      const rank = Math.min(RARITY_ORDER.length-1, Math.max(0, rarityRank(entry.rarity)));
      buckets[rank].push(entry);
    });
    buckets.forEach(bucket=> bucket.sort((a,b)=> sumSides(a.sides)-sumSides(b.sides)));

    const picks=[];
    const desiredMix = profile.mix;
    for(let rank=0; rank<desiredMix.length && picks.length<5; rank++){
      let need = desiredMix[rank]||0;
      while(need>0 && picks.length<5){
        const stone = drawFromRank(rank);
        if(!stone) break;
        picks.push(stone);
        need--;
      }
    }
    let fallbackGuard=0;
    while(picks.length<5 && fallbackGuard<20){
      fallbackGuard++;
      const stone = drawFromRank(profile.maxRarity);
      if(!stone) break;
      picks.push(stone);
    }
    if(picks.length<5){
      const leftovers = [...ALL].sort((a,b)=> sumSides(a.sides)-sumSides(b.sides));
      for(const st of leftovers){
        if(picks.length>=5) break;
        if(!picks.includes(st)) picks.push(st);
      }
    }
    return picks.slice(0,5);

    function drawFromRank(rank){
      const order = buildRankOrder(rank);
      for(const idx of order){
        const bucket = buckets[idx];
        if(bucket && bucket.length){
          const pickIdx = bucketPickIndex(bucket.length, hardness, idx);
          return bucket.splice(pickIdx,1)[0];
        }
      }
      return null;
    }
    function buildRankOrder(rank){
      const order=[];
      const maxIdx=buckets.length-1;
      for(let offset=0; offset<=maxIdx; offset++){
        const left=rank-offset;
        if(left>=0) order.push(left);
        const right=rank+offset;
        if(offset!==0 && right<=maxIdx) order.push(right);
      }
      return order;
    }
    function bucketPickIndex(len, difficulty, rankIdx){
      if(len<=1) return 0;
      const raritySpan = Math.max(1, RARITY_ORDER.length-1);
      const rarityFactor = rankIdx/raritySpan;
      const bias = Math.max(0, Math.min(1, difficulty*0.7 + rarityFactor*0.2 + (Math.random()-0.5)*0.2));
      return Math.min(len-1, Math.max(0, Math.round((len-1)*bias)));
    }
  }

  function bestEnemyReward(){
    if(!lastEnemyDeckEntries.length) return null;
    return [...lastEnemyDeckEntries].sort((a,b)=>{
      const powDiff = sumSides(a.sides) - sumSides(b.sides);
      if(powDiff!==0) return powDiff;
      return rarityRank(a.rarity) - rarityRank(b.rarity);
    }).pop() || null;
  }

  /* --- Start Level / Local --- */
  function startLevel(level){
    hideError();
    currentLevelIndex = level;
    hideResultBanner();
    const byId = Object.fromEntries(ALL.map(e=>[e.id,e]));
    const yours = (progress.loadout||[]).map(id=>byId[id]).filter(Boolean);
    if(yours.length!==5){ openLoadoutPicker(progress.collection,5,"Choose 5 Stones"); return; }
    P1 = { id:"P1", name:"You", deck: yours.map(e=>makeStone(e,"P1")) };
    const enemyEntries = generateEnemyDeck(level);
    lastEnemyDeckEntries = enemyEntries.map(entry=>({ ...entry }));
    P2 = { id:"P2", name:`Enemy L${level}`, deck: enemyEntries.map(e=>makeStone(e,"P2")) };
    currentOpponent = getCharacter(level);
    setOpponentVisual(currentOpponent);
    if(level<=2){ // early nerf
      for(const st of P2.deck){ const S=["top","right","bottom","left"]; const k=S[Math.floor(Math.random()*S.length)]; st[k]=Math.max(0,st[k]-1); }
    }
    board=emptyBoard(); current=P1; selected=null;
    q("#gameTitle").textContent=`Level ${level}`;
    q("#gameSubtitle").textContent=`AI: ${enemyDiffForLevel(level)}`;
    gameMode="campaign";
    showView("game"); updateAll(); announceTurn();
  }
  function startLocal(){
    hideError();
    if(ALL.length<10){ showError("Need at least 10 stones in the manifest for Local 2P."); return; }
    const pool=ALL.slice(0,10);
    P1={id:"P1",name:"Player 1",deck:pool.slice(0,5).map(e=>makeStone(e,"P1"))};
    P2={id:"P2",name:"Player 2",deck:pool.slice(5,10).map(e=>makeStone(e,"P2"))};
    hideResultBanner();
    lastEnemyDeckEntries = [];
    board=emptyBoard(); current=P1; selected=null;
    q("#gameTitle").textContent="Local Versus";
    q("#gameSubtitle").textContent="Pass & Play";
    gameMode="local";
    currentOpponent=null;
    setOpponentVisual({name:"Player 2", avatar:"assets/avatars/default.png"});
    showView("game"); updateAll(); clearTurnBanner();
  }

  /* --- Online Multiplayer --- */
  function openOnlineLobby(){
    hideResultBanner();
    showView("online");
    currentOpponent=null;
    setOpponentVisual(null);
    ensureOnlineSocket();
    const msg = onlineSession.connected ? "Connected. Create or join a room." : "Connecting...";
    const serverText = ONLINE_SERVER_LABEL ? `Server: ${ONLINE_SERVER_LABEL}` : "";
    setOnlineStatus(msg, serverText);
  }
  function setOnlineStatus(message, roomText=""){
    const statusEl=q("#onlineStatus"); if(statusEl) statusEl.textContent=message||"";
    const roomEl=q("#onlineRoomInfo"); if(roomEl) roomEl.textContent=roomText||"";
  }
  function ensureOnlineSocket(){
    if(onlineSession.ws && (onlineSession.ws.readyState===WebSocket.OPEN || onlineSession.ws.readyState===WebSocket.CONNECTING)) return;
    if(!("WebSocket" in window)){
      setOnlineStatus("WebSocket is not supported in this browser.");
      return;
    }
    try{
      const ws=new WebSocket(ONLINE_SERVER_URL);
      onlineSession.ws=ws;
      onlineSession.connected=false;
      const serverText = ONLINE_SERVER_LABEL ? `Server: ${ONLINE_SERVER_LABEL}` : "";
      setOnlineStatus("Connecting to server...", serverText);
      ws.onopen=()=>{
        onlineSession.connected=true;
        setOnlineStatus("Connected. Create or join a room.", serverText);
      };
      ws.onmessage=(ev)=> handleOnlineMessage(ev);
      ws.onerror=()=> setOnlineStatus("Connection error. Retrying...", serverText);
      ws.onclose=()=>{
        onlineSession.ws=null;
        onlineSession.connected=false;
        setOnlineStatus("Disconnected from server.", serverText);
        if(onlineSession.active){
          presentOutcome({title:"Connection Lost",details:"The online match ended because the connection dropped.", primary:{label:"Back to Lobby", action:openOnlineLobby}});
          exitOnlineMatch(false);
        }
      };
    }catch(err){
      const serverText = ONLINE_SERVER_LABEL ? `Server: ${ONLINE_SERVER_LABEL}` : "";
      setOnlineStatus("Unable to connect to server.", serverText);
    }
  }
  function handleOnlineMessage(ev){
    let data;
    try{ data=JSON.parse(ev.data); }catch{ return; }
    switch(data.type){
      case "room_created":
        onlineSession.role="host";
        onlineSession.roomId=data.roomId;
        setOnlineStatus("Room created. Share the code with a friend.", `Room Code: ${data.roomId}`);
        break;
      case "guest_joined":
        setOnlineStatus("Guest joined! Starting match...", `Room Code: ${onlineSession.roomId||""}`);
        break;
      case "room_joined":
        onlineSession.role="guest";
        onlineSession.roomId=data.roomId;
        setOnlineStatus("Joined room. Waiting for host to start...", `Room Code: ${data.roomId}`);
        break;
      case "room_error":
        setOnlineStatus(`Error: ${data.message||"Unknown error"}`);
        break;
      case "start_game":
        beginOnlineMatch(data);
        break;
      case "opponent_move":
        applyRemoteMove(data);
        break;
      case "opponent_left":
        presentOutcome({
          title:"Opponent Left",
          details:"Your opponent left the match.",
          primary:{label:"Back to Lobby", action:openOnlineLobby}
        });
        exitOnlineMatch(false);
        break;
      case "room_message":
        setOnlineStatus(data.message||"", data.detail||"");
        break;
      default:
        break;
    }
  }
  function sendOnline(payload){
    const ws=onlineSession.ws;
    if(!ws || ws.readyState!==WebSocket.OPEN){
      setOnlineStatus("Not connected to the online server.");
      return false;
    }
    try{
      ws.send(JSON.stringify(payload));
      return true;
    }catch{
      setOnlineStatus("Failed to send data to server.");
      return false;
    }
  }
  function createOnlineRoom(){
    ensureOnlineSocket();
    if(!onlineSession.connected){ setOnlineStatus("Still connecting..."); return; }
    const loadout = getOnlineLoadoutEntries();
    if(loadout.length<5){ alert("Need 5 stones selected for online play."); return; }
    onlineSession.pendingLoadout=loadout;
    setOnlineStatus("Creating room...");
    sendOnline({type:"create_room", loadout});
  }
  function joinOnlineRoom(){
    ensureOnlineSocket();
    if(!onlineSession.connected){ setOnlineStatus("Still connecting..."); return; }
    const input=q("#onlineRoomInput");
    const code=input?.value?.trim().toUpperCase();
    if(!code){ setOnlineStatus("Enter a room code to join."); return; }
    const loadout = getOnlineLoadoutEntries();
    if(loadout.length<5){ alert("Need 5 stones selected for online play."); return; }
    onlineSession.pendingLoadout=loadout;
    setOnlineStatus(`Joining room ${code}...`);
    sendOnline({type:"join_room", roomId:code, loadout});
  }
  function getOnlineLoadoutEntries(){
    if(!ALL.length){ showError("Need stones loaded to play online."); return []; }
    ensureStartingCollection();
    let ids=(progress.loadout||[]).slice(0,5);
    if(ids.length<5) ids=progress.collection.slice(0,5);
    if(ids.length<5) ids=ALL.slice(0,5).map(e=>e.id);
    const byId=Object.fromEntries(ALL.map(e=>[e.id,e]));
    return ids.map(id=>byId[id]).filter(Boolean).slice(0,5).map(cleanStonePayload);
  }
  function cleanStonePayload(entry){
    return {
      id: entry.id,
      name: entry.name || entry.id || "",
      file: entry.file || "",
      rarity: entry.rarity || "Common",
      sides: {
        top: v(entry.sides?.top),
        right: v(entry.sides?.right),
        bottom: v(entry.sides?.bottom),
        left: v(entry.sides?.left)
      }
    };
  }
  function beginOnlineMatch(payload){
    const hostDeck = payload.hostLoadout||[];
    const guestDeck = payload.guestLoadout||[];
    const myDeckRaw = onlineSession.role==="host"?hostDeck:guestDeck;
    const oppDeckRaw = onlineSession.role==="host"?guestDeck:hostDeck;
    P1 = { id:"P1", name:"You", deck: myDeckRaw.map(e=>makeStone(e,"P1")) };
    P2 = { id:"P2", name:"Opponent", deck: oppDeckRaw.map(e=>makeStone(e,"P2")) };
    board = emptyBoard(); selected=null; hideResultBanner();
    onlineSession.active=true;
    onlineSession.myTurn = (payload.first===onlineSession.role);
    current = onlineSession.myTurn ? P1 : P2;
    gameMode="online";
    currentOpponent = { name:"Online Rival", avatar:"assets/avatars/default.png", lines:null };
    setOpponentVisual(currentOpponent);
    q("#gameTitle").textContent="Online Match";
    updateOnlineSubtitle();
    showView("game"); updateAll(); announceTurn();
    setOnlineStatus("Match started!", `Room Code: ${onlineSession.roomId||""}`);
  }
  function updateOnlineSubtitle(extraText){
    if(gameMode!=="online") return;
    const base = onlineSession.myTurn ? "Your move" : "Waiting for opponent";
    q("#gameSubtitle").textContent = extraText || base;
  }
  function attemptOnlineMove(x,y){
    if(!onlineSession.active || !onlineSession.myTurn) return;
    if(!selected || board[y][x]) return;
    const stone=selected;
    if(!placeStone(stone,"P1",x,y)) return;
    selected=null;
    onlineSession.myTurn=false;
    updateOnlineSubtitle();
    sendOnline({type:"player_move", roomId:onlineSession.roomId, stoneId:stone.id, x, y});
  }
  function applyRemoteMove(data){
    if(!onlineSession.active) return;
    const { stoneId, x, y } = data;
    if(board[y] && board[y][x]) return;
    const stone = P2?.deck?.find(st=>st.id===stoneId);
    if(!stone) return;
    placeStone(stone,"P2",x,y);
    selected=null;
    onlineSession.myTurn=true;
    updateOnlineSubtitle();
  }
  function exitOnlineMatch(sendLeave, resetBoard=true){
    if(sendLeave && onlineSession.ws && onlineSession.roomId){
      sendOnline({type:"leave_room", roomId:onlineSession.roomId});
    }
    onlineSession.active=false;
    onlineSession.myTurn=false;
    onlineSession.roomId=null;
    onlineSession.role=null;
    selected=null;
    if(resetBoard) board=emptyBoard();
    currentOpponent=null;
    setOpponentVisual(null);
  }

  /* --- Rendering --- */
  function renderDeck(id, deck, opts={}){
    const { selectable=false, hidden=false } = opts;
    const host=q("#"+id); if(!host) return;
    host.innerHTML="";
    deck.forEach(st=>{
      const btn=document.createElement("button"); btn.type="button"; btn.className="stone-btn";
      if(selectable && !hidden && selected===st) btn.classList.add("selected");
      if(hidden) btn.classList.add("hidden-card");
      const mini=document.createElement("div"); mini.className="mini";
      const label=document.createElement("div"); label.style.fontWeight="900";
      if(hidden){
        mini.classList.add("mini-hidden");
        mini.innerHTML="<span>?</span>";
        label.textContent="Enemy Stone";
        btn.disabled=true;
        btn.onclick=null;
      }else{
        const img=document.createElement("img"); img.src=st.img||""; img.alt=st.name;
        mini.appendChild(img);
        label.textContent = st.name + (st.rarity?` • ${st.rarity}`:"");
        btn.onclick=()=>{ if(selectable){ selected=st; updateAll(); } };
      }
      btn.appendChild(mini); btn.appendChild(label);
      host.appendChild(btn);
    });
    if(hidden){
      const note=document.createElement("div"); note.className="deck-note";
      note.textContent = deck.length ? `${deck.length} stone${deck.length===1?"":"s"} remaining` : "No stones remaining";
      host.appendChild(note);
    }
  }
  function renderBoard(){
    const host=q("#board"); host.innerHTML="";
    const now=Date.now();
    for(let y=0;y<SIZE;y++){
      for(let x=0;x<SIZE;x++){
        const cell=document.createElement("div"); cell.className="cell";
        const s=board[y][x];
        if(s){
          const tile=document.createElement("div"); tile.className="stone "+(s.owner==="P1"?"p1":"p2");
          if(s._animatePlace){ tile.classList.add("just-placed"); s._animatePlace=false; }
          if(s._animateFlip){ tile.classList.add("just-flipped"); s._animateFlip=false; }
          const img=document.createElement("img"); img.src=s.img||""; img.alt=s.name;
          tile.appendChild(img); cell.appendChild(tile);
        }else{
          cell.addEventListener("mouseenter", ()=>{
            if(selected){ const g=document.createElement("div"); g.className="tile-ghost"; const gi=document.createElement("img"); gi.src=selected.img||""; g.appendChild(gi); cell.appendChild(g); }
          });
          cell.addEventListener("mouseleave", ()=> cell.querySelector(".tile-ghost")?.remove());
          cell.addEventListener("click", ()=>{
            if(gameMode==="online") attemptOnlineMove(x,y);
            else placeAt(x,y);
          });
        }
        host.appendChild(cell);
      }
    }
  }
  function updateHUD(){
    q("#turn").textContent = `Turn: ${current===P1?"You":"Enemy"}`;
    let p1=0,p2=0; for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++){ const s=board[y][x]; if(!s) continue; s.owner==="P1"?p1++:p2++; }
    q("#score").textContent = `Score — P1: ${p1} | P2: ${p2}`;
  }
  function init3DTilt(){
    const boardEl=q("#board"); if(!boardEl) return;
    qa(".cell",boardEl).forEach(cell=>{
      let tgt;
      cell.addEventListener("mousemove",(e)=>{
        tgt=cell.querySelector(".stone"); if(!tgt) return;
        const r=cell.getBoundingClientRect(), px=(e.clientX-r.left)/r.width, py=(e.clientY-r.top)/r.height;
        const rx=(0.5-py)*10, ry=(px-0.5)*10;
        tgt.style.transform=`rotateX(${rx}deg) rotateY(${ry}deg) translateZ(6px)`;
      });
      cell.addEventListener("mouseleave", ()=>{ tgt=cell.querySelector(".stone"); if(!tgt) return; tgt.style.transform="rotateX(0) rotateY(0) translateZ(0)"; });
    });
  }
  function updateAll(){
    const trayMode = (gameMode==="campaign" || gameMode==="survival");
    const hideEnemy = (gameMode==="campaign" || gameMode==="online" || gameMode==="survival");
    const tray = q("#playerTray");
    const panelYour = q("#panelYour");
    const panelEnemy = q("#panelEnemy");
    const trayDeck = q("#deckTray");
    const enemyDeckEl = q("#deck2");

    if(trayMode){
      if(tray) tray.classList.remove("hide");
      if(panelYour) panelYour.classList.add("hide");
      renderDeck("deckTray", P1.deck, { selectable: current===P1 });
    }else{
      if(tray) tray.classList.add("hide");
      if(panelYour) panelYour.classList.remove("hide");
      renderDeck("deck1", P1.deck, { selectable: current===P1 });
      if(trayDeck) trayDeck.innerHTML="";
    }

    if(hideEnemy){
      if(panelEnemy) panelEnemy.classList.add("hide");
      if(enemyDeckEl) enemyDeckEl.innerHTML="";
    }else{
      if(panelEnemy) panelEnemy.classList.remove("hide");
      renderDeck("deck2", P2.deck, { hidden:false });
    }

    renderBoard();
    updateHUD();
    init3DTilt();
  }

  /* --- Mechanics --- */
  function placeStone(stone, owner, x,y){
    if(!stone || board[y][x]) return false;
    const placed = { ...stone, owner };
    placed._animatePlace = true;
    board[y][x] = placed;

    const deck = owner==="P1"?P1.deck:P2.deck;
    const idx = deck.indexOf(stone); if(idx>-1) deck.splice(idx,1);

    captureAdjacent(x,y);

    current = owner==="P1"?P2:P1;
    announceTurn();
    updateAll();

    if(boardFilled()){
      setTimeout(endRound, 200);
    }
    return true;
  }
  function placeAt(x,y){
    if(!selected || board[y][x]) return;
    const stone=selected;
    const owner=(current===P1?"P1":"P2");
    if(!placeStone(stone,owner,x,y)) return;
    selected=null;

    if((gameMode==="campaign" || gameMode==="survival") && current===P2) setTimeout(aiTurn, 800);
  }
  function captureAdjacent(x,y){
    const me=board[y][x]; if(!me) return;
    const dirs=[{dx:-1,dy:0,my:"left",their:"right"},{dx:1,dy:0,my:"right",their:"left"},{dx:0,dy:-1,my:"top",their:"bottom"},{dx:0,dy:1,my:"bottom",their:"top"}];
    let flippedEnemy=false, flippedYours=false;
    for(const d of dirs){
      const nx=x+d.dx, ny=y+d.dy; if(nx<0||ny<0||nx>=SIZE||ny>=SIZE) continue;
      const n=board[ny][nx]; if(!n || n.owner===me.owner) continue;
      if(v(me[d.my]) > v(n[d.their])){
        const prev=n.owner;
        n.owner = me.owner;
        n._animateFlip = true;
        if(gameMode==="campaign"){
          if(me.owner==="P1" && prev==="P2") flippedEnemy=true;
          else if(me.owner==="P2" && prev==="P1") flippedYours=true;
        }
      }
    }
    if(gameMode==="campaign"){
      if(flippedEnemy) cueOpponentLine("captured");
      if(flippedYours) cueOpponentLine("capture");
    }
  }

  /* --- AI --- */
  function evalMove(st,x,y){
    let flips=0; const dirs=[{dx:-1,dy:0,my:"left",opp:"right"},{dx:1,dy:0,my:"right",opp:"left"},{dx:0,dy:-1,my:"top",opp:"bottom"},{dx:0,dy:1,my:"bottom",opp:"top"}];
    for(const d of dirs){
      const nx=x+d.dx, ny=y+d.dy; if(nx<0||ny<0||nx>=SIZE||ny>=SIZE) continue;
      const n=board[ny][nx]; if(!n || n.owner==="P2") continue;
      if(v(st[d.my]) > v(n[d.opp])) flips++;
    }
    const center=(x===1&&y===1)?0.2:0, corner=((x===0||x===2)&&(y===0||y===2))?0.1:0, conserve=0.02*(16-(st.top+st.right+st.bottom+st.left));
    return flips+center+corner+conserve;
  }
  function aiTurn(){
    if(P2.deck.length===0) return;
    const level = gameMode==="survival" ? Math.min(MAX_LEVELS,(survivalState.streak||0)+1) : currentLevelIndex||1;
    const diff = enemyDiffForLevel(level);
    const moves=[];
    for(const st of P2.deck){ for(let y=0;y<SIZE;y++){ for(let x=0;x<SIZE;x++){ if(board[y][x]) continue; moves.push({st,x,y,score:evalMove(st,x,y)}); }}}
    if(!moves.length) return;
    for(const m of moves) m.score += (Math.random()-0.5) * (diff==="story-baby"?0.5:diff==="easy"?0.3:diff==="normal"?0.2:diff==="hard"?0.12:0.08);
    moves.sort((a,b)=>b.score-a.score);
    const pick = diff==="story-baby" ? Math.min(moves.length-1, Math.floor(Math.random()*Math.max(3,Math.ceil(moves.length*0.6))))
               : diff==="easy" ? Math.min(moves.length-1, Math.floor(Math.random()*3))
               : 0;
    const m=moves[pick];
    placeStone(m.st,"P2",m.x,m.y);
    selected=null;
  }
  function enemyDiffForLevel(level){ if(level<=2) return "story-baby"; if(level<=4) return "easy"; if(level<=7) return "normal"; if(level<=9) return "hard"; return "boss"; }

  /* --- End round --- */
  function endRound(){
    let p1=0,p2=0; for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++){ const s=board[y][x]; if(!s) continue; s.owner==="P1"?p1++:p2++; }
    if(gameMode==="campaign"){
      if(p1>p2){
        cueOpponentLine("lose");
        const reward = bestEnemyReward();
        let rewardHtml = "";
        if(reward){
          if(!progress.collection.includes(reward.id)) progress.collection.push(reward.id);
          rewardHtml = `<br>Reward: <b>${reward.name||reward.id}</b> (${reward.rarity||"Common"}) added to your collection.`;
        }
        progress.beaten[currentLevelIndex-1]=true;
        if(progress.unlocked<MAX_LEVELS && currentLevelIndex===progress.unlocked) progress.unlocked++;
        saveProgress();
        const replayLevel=currentLevelIndex;
        const nextLevel=Math.min(MAX_LEVELS, replayLevel+1);
        const canAdvance = progress.unlocked>replayLevel && replayLevel<MAX_LEVELS;
        const primaryText = canAdvance?"Next Level":"Back to Map";
        const primaryAction = canAdvance? ()=>startLevel(nextLevel): openCampaign;
        const secondaryText = canAdvance?"Back to Map":"Play Again";
        const secondaryAction = canAdvance? openCampaign : ()=>startLevel(replayLevel);
        const tertiaryText = canAdvance?"Play Again":null;
        const tertiaryAction = canAdvance? ()=>startLevel(replayLevel):null;
        presentOutcome({
          title: "Victory!",
          details: `You won Level ${replayLevel}.${rewardHtml}`,
          primary: {
            label: primaryText,
            action: primaryAction
          },
          secondary: {
            label: secondaryText,
            action: secondaryAction
          },
          tertiary: canAdvance ? {
            label: "Replay Level",
            action: () => startLevel(replayLevel)
          } : null
        });
      } else if(p2>p1){
        cueOpponentLine("win");
        presentOutcome({
          title: "Defeat",
          details: "Try a different loadout and challenge the level again.",
          primary: { label:"Retry", action: ()=>startLevel(currentLevelIndex) },
          secondary: { label:"Back to Map", action: openCampaign },
          tertiary: null
        });
      } else {
        presentOutcome({
          title: "Draw",
          details: "No winner this time. Give it another go!",
          primary: { label:"Retry", action: ()=>startLevel(currentLevelIndex) },
          secondary: { label:"Back to Map", action: openCampaign },
          tertiary: null
        });
      }
      lastEnemyDeckEntries = [];
    } else if(gameMode==="online"){
      let title, details;
      if(p1>p2){ title="Victory"; details="You captured more stones than your opponent."; }
      else if(p2>p1){ title="Defeat"; details="Your opponent captured more stones."; }
      else { title="Draw"; details="No winner this time."; }
      presentOutcome({
        title,
        details,
        primary: { label:"Back to Lobby", action: openOnlineLobby },
        secondary: null,
        tertiary: null
      });
      exitOnlineMatch(true,false);
    } else if(gameMode==="survival"){
      if(p1>p2){
        survivalState.streak = (survivalState.streak||0)+1;
        if((survivalState.best||0)<survivalState.streak) survivalState.best=survivalState.streak;
        saveSurvivalState();
        updateSurvivalUI();
        presentOutcome({
          title:"Wave Cleared",
          details:`Current streak: ${survivalState.streak}`,
          primary:{ label:"Next Wave", action:startSurvivalWave },
          secondary:{ label:"Exit Survival", action:()=>{ finishSurvivalRun({record:false}); openSurvivalView(); } },
          tertiary:null
        });
      } else {
        const final=finishSurvivalRun({record:true});
        presentOutcome({
          title:p2>p1?"Defeat":"Draw",
          details:`Final streak: ${final}`,
          primary:{ label:"Try Again", action:startSurvivalRun },
          secondary:{ label:"Back to Survival", action:openSurvivalView },
          tertiary:null
        });
      }
    } else {
      const title = p1>p2 ? "Player 1 Wins" : p2>p1 ? "Player 2 Wins" : "Draw";
      const primaryLabel = p1===p2 ? "Rematch" : "Play Again";
      presentOutcome({
        title,
        details: "Good game!",
        primary: { label: primaryLabel, action: startLocal },
        secondary: { label: "Main Menu", action: ()=>showView("menu") },
        tertiary: null
      });
    }
  }

  /* --- Modal --- */
  function openModal(title, html, primaryText="OK", primaryAction=null, secondaryText="Close", secondaryAction=null, tertiaryText=null, tertiaryAction=null){
    q("#modalTitle").textContent=title||"Message";
    q("#modalBody").innerHTML=html||"";
    const p=q("#modalPrimary"), s=q("#modalSecondary"), t=q("#modalTertiary");
    p.textContent=primaryText; s.textContent=secondaryText;
    p.onclick=()=>{ closeModal(); if(primaryAction) primaryAction(); };
    s.onclick=()=>{ closeModal(); if(secondaryAction) secondaryAction(); };
    if(t){
      t.hidden = !tertiaryText;
      if(tertiaryText){
        t.textContent=tertiaryText;
        t.onclick=()=>{ closeModal(); if(tertiaryAction) tertiaryAction(); };
      }else{
        t.onclick=null;
      }
    }
    q("#modal").classList.remove("hide");
  }
  const closeModal=()=> q("#modal")?.classList.add("hide");

  function hideResultBanner(){
    const host=q("#resultBanner");
    if(!host) return;
    host.classList.add("hide");
    ["#resultPrimary","#resultSecondary","#resultTertiary"].forEach(id=>{
      const btn=q(id);
      if(btn){
        btn.classList.add("hide");
        btn.onclick=null;
      }
    });
  }
  function showResultBanner({title,details,primary,secondary,tertiary}){
    const host=q("#resultBanner");
    if(!host) return;
    host.classList.remove("hide");
    const titleEl=q("#resultTitle"), detailEl=q("#resultDetails");
    if(titleEl) titleEl.textContent=title||"Result";
    if(detailEl) detailEl.innerHTML=details||"";
    configureResultButton("#resultPrimary", primary);
    configureResultButton("#resultSecondary", secondary);
    configureResultButton("#resultTertiary", tertiary);
  }
  function configureResultButton(id, cfg){
    const btn=q(id);
    if(!btn) return;
    if(!cfg){
      btn.classList.add("hide");
      btn.onclick=null;
      return;
    }
    btn.classList.remove("hide");
    btn.textContent=cfg.label||"OK";
    btn.onclick=()=>{ hideResultBanner(); cfg.action && cfg.action(); };
  }
  function presentOutcome(config){
    showResultBanner(config);
    openModal(
      config.title || "Result",
      config.details || "",
      config.primary?.label || "OK",
      config.primary?.action || null,
      config.secondary?.label || "Close",
      config.secondary?.action || null,
      config.tertiary?.label || null,
      config.tertiary?.action || null
    );
  }

  /* --- Loadout Picker --- */
  function openLoadoutPicker(sourceIds,maxPick,titleText){
    if(!ALL.length){ showError("No stones loaded. Use Labeler or include assets/stones.manifest.js."); return; }
    const byId=Object.fromEntries(ALL.map(e=>[e.id,e]));
    const grid=q("#loadoutGrid"), modal=q("#loadoutModal"), countLabel=q("#loadoutCount");
    q("#loadoutTitle").textContent=titleText||"Choose 5 Stones";
    grid.innerHTML="";
    const picks=new Set((progress.loadout||[]).filter(id=>sourceIds.includes(id)).slice(0,maxPick));
    const updateCount=()=>{ if(countLabel) countLabel.textContent=`Selected ${picks.size}/${maxPick}`; };
    updateCount();
    sourceIds.forEach(id=>{
      const e=byId[id]; if(!e) return;
      const card=document.createElement("button"); card.type="button"; card.className="load-card"+(picks.has(id)?" selected":"");
      const mini=document.createElement("div"); mini.className="mini";
      const img=document.createElement("img"); img.src=e.file||""; img.alt=e.name||e.id; mini.appendChild(img);
      const title=document.createElement("div"); title.className="load-title"; title.textContent=e.name||e.id;
      const meta=document.createElement("div"); meta.className="load-meta"; meta.textContent=`Power ${sumSides(e.sides)} | ${e.rarity||"Common"}`;
      const togglePick=()=>{
        if(picks.has(id)){ picks.delete(id); }
        else {
          if(picks.size>=maxPick) return;
          picks.add(id);
        }
        card.classList.toggle("selected", picks.has(id));
        updateCount();
      };
      card.addEventListener("click", togglePick);
      card.appendChild(mini); card.appendChild(title); card.appendChild(meta);
      grid.appendChild(card);
    });
    q("#loadoutSave").onclick=()=>{ if(picks.size!==maxPick){ alert(`Pick exactly ${maxPick}.`); return; } progress.loadout=[...picks]; saveProgress(); modal.classList.add("hide"); };
    q("#loadoutCancel").onclick=()=> modal.classList.add("hide");
    modal.onclick=(e)=>{ if(e.target===modal) modal.classList.add("hide"); };
    modal.classList.remove("hide");
  }

  /* ========= LABELER ========= */
  // State for labeler
  let LABEL_ROWS = []; // {id,name,file,sides:{t,r,b,l}, rarity}

  function requestLabelerAccess(){
    if(labelerUnlocked){ openLabeler(); return; }
    const attempt = prompt("Enter the password to access the Labeler:");
    if(attempt==null) return;
    if(attempt.trim()===LABELER_PASSWORD){
      labelerUnlocked=true;
      openLabeler();
    } else {
      alert("Incorrect password.");
    }
  }

  function openLabeler(){
    showView("labeler");
    // If we haven't loaded anything into labeler yet, load current ALL
    if(!LABEL_ROWS.length && ALL.length) loadLabelerFromALL();
    renderLabeler();
  }

  function genId(){ return "stone_"+Math.random().toString(36).slice(2,8); }

  function loadLabelerFromALL(){
    LABEL_ROWS = (ALL||[]).map(e=>({
      id: e.id || genId(),
      name: e.name || e.id || "",
      file: e.file || "",
      sides: {
        top: v(e.sides?.top), right: v(e.sides?.right),
        bottom: v(e.sides?.bottom), left: v(e.sides?.left)
      },
      rarity: e.rarity || "Common"
    }));
    renderLabeler();
  }

  function handleLabelerFiles(ev){
    const files = Array.from(ev.target.files||[]);
    // We can't save files to disk here; assume you'll copy them to assets/stones/ with the same filenames.
    // We'll prefill the "file" path to assets/stones/<filename>
    const rows = files.map(f=>({
      id: genId(),
      name: f.name.replace(/\.[^.]+$/,""),
      file: "assets/stones/"+f.name,
      sides: { top:0,right:0,bottom:0,left:0 },
      rarity: "Common",
      _previewURL: URL.createObjectURL(f)
    }));
    LABEL_ROWS.push(...rows);
    renderLabeler();
  }

  function addLabelRow(row){ LABEL_ROWS.push(row); renderLabeler(); }

  function renderLabeler(){
    const host=q("#labelerGrid"); host.innerHTML="";
    LABEL_ROWS.forEach((r,idx)=>{
      const row=document.createElement("div"); row.className="label-row";
      const thumb=document.createElement("div"); thumb.className="label-thumb";
      const img=document.createElement("img"); img.src=r._previewURL || r.file || ""; img.alt=r.name||r.id;
      thumb.appendChild(img);

      const fields=document.createElement("div"); fields.className="label-fields";
      fields.innerHTML = `
        <input class="input full" data-f="name" placeholder="Name" value="${r.name||""}">
        <input class="path full"  data-f="file" placeholder="assets/stones/your-file.png" value="${r.file||""}">
        <div class="small"><span>Top</span><input class="input" data-f="top" type="number" min="0" max="4" value="${r.sides.top}"></div>
        <div class="small"><span>Right</span><input class="input" data-f="right" type="number" min="0" max="4" value="${r.sides.right}"></div>
        <div class="small"><span>Bottom</span><input class="input" data-f="bottom" type="number" min="0" max="4" value="${r.sides.bottom}"></div>
        <div class="small"><span>Left</span><input class="input" data-f="left" type="number" min="0" max="4" value="${r.sides.left}"></div>
        <div class="small full">
          <span>Rarity</span>
          <select class="input" data-f="rarity">
            ${["Common","Uncommon","Rare","Epic","Legendary","Ultra"].map(opt=>`<option ${opt===r.rarity?"selected":""}>${opt}</option>`).join("")}
          </select>
        </div>
        <div class="small full">
          <button class="big ghost" data-act="dup">Duplicate</button>
          <button class="big" data-act="del">Delete</button>
        </div>
      `;
      // Bind changes
      fields.querySelectorAll("[data-f]").forEach(input=>{
        input.oninput = ()=>{
          const f=input.getAttribute("data-f");
          if(f==="name") r.name=input.value;
          else if(f==="file"){ r.file=input.value; img.src=r._previewURL || r.file || ""; }
          else if(f==="rarity"){ r.rarity=input.value; }
          else { r.sides[f]=Math.max(0, Math.min(4, Number(input.value||0))); }
        };
      });
      fields.querySelector('[data-act="dup"]').onclick=()=>{ LABEL_ROWS.splice(idx+1,0,JSON.parse(JSON.stringify(r))); renderLabeler(); };
      fields.querySelector('[data-act="del"]').onclick=()=>{ LABEL_ROWS.splice(idx,1); renderLabeler(); };

      row.appendChild(thumb); row.appendChild(fields); host.appendChild(row);
    });
  }

  function exportLabelerJS(){
    if(!LABEL_ROWS.length){ alert("Nothing to export. Add rows or load current manifest."); return; }
    // Normalize and produce JS that sets window.ALL_STONES
    const data = LABEL_ROWS.map(r=>({
      id: r.id || genId(),
      name: r.name || r.id || "",
      file: r.file || "",
      rarity: r.rarity || "Common",
      sides: { top:v(r.sides.top), right:v(r.sides.right), bottom:v(r.sides.bottom), left:v(r.sides.left) }
    }));
    const js = "window.ALL_STONES = " + JSON.stringify(data, null, 2) + ";";
    const blob = new Blob([js], {type:"application/javascript"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href=url; a.download="stones.manifest.js";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    alert("Exported! Replace your /assets/stones.manifest.js with the downloaded file.");
  }

  /* --- Character Customizer --- */
  function ensureCharacterLines(char){
    if(!char.lines) char.lines={};
    for(const key of ["capture","captured","win","lose"]){
      if(!Array.isArray(char.lines[key])) char.lines[key]=[];
    }
    return char.lines;
  }
  function openCharacterEditor(){
    showView("characters");
    renderCharacterEditor();
  }
  function renderCharacterEditor(){
    const host=q("#characterGrid");
    if(!host) return;
    host.innerHTML="";
    campaignCharacters.forEach((char,idx)=>{
      ensureCharacterLines(char);
      const card=document.createElement("div");
      card.className="character-card";

      const title=document.createElement("h3");
      title.textContent=`Level ${idx+1}`;
      card.appendChild(title);

      const preview=document.createElement("img");
      preview.className="preview";
      preview.src=char.avatar||"assets/avatars/default.png";
      preview.alt=char.name||`Opponent ${idx+1}`;
      card.appendChild(preview);

      const nameInput=document.createElement("input");
      nameInput.className="input";
      nameInput.placeholder="Name";
      nameInput.value=char.name||"";
      nameInput.oninput=()=>{
        char.name=nameInput.value||`Opponent ${idx+1}`;
        saveCharacters();
        if(gameMode==="campaign" && currentOpponent && currentLevelIndex===idx+1){
          currentOpponent=char;
          setOpponentVisual(currentOpponent);
        }
      };
      card.appendChild(nameInput);

      const avatarInput=document.createElement("input");
      avatarInput.className="input";
      avatarInput.placeholder="assets/avatars/character.png";
      avatarInput.value=char.avatar||"";
      avatarInput.oninput=()=>{
        char.avatar=avatarInput.value;
        preview.src=char.avatar||"assets/avatars/default.png";
        saveCharacters();
        if(gameMode==="campaign" && currentOpponent && currentLevelIndex===idx+1){
          currentOpponent=char;
          setOpponentVisual(currentOpponent);
        }
      };
      card.appendChild(avatarInput);

      card.appendChild(makeDialogueRow("When they capture you", char.lines.capture, val=>{
        char.lines.capture = val;
        saveCharacters();
      }));
      card.appendChild(makeDialogueRow("When you capture them", char.lines.captured, val=>{
        char.lines.captured = val;
        saveCharacters();
      }));
      card.appendChild(makeDialogueRow("When they win", char.lines.win, val=>{
        char.lines.win = val;
        saveCharacters();
      }));
      card.appendChild(makeDialogueRow("When they lose", char.lines.lose, val=>{
        char.lines.lose = val;
        saveCharacters();
      }));

      host.appendChild(card);
    });
  }
  function makeDialogueRow(labelText, values, onChange){
    const wrapper=document.createElement("div");
    wrapper.className="dialogue-row";
    const label=document.createElement("label");
    label.textContent=labelText;
    const textarea=document.createElement("textarea");
    textarea.value=(values||[]).join("\n");
    textarea.oninput=()=>{
      onChange(normalizeLines(textarea.value));
    };
    wrapper.appendChild(label);
    wrapper.appendChild(textarea);
    return wrapper;
  }
  function requestCharacterAccess(){
    if(labelerUnlocked){ openCharacterEditor(); return; }
    const attempt = prompt("Enter the password to access the Opponent Customizer:");
    if(attempt==null) return;
    if(attempt.trim()===LABELER_PASSWORD){
      labelerUnlocked=true;
      openCharacterEditor();
    } else {
      alert("Incorrect password.");
    }
  }

  /* --- Survival Mode --- */
  function openSurvivalView(){
    showView("survival");
    setOpponentVisual(null);
    updateSurvivalUI();
  }
  function updateSurvivalUI(){
    const streakEl=q("#survivalStreak");
    const bestEl=q("#survivalBest");
    if(streakEl) streakEl.textContent = survivalState.streak||0;
    if(bestEl) bestEl.textContent = survivalState.best||0;
    renderSurvivalHistory();
  }
  function renderSurvivalHistory(){
    const host=q("#survivalHistory");
    if(!host) return;
    if(!survivalHistory.length){
      host.innerHTML = `<div class="fine">No runs logged yet.</div>`;
      return;
    }
    host.innerHTML = survivalHistory.slice(0,12).map(run=>{
      const date=new Date(run.date||Date.now());
      const stamp = date.toLocaleDateString()+ " " + date.toLocaleTimeString();
      return `<div class="history-row">Streak <b>${run.streak}</b> &mdash; ${stamp}</div>`;
    }).join("");
  }
  function resetSurvivalProgress(){
    if(!confirm("Reset survival streaks and history?")) return;
    survivalState={best:0, streak:0};
    saveSurvivalState();
    survivalHistory=[];
    saveSurvivalHistory();
    updateSurvivalUI();
    survivalDeckEntries=[];
  }
  function openSurvivalDraft(){
    if(!ALL.length){ showError("Need stones loaded to play survival."); return; }
    if(ALL.length<SURVIVAL_PICK_COUNT){ showError(`Need at least ${SURVIVAL_PICK_COUNT} stones for survival.`); return; }
    survivalDeckEntries=[];
    survivalDraftPool = generateSurvivalDraftPool();
    renderSurvivalDraft();
    q("#survivalDraftModal")?.classList.remove("hide");
  }
  function closeSurvivalDraft(){
    q("#survivalDraftModal")?.classList.add("hide");
  }
  function generateSurvivalDraftPool(){
    const scored = ALL.map(e=>{
      const rank = rarityRank(e.rarity);
      const power = sumSides(e.sides);
      const weight = (rank+1)*0.6 + power*0.05 + Math.random();
      return { entry:e, score:weight };
    });
    scored.sort((a,b)=>b.score-a.score);
    return scored.slice(0, Math.min(12, scored.length)).map(x=>x.entry);
  }
  function renderSurvivalDraft(){
    const grid=q("#survivalDraftGrid");
    const info=q("#survivalDraftInfo");
    if(!grid) return;
    grid.innerHTML="";
    const selectedIds=new Set(survivalDeckEntries.map(e=>e.id));
    survivalDraftPool.forEach(entry=>{
      const card=document.createElement("button");
      card.type="button";
      card.className="load-card survival-draft-card"+(selectedIds.has(entry.id)?" selected":"");
      card.onclick=()=>{
        if(selectedIds.has(entry.id)){
          survivalDeckEntries = survivalDeckEntries.filter(e=>e.id!==entry.id);
        }else{
          if(survivalDeckEntries.length>=SURVIVAL_PICK_COUNT) return;
          survivalDeckEntries = [...survivalDeckEntries, entry];
        }
        renderSurvivalDraft();
      };
      card.innerHTML = `
        <div class="mini"><img src="${entry.file||""}" alt="${entry.name||entry.id}"></div>
        <div class="load-title">${entry.name||entry.id}</div>
        <div class="rarity">Rarity: ${entry.rarity||"Common"}</div>
        <div class="power">Power ${sumSides(entry.sides||{})}</div>
      `;
      grid.appendChild(card);
    });
    if(info) info.textContent = `Select ${SURVIVAL_PICK_COUNT} stones (${survivalDeckEntries.length}/${SURVIVAL_PICK_COUNT})`;
  }
  function finalizeSurvivalDraft(){
    if(survivalDeckEntries.length!==SURVIVAL_PICK_COUNT){
      alert(`Pick ${SURVIVAL_PICK_COUNT} stones to begin.`);
      return;
    }
    closeSurvivalDraft();
    survivalRunActive = true;
    startSurvivalWave();
  }
  function startSurvivalRun(){
    if(!ALL.length){ showError("Need stones loaded to play survival."); return; }
    survivalState.streak = 0;
    saveSurvivalState();
    updateSurvivalUI();
    survivalRunActive = false;
    openSurvivalDraft();
  }
  function startSurvivalWave(){
    if(!survivalRunActive) survivalRunActive=true;
    hideError();
    hideResultBanner();
    if(survivalDeckEntries.length!==SURVIVAL_PICK_COUNT){
      openSurvivalDraft();
      return;
    }
    P1 = { id:"P1", name:"You", deck: survivalDeckEntries.map(e=>makeStone(e,"P1")) };
    const wave = (survivalState.streak||0)+1;
    const level = Math.min(MAX_LEVELS, wave);
    const enemyEntries = generateEnemyDeck(level);
    P2 = { id:"P2", name:`Wave ${wave}`, deck: enemyEntries.map(e=>makeStone(e,"P2")) };
    hideResultBanner();
    board=emptyBoard(); current=P1; selected=null;
    currentOpponent = null;
    setOpponentVisual(null);
    q("#gameTitle").textContent=`Survival Wave ${wave}`;
    q("#gameSubtitle").textContent=`Streak: ${survivalState.streak}`;
    gameMode="survival";
    showView("game"); updateAll(); announceTurn();
  }
  function finishSurvivalRun({record=true}={}){
    const finalStreak = survivalState.streak||0;
    if(record && finalStreak>0){
      survivalHistory.unshift({streak:finalStreak, date:Date.now()});
      saveSurvivalHistory();
    }
    survivalState.streak=0;
    saveSurvivalState();
    survivalRunActive=false;
    updateSurvivalUI();
    currentOpponent=null;
    setOpponentVisual(null);
    survivalDeckEntries=[];
    clearTurnBanner();
    return finalStreak;
  }
  let survivalRunActive=false;

})();
