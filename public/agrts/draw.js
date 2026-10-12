/* Iteration 11 field painter. The functions below are the prototype draw path.
   Sim positions (the 800×380 match) are mapped into the canvas CSS pixels first;
   glyphs, bases and terrain ink stay the prototype's own pixel sizes.
   Keep this file identical to relay/public/agrts-draw.js. */
(() => {
  'use strict';
  let ctx, W, H, WALLS, ROUGH, land, hp, elapsed, cameraShake;
  let units, shots, sparks, combatFx, spawnFx, capturePulses, spendPulses, healPopups;
  // Unit look by type id. The arena sends its units.csv table in every frame (f.unitTable) and
  // setTable() swaps it in, so a new unit draws here without a page or relay rebuild.
  // shape: arrow | diamond | hex | disc | cross | circle (any other value draws as circle, with the glyph).
  // combatFx kind 'detonate' is a kamikaze blast (the Drone): flash, shock ring and the splash radius.
  // role picks the shot look: ranged = beam, armor = heavy bolt. These defaults cover an older arena.
  const BUILTIN = [
    { type: 'scout', shape: 'arrow', role: 'fast', color: '#bafc82', glyph: '›', r: 9 },
    { type: 'rifle', shape: 'diamond', role: 'ranged', color: '#8ee5c1', glyph: '✦', r: 11 },
    { type: 'tank', shape: 'hex', role: 'armor', color: '#efbd68', glyph: '⬟', r: 14 },
    { type: 'medic', shape: 'disc', role: 'healer', color: '#a9c7ff', glyph: '+', r: 10 },
  ];
  const SPAWN_TINT = { scout: '#f5ffd8', medic: '#a9dfff' }; // the prototype's spawn accents; others use their color
  const FALLBACK = { shape: 'circle', role: '', color: '#d8e0d0', glyph: '?', r: 10 };
  let TYPES = {}, tableSig = '';
  function setTable(list) {
    if (!Array.isArray(list) || !list.length) return;
    const sig = JSON.stringify(list);
    if (sig === tableSig) return;
    const next = {};
    for (const t of list) {
      if (!t || !t.type) continue;
      const r = Number(t.r);
      next[t.type] = { shape: String(t.shape || 'circle'), role: String(t.role || ''), color: t.color || FALLBACK.color, glyph: String(t.glyph || '?'), r: r > 0 && r <= 40 ? r : 10 };
    }
    if (!Object.keys(next).length) return;
    TYPES = next; tableSig = sig; iconCache.clear();
  }
  const typeOf = k => TYPES[k] || FALLBACK;

function inRects(x,y,rects){const nx=x/W,ny=y/H;return rects.some(([x0,y0,x1,y1])=>nx>=x0&&nx<=x1&&ny>=y0&&ny<=y1)}
function wallOverlap(x,y,r=0){for(const [x0,y0,x1,y1] of WALLS){const l=x0*W-r,t=y0*H-r,rr=x1*W+r,b=y1*H+r;if(x>=l&&x<=rr&&y>=t&&y<=b)return true}return false}
function drawTerrain(){ctx.save();const cw=W/24,ch=H/12;for(let i=0;i<520;i++){const seed=i*7919+37,nx=((seed*37)%10007)/10007,ny=((seed*91+17)%10009)/10009,x=nx*W,y=ny*H,rough=inRects(x,y,ROUGH),keep=rough&&((i%3)!==0);if(!keep||wallOverlap(x,y))continue;const r=1.1+(i%4)*.38;ctx.fillStyle=i%2?'rgba(214,174,112,.55)':'rgba(92,73,51,.62)';ctx.beginPath();ctx.ellipse(x,y,r*1.7,r,((i%7)-3)*.12,0,Math.PI*2);ctx.fill()}const stones=['#747568','#62675f','#858171','#575e57','#777b6d'];for(let gy=0;gy<12;gy++)for(let gx=0;gx<24;gx++){const x=(gx+.5)*cw,y=(gy+.5)*ch;if(!wallOverlap(x,y))continue;const seed=gx*61+gy*137,sw=cw*(.58+((seed%13)/100)),sh=ch*(.48+((seed%17)/100)),cx=x+((seed%7)-3)*.55,cy=y+((seed%9)-4)*.38;ctx.fillStyle='rgba(0,0,0,.38)';ctx.beginPath();ctx.ellipse(cx+2,cy+3,sw*.54,sh*.50,0,0,Math.PI*2);ctx.fill();ctx.fillStyle=stones[seed%stones.length];ctx.strokeStyle='rgba(34,40,36,.9)';ctx.lineWidth=1.4;ctx.beginPath();ctx.roundRect(cx-sw*.52,cy-sh*.48,sw,sh,Math.min(6,cw*.17));ctx.fill();ctx.stroke();ctx.fillStyle='rgba(225,222,192,.38)';ctx.beginPath();ctx.roundRect(cx-sw*.40,cy-sh*.36,sw*.66,Math.max(2,sh*.12),2);ctx.fill();const sx=cx+((seed%5)-2)*cw*.18,sy=cy+((seed%11)-5)*ch*.20,sr=1.2+(seed%3)*.6;ctx.fillStyle=stones[(seed+2)%stones.length];ctx.beginPath();ctx.ellipse(sx,sy,sr*1.4,sr,0,0,Math.PI*2);ctx.fill()}ctx.restore()}
function grid(){ctx.fillStyle='#111819';ctx.fillRect(0,0,W,H);const cw=W/24,ch=H/12;for(let x=0;x<24;x++)for(let y=0;y<12;y++){ctx.fillStyle=(x+y)%2?'#141c1b':'#17201e';ctx.fillRect(x*cw,y*ch,cw-1,ch-1);if((x*13+y*7)%23===0){ctx.fillStyle='#29352e';ctx.fillRect(x*cw+cw*.27,y*ch+ch*.45,3,2)}}for(let x=0;x<24;x++)for(let y=0;y<12;y++){const zone=Math.min(7,Math.floor(x/3));if(Math.abs(land[zone])>.04){ctx.fillStyle=land[zone]>0?`rgba(186,252,130,${Math.abs(land[zone])*.20})`:`rgba(255,119,104,${Math.abs(land[zone])*.20})`;ctx.fillRect(x*cw,y*ch,cw-1,ch-1)}}for(let i=0;i<8;i++){const x=W*(i+.5)/8,y=H*.08;ctx.fillStyle=Math.abs(land[i])>.12?(land[i]>0?'#bafc82':'#ff7768'):'#637069';ctx.beginPath();ctx.arc(x,y,3+Math.abs(land[i])*2,0,Math.PI*2);ctx.fill()}for(let i=0;i<5;i++){const x=W*(.27+i*.105),y=H*(.22+(i%2)*.55);ctx.fillStyle='#414c40';ctx.beginPath();ctx.arc(x,y,4,0,Math.PI*2);ctx.fill();ctx.fillStyle='#69785d';ctx.beginPath();ctx.arc(x,y,1.5,0,Math.PI*2);ctx.fill()}}
function base(s){const x=s===0?13:W-13,y=H/2,c=s===0?'#bafc82':'#ff7768',critical=hp[s]<=30,pulse=.5+.5*Math.sin(elapsed*12);ctx.save();ctx.shadowColor=critical?'#ff514f':c;ctx.shadowBlur=critical?18+12*pulse:14;ctx.fillStyle=s===0?'#213428':'#3b2221';ctx.strokeStyle=c;ctx.lineWidth=2;ctx.beginPath();ctx.roundRect(x-9,y-33,18,66,3);ctx.fill();ctx.stroke();ctx.shadowBlur=0;ctx.fillStyle=c;ctx.fillRect(x-2,y-18,4,36);ctx.fillRect(x-12,y-4,24,8);if(critical){ctx.strokeStyle='#ff6158';ctx.globalAlpha=.45+.4*pulse;ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y,27+pulse*6,0,Math.PI*2);ctx.stroke()}ctx.restore()}
function drawUnit(u){const a=typeOf(u.type),c=u.side===0?'#bafc82':'#ff7768',z=a.r;ctx.save();ctx.translate(u.x,u.y);ctx.globalAlpha=.55+Math.min(.45,u.age*2);ctx.shadowColor=c;ctx.shadowBlur=10;ctx.fillStyle=u.hitFlash>0?'#fff4d0':c;ctx.strokeStyle='#0d1412';ctx.lineWidth=2;if(a.shape==='arrow'){const ang=Math.atan2(u.facingY||0,u.facingX??u.dir);ctx.save();ctx.rotate(ang);ctx.beginPath();ctx.moveTo(z,0);ctx.lineTo(-z,-z*.8);ctx.lineTo(-z*.5,0);ctx.lineTo(-z,z*.8);ctx.closePath();ctx.fill();ctx.stroke();ctx.restore()}else if(a.shape==='diamond'){ctx.rotate(Math.PI/4);ctx.fillRect(-z*.62,-z*.62,z*1.24,z*1.24);ctx.strokeRect(-z*.62,-z*.62,z*1.24,z*1.24)}else if(a.shape==='hex'){ctx.beginPath();for(let i=0;i<6;i++){const q=i*Math.PI/3;ctx.lineTo(Math.cos(q)*z,Math.sin(q)*z)}ctx.closePath();ctx.fill();ctx.stroke();ctx.fillStyle='#151a16';ctx.fillRect(-z*.4,-2,z*.8,4)}else if(a.shape==='cross'){const ang=Math.atan2(u.facingY||0,u.facingX??u.dir);if(!u.icon){ctx.save();ctx.shadowBlur=0;ctx.globalAlpha*=.35;ctx.fillStyle='#000';ctx.beginPath();ctx.ellipse(2,z*.95,z*.8,z*.28,0,0,Math.PI*2);ctx.fill();ctx.restore();}ctx.rotate(ang+Math.PI/4);ctx.lineCap='round';ctx.lineWidth=z*.62;ctx.strokeStyle='#0d1412';ctx.beginPath();ctx.moveTo(-z,0);ctx.lineTo(z,0);ctx.moveTo(0,-z);ctx.lineTo(0,z);ctx.stroke();ctx.lineWidth=z*.36;ctx.strokeStyle=ctx.fillStyle;ctx.beginPath();ctx.moveTo(-z*.92,0);ctx.lineTo(z*.92,0);ctx.moveTo(0,-z*.92);ctx.lineTo(0,z*.92);ctx.stroke();ctx.lineCap='butt';ctx.fillStyle=a.color;ctx.beginPath();ctx.arc(0,0,z*.32,0,Math.PI*2);ctx.fill()}else if(a.shape==='disc'){ctx.beginPath();ctx.arc(0,0,z*.8,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle='#142';ctx.fillRect(-2,-z*.48,4,z*.96);ctx.fillRect(-z*.48,-2,z*.96,4)}else{ctx.beginPath();ctx.arc(0,0,z*.85,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.shadowBlur=0;ctx.fillStyle='#142';ctx.font=`700 ${Math.max(7,Math.round(z*1.1))}px monospace`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(a.glyph,0,.5);ctx.textBaseline='alphabetic'}ctx.shadowBlur=0;ctx.globalAlpha=1;if(!u.icon){ctx.fillStyle='#1a211c';ctx.fillRect(-z,-z-6,z*2,3);ctx.fillStyle=c;ctx.fillRect(-z,-z-6,z*2*Math.max(0,u.hp/u.max),3)}ctx.restore();if(u.hp/u.max<=.3){const pulse=.5+.5*Math.sin(elapsed*13+u.x*.08);ctx.save();ctx.globalAlpha=.32+.5*pulse;ctx.strokeStyle='#ff5a51';ctx.lineWidth=2.2;ctx.shadowColor='#ff3838';ctx.shadowBlur=14;ctx.beginPath();ctx.arc(u.x,u.y,z+8+pulse*3,0,Math.PI*2);ctx.stroke();ctx.restore()}if(u.medicMode){ctx.save();ctx.globalAlpha=.95;ctx.strokeStyle=u.medicMode==='HEALING'?'#e5ffa8':'#8fe6ff';ctx.lineWidth=2;ctx.shadowColor=ctx.strokeStyle;ctx.shadowBlur=14;ctx.beginPath();ctx.arc(u.x,u.y,z+7,0,Math.PI*2);ctx.stroke();ctx.fillStyle=ctx.strokeStyle;ctx.font='700 7px monospace';ctx.textAlign='center';ctx.fillText(u.medicMode==='HEALING'?'AID':'MEDIC →',u.x,u.y-z-13);ctx.restore()}if(u.healing){ctx.save();ctx.globalAlpha=.85;ctx.strokeStyle='#e5ffa8';ctx.lineWidth=1.4;ctx.shadowColor='#d6ff9b';ctx.shadowBlur=12;ctx.beginPath();ctx.arc(u.x,u.y,z+5,0,Math.PI*2);ctx.stroke();ctx.restore()}if(u.guard){ctx.save();ctx.globalAlpha=.9;ctx.strokeStyle=c;ctx.setLineDash([3,2]);ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(u.x,u.y,z+7,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=c;ctx.font='700 7px monospace';ctx.textAlign='center';ctx.fillText('GUARD',u.x,u.y-z-12);ctx.restore()}}
function drawSpawnFx(){for(const p of spawnFx){const q=p.t/p.life,fade=1-q,team=p.side===0?'#bafc82':'#ff7768',a=typeOf(p.type),accent=SPAWN_TINT[p.type]||a.color,r=8+q*30;ctx.save();ctx.globalAlpha=fade;ctx.shadowColor=team;ctx.shadowBlur=18;ctx.strokeStyle=team;ctx.lineWidth=2.5;ctx.beginPath();ctx.ellipse(p.x,p.y,r,r*.55,0,0,Math.PI*2);ctx.stroke();ctx.globalAlpha=fade*.7;ctx.lineWidth=1;ctx.beginPath();ctx.ellipse(p.x,p.y,r*.65,r*.37,0,0,Math.PI*2);ctx.stroke();ctx.translate(p.x,p.y);ctx.rotate(q*Math.PI*1.5);ctx.strokeStyle=accent;ctx.fillStyle=accent;ctx.shadowColor=accent;ctx.shadowBlur=14;if(a.shape==='arrow'){for(let i=0;i<5;i++){const g=i*Math.PI*2/5;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(Math.cos(g)*7,Math.sin(g)*7);ctx.lineTo(Math.cos(g)*(16+q*18),Math.sin(g)*(16+q*18));ctx.stroke()}}else if(a.shape==='diamond'){ctx.lineWidth=2.2;ctx.strokeRect(-10-q*5,-10-q*5,20+q*10,20+q*10);ctx.globalAlpha=fade*.65;ctx.strokeRect(-5, -5,10,10)}else if(a.shape==='hex'){ctx.lineWidth=3;ctx.beginPath();for(let i=0;i<6;i++){const g=i*Math.PI/3-Math.PI/2,x=Math.cos(g)*(10+q*12),y=Math.sin(g)*(10+q*12);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}ctx.closePath();ctx.stroke();ctx.globalAlpha=fade*.25;ctx.beginPath();ctx.arc(0,0,8+q*10,0,Math.PI*2);ctx.fill()}else{ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(-2.5, -11-q*4);ctx.lineTo(2.5,-11-q*4);ctx.lineTo(2.5,-2.5);ctx.lineTo(11+q*4,-2.5);ctx.lineTo(11+q*4,2.5);ctx.lineTo(2.5,2.5);ctx.lineTo(2.5,11+q*4);ctx.lineTo(-2.5,11+q*4);ctx.lineTo(-2.5,2.5);ctx.lineTo(-11-q*4,2.5);ctx.lineTo(-11-q*4,-2.5);ctx.lineTo(-2.5,-2.5);ctx.closePath();ctx.stroke()}ctx.restore()}}
function draw(){ctx.save();if(cameraShake>0){const q=cameraShake/.28;ctx.translate((Math.random()-.5)*8*q,(Math.random()-.5)*6*q)}grid();drawTerrain();drawSpawnFx();base(0);base(1);for(const p of capturePulses){const q=p.t/p.life,x=W*p.zone/8;ctx.save();ctx.globalAlpha=Math.max(0,1-q);ctx.strokeStyle=p.side===0?'#bafc82':'#ff7768';ctx.shadowColor=ctx.strokeStyle;ctx.shadowBlur=16;ctx.lineWidth=2+2*(1-q);ctx.strokeRect(x+2,3,W/8-4,H-6);ctx.beginPath();ctx.arc(x+W/16,H/2,8+q*H*.42,0,Math.PI*2);ctx.stroke();ctx.restore()}for(const p of spendPulses){const q=Math.min(1,p.t/1.4);ctx.save();ctx.globalAlpha=1-q;ctx.strokeStyle=p.side===0?'#bafc82':'#ff7768';ctx.lineWidth=3*(1-q)+1;ctx.shadowColor=ctx.strokeStyle;ctx.shadowBlur=22;ctx.beginPath();ctx.arc(p.x,p.y,13+q*60,0,Math.PI*2);ctx.stroke();ctx.restore()}for(const p of healPopups){ctx.save();ctx.globalAlpha=Math.max(0,1-p.t/.9);ctx.fillStyle='#e5ffa8';ctx.font="700 10px 'IBM Plex Mono'";ctx.textAlign='center';ctx.shadowColor='#d6ff9b';ctx.shadowBlur=10;ctx.fillText(`+${p.amount} HP`,p.x,p.y-12-p.t*20);ctx.restore()}for(const p of sparks){ctx.globalAlpha=Math.max(0,p.life*2);ctx.fillStyle=p.col;ctx.fillRect(p.x,p.y,2.4,2.4)}ctx.globalAlpha=1;for(const u of units){if(u.medicTarget){const p=u.medicTarget,pulse=(elapsed*28)%12;ctx.save();ctx.globalAlpha=.72;ctx.setLineDash([5,4]);ctx.lineDashOffset=-pulse;ctx.strokeStyle='#a9dfff';ctx.lineWidth=2.5;ctx.shadowColor='#78c9ff';ctx.shadowBlur=10;ctx.beginPath();ctx.moveTo(u.x,u.y);ctx.lineTo(p.x,p.y);ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=.9;ctx.fillStyle='#e5f5ff';const q=(elapsed*1.8)%1;ctx.beginPath();ctx.arc(u.x+(p.x-u.x)*q,u.y+(p.y-u.y)*q,2.5,0,Math.PI*2);ctx.fill();ctx.restore()}}for(const s of shots){const q=Math.max(0,Math.min(1,1-s.life/s.maxLife)),role=typeOf(s.type).role;ctx.save();ctx.globalAlpha=Math.min(1,s.life/s.maxLife*1.5);ctx.strokeStyle=s.col;ctx.fillStyle=s.col;ctx.shadowColor=s.col;ctx.shadowBlur=role==='armor'?12:8;if(role==='ranged'){ctx.globalAlpha*=.82;ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(s.x,s.y);ctx.lineTo(s.tx,s.ty);ctx.stroke();ctx.globalAlpha=1;ctx.strokeStyle='#e8fff5';ctx.lineWidth=1.2;ctx.beginPath();ctx.moveTo(s.x,s.y);ctx.lineTo(s.tx,s.ty);ctx.stroke()}else{const px=s.x+(s.tx-s.x)*q,py=s.y+(s.ty-s.y)*q,tail=role==='armor'?.22:.16,ex=s.x+(s.tx-s.x)*Math.max(0,q-tail),ey=s.y+(s.ty-s.y)*Math.max(0,q-tail);ctx.lineWidth=role==='armor'?3:2;ctx.beginPath();ctx.moveTo(ex,ey);ctx.lineTo(px,py);ctx.stroke();ctx.beginPath();ctx.arc(px,py,role==='armor'?4:2.3,0,Math.PI*2);ctx.fill()}ctx.restore()}for(const e of combatFx){const q=e.t/e.life;ctx.save();ctx.globalAlpha=Math.max(0,1-q);ctx.strokeStyle=e.col;ctx.fillStyle=e.col;ctx.shadowColor=e.col;ctx.shadowBlur=e.kind==='blast'?18:10;if(e.kind==='detonate'){const R=e.r*(.35+q*.95);ctx.shadowBlur=26;ctx.globalAlpha=Math.max(0,1-q)*.55;const g=ctx.createRadialGradient(e.x,e.y,0,e.x,e.y,R);g.addColorStop(0,'#fff6d8');g.addColorStop(.35,e.col);g.addColorStop(1,'rgba(255,120,60,0)');ctx.fillStyle=g;ctx.beginPath();ctx.arc(e.x,e.y,R,0,Math.PI*2);ctx.fill();ctx.globalAlpha=Math.max(0,1-q);ctx.lineWidth=3.2*(1-q)+1;ctx.strokeStyle='#ffe2a8';ctx.beginPath();ctx.arc(e.x,e.y,e.r*(.5+q*.9),0,Math.PI*2);ctx.stroke();ctx.strokeStyle=e.col;ctx.lineWidth=1.6;ctx.setLineDash([4,5]);ctx.beginPath();ctx.arc(e.x,e.y,e.r*(.3+q*1.3),0,Math.PI*2);ctx.stroke();ctx.setLineDash([])}else if(e.kind==='muzzle'){for(let i=0;i<6;i++){const a=i*Math.PI/3,r=e.r*(.3+q*.8);ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(e.x+Math.cos(a)*r*.35,e.y+Math.sin(a)*r*.35);ctx.lineTo(e.x+Math.cos(a)*r,e.y+Math.sin(a)*r);ctx.stroke()}}else{ctx.lineWidth=e.kind==='blast'?3:2;ctx.beginPath();ctx.arc(e.x,e.y,4+q*e.r,0,Math.PI*2);ctx.stroke();if(e.kind==='blast'){ctx.globalAlpha*=.22;ctx.beginPath();ctx.arc(e.x,e.y,q*e.r*.7,0,Math.PI*2);ctx.fill()}}ctx.restore()}ctx.globalAlpha=1;for(const u of units)drawUnit(u);ctx.restore();}

  let sx = 1, sy = 1;

  function paint(ctxIn, f) {
    ctx = ctxIn;
    if (f.unitTable) setTable(f.unitTable);
    const dpr = f.dpr || 1;
    const simW = f.w || 800, simH = f.h || 380;
    W = Math.max(1, f.cssW || simW);
    H = Math.max(1, f.cssH || simH);
    sx = W / simW; sy = H / simH;
    WALLS = f.walls || [];
    ROUGH = f.rough || [];
    land = f.land || [];
    hp = f.hp || [100, 100];
    elapsed = f.elapsed || 0;
    cameraShake = f.cameraShake || 0;
    units = (f.units || []).map(u => {
      const dir = u.dir != null ? u.dir : (u.side === 0 ? 1 : -1);
      return Object.assign({}, u, {
        x: u.x * sx, y: u.y * sy, dir,
        facingX: u.facingX != null ? u.facingX : dir,
        facingY: u.facingY || 0,
      });
    });
    const byId = new Map(units.map(u => [u.id, u]));
    for (const u of units) u.medicTarget = u.medicTargetId != null ? (byId.get(u.medicTargetId) || null) : (u.medicTarget || null);
    shots = (f.shots || []).map(s => Object.assign({}, s, {
      x: s.x * sx, y: s.y * sy,
      tx: (s.tx != null ? s.tx : s.x) * sx,
      ty: (s.ty != null ? s.ty : s.y) * sy,
    }));
    sparks = (f.sparks || []).map(p => Object.assign({}, p, { x: p.x * sx, y: p.y * sy }));
    combatFx = (f.combatFx || []).map(p => Object.assign({}, p, { x: p.x * sx, y: p.y * sy }));
    spawnFx = (f.spawnFx || []).map(p => Object.assign({}, p, { x: p.x * sx, y: p.y * sy }));
    spendPulses = (f.spendPulses || []).map(p => Object.assign({}, p, { x: p.x * sx, y: p.y * sy }));
    healPopups = (f.healPopups || []).map(p => Object.assign({}, p, { x: p.x * sx, y: p.y * sy }));
    capturePulses = f.capturePulses || [];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  // Side panel arsenal icon: drawUnit's own body (same shape and team colour, no HP bar) on a small canvas.
  // One scale for every type, so a Breaker reads bigger than a Scout, as on the field. Cached as a data URL.
  // A type this painter does not know yet draws as the generic circle.
  const iconCache = new Map();
  function icon(type, side, cssPx) {
    const px = Math.max(8, Math.round(cssPx || 16)), key = `${type}|${side}|${px}`;
    if (iconCache.has(key)) return iconCache.get(key);
    let url = '';
    if (typeof document !== 'undefined') {
      const cv = document.createElement('canvas'), dim = px * 2;
      cv.width = cv.height = dim;
      const keep = ctx;
      try {
        ctx = cv.getContext('2d');
        const maxR = Math.max(typeOf(type).r, ...Object.values(TYPES).map(t => t.r)), k = dim / (2 * (maxR + 3));
        ctx.setTransform(k, 0, 0, k, dim / 2, dim / 2);
        const dir = side === 0 ? 1 : -1;
        drawUnit({ type, side, x: 0, y: 0, hp: 1, max: 1, age: 1, hitFlash: 0, dir, facingX: dir, facingY: 0, icon: true });
        url = cv.toDataURL('image/png');
      } catch (e) { url = ''; }
      finally { ctx = keep; }
    }
    iconCache.set(key, url);
    return url;
  }

  setTable(BUILTIN);
  window.GbwAgrtsDraw = { paint, icon, setTable, get types() { return TYPES; } };
})();
