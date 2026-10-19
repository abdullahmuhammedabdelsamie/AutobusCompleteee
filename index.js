import WORDS from './words.js';

const CATS = ['boy', 'girl', 'thing', 'animal', 'plant', 'country'];
const LETTERS = 'أبتجحخدرزسشصطعغفقكلمنهوي'.split('');
const UNIQUE_POINTS = 10, DUP_POINTS = 5, MAX_PLAYERS = 12, VOTE_MS = 30000;
const isNameCat = c => c === 'boy' || c === 'girl';
function normText(s) {
  return String(s || '').trim().replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/\s+/g, ' ');
}
function keyOf(raw) { const s = normText(raw).replace(/ /g, ''); return (s.startsWith('ال') && s.length > 3) ? s.slice(2) : s; }
const DICT = {};
Object.keys(WORDS).forEach(c => { DICT[c] = new Set(WORDS[c].split(/\s+/).filter(Boolean).map(w => keyOf(w.replace(/_/g, ' ')))); });
function classify(cat, raw, L) {
  raw = String(raw || '').trim().slice(0, 30); const key = keyOf(raw);
  if (!key) return { raw, key, st: 'empty', note: '' };
  if (!key.startsWith(L)) return { raw, key, st: 'bad', note: 'لا تبدأ بالحرف المطلوب' };
  if (key.length < 2 || /^(.)\1*$/.test(key) || /[0-9A-Za-z]/.test(key)) return { raw, key, st: 'bad', note: 'كلمة غير مفهومة' };
  if (DICT[cat].has(key)) return { raw, key, st: 'known', note: '' };
  const elsewhere = Object.keys(DICT).filter(c => c !== cat && DICT[c].has(key));
  const sameKind = isNameCat(cat) ? elsewhere.filter(isNameCat) : elsewhere.filter(c => !isNameCat(c));
  if (sameKind.length) return { raw, key, st: 'bad', note: 'ليست من نوع هذه الخانة' };
  return { raw, key, st: 'unknown', note: '' };
}
function pub(room) {
  return { code: room.code, phase: room.phase, round: room.round, totalRounds: room.totalRounds,
    duration: room.duration, letter: room.letter, results: room.results,
    vote: room.phase === 'voting' && room.vote ? { items: room.vote.items.map(i => ({ id: i.id, cat: i.cat, word: i.word, authors: i.authors })), ms: Math.max(0, room.vote.end - Date.now()) } : null,
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, eliminated: p.eliminated, left: p.left, host: p.host })) };
}
function active(room) { return room.players.filter(p => !p.eliminated && !p.left); }
function voters(room) { return active(room).filter(p => room.vote.items.some(it => !it.authors.includes(p.id))); }

export class GameRoom {
  constructor(state, env) { this.state = state; this.env = env; this.rooms = {}; this.players = {}; this.clients = new Map(); this.disconnected = {}; this.loaded = false; this.loadPromise = null; }
  async load() {
    if (this.loaded) return;
    if (!this.loadPromise) this.loadPromise = (async () => {
      const saved = await this.state.storage.get('game-state');
      if (saved) { this.rooms = saved.rooms || {}; this.players = saved.players || {}; this.disconnected = saved.disconnected || {}; }
      this.loaded = true;
    })();
    await this.loadPromise;
  }
  async save() { await this.state.storage.put('game-state', { rooms: this.rooms, players: this.players, disconnected: this.disconnected }); await this.scheduleAlarm(); }
  async scheduleAlarm() {
    const times = Object.values(this.rooms).map(r => r.deadline).concat(Object.values(this.disconnected)).filter(n => Number.isFinite(n) && n > 0);
    if (times.length) await this.state.storage.setAlarm(Math.min(...times));
    else { try { await this.state.storage.deleteAlarm(); } catch (_) {} }
  }
  send(pid, data) { const c = this.clients.get(pid); if (c) { try { c.enqueue(`data: ${JSON.stringify(data)}\n\n`); } catch (_) { this.clients.delete(pid); } } }
  broadcast(room) { const m = pub(room); room.players.forEach(p => { if (!p.left) this.send(p.id, m); }); }
  genCode() { const ch = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s; do { s = ''; for (let i=0;i<5;i++) s += ch[Math.floor(Math.random()*ch.length)]; } while (this.rooms[s]); return s; }
  addPlayer(room, name, host) {
    name = String(name || '').trim().slice(0,16) || 'لاعب'; const base = name; let n=2;
    while (room.players.some(p => p.name === name && !p.left)) name = base + ' ' + (n++);
    const pid = crypto.randomUUID().replace(/-/g, '').slice(0,16);
    room.players.push({ id:pid, name, score:0, eliminated:false, left:false, host });
    this.players[pid] = { pid, code:room.code }; return pid;
  }
  startRound(room) {
    room.round++;
    let pool = LETTERS.filter(l => !room.used.includes(l));
    if (!pool.length) { room.used=[]; pool=LETTERS.slice(); }
    room.letter = pool[Math.floor(Math.random()*pool.length)]; room.used.push(room.letter);
    room.results=null; room.answers={}; room.phase='playing'; room.vote=null;
    room.deadline = Date.now() + room.duration*1000 + 800; this.broadcast(room);
  }
  startCollect(room) {
    if (room.phase !== 'playing') return;
    room.phase='collecting'; room.answers = room.answers || {}; room.deadline = Date.now()+3500; this.broadcast(room); this.checkCollected(room);
  }
  checkCollected(room) { if (room.phase === 'collecting' && active(room).every(p => room.answers[p.id])) this.finishRound(room); }
  finishRound(room) {
    if (room.phase !== 'collecting') return;
    const L=normText(room.letter), itemMap={}; room.cls={};
    room.players.forEach(p => {
      if (p.left || p.eliminated) return;
      room.cls[p.id]={}; CATS.forEach(c => {
        const r=classify(c, (room.answers[p.id]||{})[c], L); room.cls[p.id][c]=r;
        if (r.st==='unknown') { const k=c+'|'+r.key; if (!itemMap[k]) itemMap[k]={cat:c,key:r.key,word:r.raw,authors:[]}; itemMap[k].authors.push(p.id); }
      });
    });
    const items=Object.values(itemMap).map((it,i)=>Object.assign(it,{id:i}));
    if (!items.length) { this.finalizeRound(room,{}); return; }
    room.vote={items,votes:{},end:Date.now()+VOTE_MS}; room.phase='voting'; room.deadline=room.vote.end; this.broadcast(room); this.checkVoted(room);
  }
  checkVoted(room) { if (room.phase==='voting' && room.vote && voters(room).every(p=>room.vote.votes[p.id])) this.endVoting(room); }
  endVoting(room) {
    if (room.phase!=='voting'||!room.vote) return;
    const verdict={}; room.vote.items.forEach(it=>{
      let yes=0,no=0; active(room).forEach(p=>{ if (it.authors.includes(p.id)) return; const v=room.vote.votes[p.id]; if(!v)return; if(v[it.id]===false)no++;else yes++; });
      verdict[it.cat+'|'+it.key]=(yes>=no)?'yes':'no';
    }); this.finalizeRound(room,verdict);
  }
  finalizeRound(room, verdict) {
    const counts={}; CATS.forEach(c=>counts[c]={}); const fin={};
    Object.keys(room.cls||{}).forEach(pid=>{
      const pl=room.players.find(x=>x.id===pid); if(!pl||pl.left)return; fin[pid]={};
      CATS.forEach(c=>{ const r=room.cls[pid][c]; let valid=false,note=r.note;
        if(r.st==='known')valid=true; else if(r.st==='unknown'){const v=verdict[c+'|'+r.key];if(v==='no')note='رفضها اللاعبون';else{valid=true;note=v==='yes'?'قبلها اللاعبون':'';}}
        fin[pid][c]={raw:r.raw,key:r.key,st:r.st,valid,note}; if(valid)counts[c][r.key]=(counts[c][r.key]||0)+1;
      });
    });
    const rows=[]; room.players.forEach(p=>{if(p.left)return;const cells={};let total=0;
      CATS.forEach(c=>{if(p.eliminated||!fin[p.id]){cells[c]={a:'',pts:0,s:'x',n:''};return;}const f=fin[p.id][c];let pts=0,s;
        if(f.valid){if(counts[c][f.key]>1){pts=DUP_POINTS;s='dup';}else{pts=UNIQUE_POINTS;s='ok';}}else s=f.st==='empty'?'empty':'bad';
        cells[c]={a:f.raw,pts,s,n:f.note};total+=pts;}); p.score+=total; rows.push({id:p.id,name:p.name,cells,total,eliminated:p.eliminated});
    });
    room.results={letter:room.letter,rows}; room.vote=null; room.phase='results'; room.deadline=0; this.broadcast(room);
  }
  leave(pid) {
    const pl=this.players[pid]; if(!pl)return; delete this.players[pid]; this.clients.delete(pid); delete this.disconnected[pid];
    const room=this.rooms[pl.code]; if(!room)return; const p=room.players.find(x=>x.id===pid); if(!p)return;
    if(room.phase==='lobby')room.players=room.players.filter(x=>x.id!==pid);else p.left=true;
    if(p.host){p.host=false;const nh=room.players.find(x=>!x.left);if(nh)nh.host=true;}
    if(!room.players.some(x=>!x.left)){delete this.rooms[room.code];return;}
    this.broadcast(room); if(room.phase==='playing'&&!active(room).length)this.startCollect(room); else {this.checkCollected(room);this.checkVoted(room);}
  }
  handleAct(body) {
    const pl=this.players[body.pid]; if(!pl)return {error:'الجلسة منتهية'}; const room=this.rooms[pl.code]; if(!room)return {error:'الغرفة غير موجودة'};
    const p=room.players.find(x=>x.id===body.pid); if(!p)return {error:'لاعب غير معروف'};
    switch(body.type){
      case 'start': if(p.host&&room.phase==='lobby'){room.totalRounds=Math.min(20,Math.max(1,parseInt(body.rounds,10)||5));room.duration=Math.min(300,Math.max(20,parseInt(body.duration,10)||90));this.startRound(room);}break;
      case 'done': if(room.phase==='playing'&&!p.eliminated)this.startCollect(room);break;
      case 'answers': if(room.phase==='collecting'&&!p.eliminated){const a={};CATS.forEach(c=>a[c]=String((body.a||{})[c]||'').slice(0,40));room.answers[p.id]=a;this.checkCollected(room);}break;
      case 'vote': if(room.phase==='voting'&&room.vote&&!p.eliminated){const v={};room.vote.items.forEach(it=>{if(!it.authors.includes(p.id))v[it.id]=!(body.v&&body.v[it.id]===false);});room.vote.votes[p.id]=v;this.checkVoted(room);}break;
      case 'cheat': if(room.phase==='playing'&&!p.eliminated){p.eliminated=true;this.broadcast(room);if(!active(room).length)this.startCollect(room);}break;
      case 'next': if(p.host&&room.phase==='results'){if(room.round>=room.totalRounds){room.phase='final';room.deadline=0;this.broadcast(room);}else this.startRound(room);}break;
      case 'again': if(p.host&&room.phase==='final'){room.round=0;room.used=[];room.results=null;room.letter='';room.players.forEach(x=>{x.score=0;x.eliminated=false;});room.phase='lobby';room.deadline=0;this.broadcast(room);}break;
      case 'leave': this.leave(body.pid);break;
    }
    return {ok:true};
  }
  async alarm() {
    await this.load(); const now=Date.now();
    for (const [pid, at] of Object.entries(this.disconnected)) { if (at <= now && !this.clients.has(pid)) { delete this.disconnected[pid]; this.leave(pid); } }
    for(const room of Object.values(this.rooms)){
      if(!room.deadline||room.deadline>now)continue;
      if(room.phase==='playing')this.startCollect(room);
      else if(room.phase==='collecting')this.finishRound(room);
      else if(room.phase==='voting')this.endVoting(room);
    }
    await this.save();
  }
  async fetch(request) {
    await this.load(); const url=new URL(request.url); const path=url.pathname;
    if(request.method==='GET'&&path==='/api/events'){
      const pid=url.searchParams.get('pid'), pl=this.players[pid]; if(!pl||!this.rooms[pl.code])return new Response('',{status:404});
      const room=this.rooms[pl.code]; let controllerRef; delete this.disconnected[pid];
      const stream=new ReadableStream({start:controller=>{controllerRef=controller;this.clients.set(pid,controller);controller.enqueue(new TextEncoder().encode('retry: 2000\n\n'));controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(pub(room))}\n\n`));},cancel:()=>{if(this.clients.get(pid)===controllerRef){this.clients.delete(pid);this.disconnected[pid]=Date.now()+8000; this.save().catch(()=>{});}}});
      return new Response(stream,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'}});
    }
    if(request.method==='POST'&&path.startsWith('/api/')){
      let body;try{body=await request.json();}catch(_){return Response.json({error:'طلب غير صالح'},{status:400});}
      let result;
      if(path==='/api/create'){
        const code=this.genCode(), room={code,phase:'lobby',round:0,totalRounds:5,duration:90,letter:'',results:null,used:[],players:[],answers:{},cls:null,vote:null,deadline:0};
        this.rooms[code]=room; const pid=this.addPlayer(room,body.name,true); result={pid,code,addrs:[]}; this.broadcast(room);
      } else if(path==='/api/join'){
        const code=String(body.code||'').trim().toUpperCase(), room=this.rooms[code];
        if(!room)result={error:'لا توجد غرفة بهذا الكود.'};
        else if(room.phase!=='lobby')result={error:'اللعبة بدأت بالفعل، انتظر الجولة القادمة.'};
        else if(room.players.filter(p=>!p.left).length>=MAX_PLAYERS)result={error:'الغرفة ممتلئة.'};
        else {const pid=this.addPlayer(room,body.name,false);result={pid,code,addrs:[]};this.broadcast(room);}
      } else if(path==='/api/act') { result=this.handleAct(body); }
      else return Response.json({error:'غير موجود'},{status:404});
      await this.save(); return Response.json(result);
    }
    return new Response('Not found',{status:404});
  }
}
