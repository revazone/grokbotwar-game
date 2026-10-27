/* Iteration 11 field painter. The functions below are the prototype draw path.
   Sim positions (the 800×380 match) are mapped into the canvas CSS pixels first;
   glyphs, bases and terrain ink stay the prototype's own pixel sizes.
   Keep this file identical to relay/public/agrts-draw.js. */
(() => {
  'use strict';
  let ctx, W, H, WALLS, ROUGH, land, hp, elapsed, cameraShake;
  let mines = [], units, shots, sparks, combatFx, spawnFx, capturePulses, spendPulses, healPopups, turrets, hospitals;
  // Towers and Team HP (TOWERS=1; src/agrts/towers.js). All empty with the flag off, so the old picture is unchanged.
  let towers = [], shield = [], hpEvents = [], towerPts = [0, 0], towersOn = false, timeLimit = 0;
  // Unit look by type id. The arena sends its units.csv table in every frame (f.unitTable) and
  // setTable() swaps it in, so a new unit draws here without a page or relay rebuild.
  // shape: arrow | diamond | hex | disc | cross | circle (any other value draws as circle, with the glyph).
  // combatFx kind 'detonate' is a kamikaze blast (the Drone): flash, shock ring and the splash radius.
  // kind 'mortarLaunch' is the tube flash and puff. kind 'mortar' draws an incoming marker until `delay`, then a ring at the splash radius and a scorch that fades over the rest of its life (~1 s).
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
function drawUnit(u){const a=typeOf(u.type),c=u.side===0?'#bafc82':'#ff7768',z=a.r;ctx.save();ctx.translate(u.x,u.y);ctx.globalAlpha=.55+Math.min(.45,u.age*2);ctx.shadowColor=c;ctx.shadowBlur=10;ctx.fillStyle=u.hitFlash>0?'#fff4d0':c;ctx.strokeStyle='#0d1412';ctx.lineWidth=2;if(a.shape==='arrow'){const ang=Math.atan2(u.facingY||0,u.facingX??u.dir);ctx.save();ctx.rotate(ang);ctx.beginPath();ctx.moveTo(z,0);ctx.lineTo(-z,-z*.8);ctx.lineTo(-z*.5,0);ctx.lineTo(-z,z*.8);ctx.closePath();ctx.fill();ctx.stroke();ctx.restore()}else if(a.shape==='diamond'){ctx.rotate(Math.PI/4);ctx.fillRect(-z*.62,-z*.62,z*1.24,z*1.24);ctx.strokeRect(-z*.62,-z*.62,z*1.24,z*1.24)}else if(a.shape==='hex'){ctx.beginPath();for(let i=0;i<6;i++){const q=i*Math.PI/3;ctx.lineTo(Math.cos(q)*z,Math.sin(q)*z)}ctx.closePath();ctx.fill();ctx.stroke();ctx.fillStyle='#151a16';ctx.fillRect(-z*.4,-2,z*.8,4)}else if(a.shape==='cross'){const ang=Math.atan2(u.facingY||0,u.facingX??u.dir);if(!u.icon){ctx.save();ctx.shadowBlur=0;ctx.globalAlpha*=.35;ctx.fillStyle='#000';ctx.beginPath();ctx.ellipse(2,z*.95,z*.8,z*.28,0,0,Math.PI*2);ctx.fill();ctx.restore();}ctx.rotate(ang+Math.PI/4);ctx.lineCap='round';ctx.lineWidth=z*.62;ctx.strokeStyle='#0d1412';ctx.beginPath();ctx.moveTo(-z,0);ctx.lineTo(z,0);ctx.moveTo(0,-z);ctx.lineTo(0,z);ctx.stroke();ctx.lineWidth=z*.36;ctx.strokeStyle=ctx.fillStyle;ctx.beginPath();ctx.moveTo(-z*.92,0);ctx.lineTo(z*.92,0);ctx.moveTo(0,-z*.92);ctx.lineTo(0,z*.92);ctx.stroke();ctx.lineCap='butt';ctx.fillStyle=a.color;ctx.beginPath();ctx.arc(0,0,z*.32,0,Math.PI*2);ctx.fill()}else if(a.shape==='disc'){ctx.beginPath();ctx.arc(0,0,z*.8,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle='#142';ctx.fillRect(-2,-z*.48,4,z*.96);ctx.fillRect(-z*.48,-2,z*.96,4)}else if(a.shape==='tube'){const ang=Math.atan2(u.facingY||0,u.facingX??u.dir);ctx.rotate(ang);ctx.fillStyle='#24180f';ctx.fillRect(-z*.85,-z*.42,z*.7,z*.84);ctx.fillStyle=u.hitFlash>0?'#fff4d0':c;ctx.beginPath();ctx.moveTo(-z*.15,-z*.28);ctx.lineTo(z*1.2,-z*.1);ctx.lineTo(z*1.2,z*.1);ctx.lineTo(-z*.15,z*.28);ctx.closePath();ctx.fill();ctx.stroke();ctx.beginPath();ctx.arc(-z*.05,0,z*.34,0,Math.PI*2);ctx.fill();ctx.stroke()}else{ctx.beginPath();ctx.arc(0,0,z*.85,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.shadowBlur=0;ctx.fillStyle='#142';ctx.font=`700 ${Math.max(7,Math.round(z*1.1))}px monospace`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(a.glyph,0,.5);ctx.textBaseline='alphabetic'}ctx.shadowBlur=0;ctx.globalAlpha=1;if(!u.icon){ctx.fillStyle='#1a211c';ctx.fillRect(-z,-z-6,z*2,3);ctx.fillStyle=c;ctx.fillRect(-z,-z-6,z*2*Math.max(0,u.hp/u.max),3)}ctx.restore();if(u.hp/u.max<=.3){const pulse=.5+.5*Math.sin(elapsed*13+u.x*.08);ctx.save();ctx.globalAlpha=.32+.5*pulse;ctx.strokeStyle='#ff5a51';ctx.lineWidth=2.2;ctx.shadowColor='#ff3838';ctx.shadowBlur=14;ctx.beginPath();ctx.arc(u.x,u.y,z+8+pulse*3,0,Math.PI*2);ctx.stroke();ctx.restore()}if(u.medicMode){ctx.save();ctx.globalAlpha=.95;ctx.strokeStyle=u.medicMode==='HEALING'?'#e5ffa8':'#8fe6ff';ctx.lineWidth=2;ctx.shadowColor=ctx.strokeStyle;ctx.shadowBlur=14;ctx.beginPath();ctx.arc(u.x,u.y,z+7,0,Math.PI*2);ctx.stroke();ctx.fillStyle=ctx.strokeStyle;ctx.font='700 7px monospace';ctx.textAlign='center';ctx.fillText(u.medicMode==='HEALING'?'AID':'MEDIC →',u.x,u.y-z-13);ctx.restore()}if(u.healing){ctx.save();ctx.globalAlpha=.85;ctx.strokeStyle='#e5ffa8';ctx.lineWidth=1.4;ctx.shadowColor='#d6ff9b';ctx.shadowBlur=12;ctx.beginPath();ctx.arc(u.x,u.y,z+5,0,Math.PI*2);ctx.stroke();ctx.restore()}if(u.guard){ctx.save();ctx.globalAlpha=.9;ctx.strokeStyle=c;ctx.setLineDash([3,2]);ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(u.x,u.y,z+7,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=c;ctx.font='700 7px monospace';ctx.textAlign='center';ctx.fillText('GUARD',u.x,u.y-z-12);ctx.restore()}}
function drawSpawnFx(){for(const p of spawnFx){const q=p.t/p.life,fade=1-q,team=p.side===0?'#bafc82':'#ff7768',a=typeOf(p.type),accent=SPAWN_TINT[p.type]||a.color,r=8+q*30;ctx.save();ctx.globalAlpha=fade;ctx.shadowColor=team;ctx.shadowBlur=18;ctx.strokeStyle=team;ctx.lineWidth=2.5;ctx.beginPath();ctx.ellipse(p.x,p.y,r,r*.55,0,0,Math.PI*2);ctx.stroke();ctx.globalAlpha=fade*.7;ctx.lineWidth=1;ctx.beginPath();ctx.ellipse(p.x,p.y,r*.65,r*.37,0,0,Math.PI*2);ctx.stroke();ctx.translate(p.x,p.y);ctx.rotate(q*Math.PI*1.5);ctx.strokeStyle=accent;ctx.fillStyle=accent;ctx.shadowColor=accent;ctx.shadowBlur=14;if(a.shape==='arrow'){for(let i=0;i<5;i++){const g=i*Math.PI*2/5;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(Math.cos(g)*7,Math.sin(g)*7);ctx.lineTo(Math.cos(g)*(16+q*18),Math.sin(g)*(16+q*18));ctx.stroke()}}else if(a.shape==='diamond'){ctx.lineWidth=2.2;ctx.strokeRect(-10-q*5,-10-q*5,20+q*10,20+q*10);ctx.globalAlpha=fade*.65;ctx.strokeRect(-5, -5,10,10)}else if(a.shape==='hex'){ctx.lineWidth=3;ctx.beginPath();for(let i=0;i<6;i++){const g=i*Math.PI/3-Math.PI/2,x=Math.cos(g)*(10+q*12),y=Math.sin(g)*(10+q*12);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}ctx.closePath();ctx.stroke();ctx.globalAlpha=fade*.25;ctx.beginPath();ctx.arc(0,0,8+q*10,0,Math.PI*2);ctx.fill()}else if(a.shape==='tube'){ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(-8,4);ctx.lineTo(14+q*16,-6-q*8);ctx.stroke();ctx.beginPath();ctx.arc(-6,4,5,0,Math.PI*2);ctx.stroke()}else{ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(-2.5, -11-q*4);ctx.lineTo(2.5,-11-q*4);ctx.lineTo(2.5,-2.5);ctx.lineTo(11+q*4,-2.5);ctx.lineTo(11+q*4,2.5);ctx.lineTo(2.5,2.5);ctx.lineTo(2.5,11+q*4);ctx.lineTo(-2.5,11+q*4);ctx.lineTo(-2.5,2.5);ctx.lineTo(-11-q*4,2.5);ctx.lineTo(-11-q*4,-2.5);ctx.lineTo(-2.5,-2.5);ctx.closePath();ctx.stroke()}ctx.restore()}}
// Field hospital (f.hospitals, FIELD_HOSPITAL=1): a cross bunker and an HP bar. A wreck while it rebuilds.
function drawHospital(h){const c=h.side===0?'#bafc82':'#ff7768',x=h.x,y=h.y;ctx.save();ctx.translate(x,y);if(!h.alive){ctx.globalAlpha=.45;ctx.fillStyle='#1d1f1b';ctx.strokeStyle='#3c3a33';ctx.lineWidth=2;ctx.beginPath();ctx.roundRect(-14,-10,28,20,3);ctx.fill();ctx.stroke();ctx.fillStyle='#8a8577';ctx.font='700 11px monospace';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('+',0,1);ctx.restore();return}ctx.shadowColor=c;ctx.shadowBlur=h.hitFlash?16:8;ctx.fillStyle=h.side===0?'#213428':'#3b2221';ctx.strokeStyle=h.hitFlash>0?'#fff4d0':c;ctx.lineWidth=2;ctx.beginPath();ctx.roundRect(-16,-12,32,24,3);ctx.fill();ctx.stroke();ctx.shadowBlur=0;ctx.fillStyle=c;ctx.fillRect(-2,-8,4,16);ctx.fillRect(-8,-2,16,4);ctx.fillStyle='#1a211c';ctx.fillRect(-14,-18,28,3);ctx.fillStyle=h.hp/h.max<=.3?'#ff6158':c;ctx.fillRect(-14,-18,28*Math.max(0,h.hp/h.max),3);ctx.restore()}
// BUY RANGE boost (frames carry rounds, range and rangeBase while a boost has rounds left): a solid gold ring at the boosted reach (always on, glowing), the normal reach as a faint dashed ring, and a "RNG n" tag over the structure.
function boostRing(t){if(!(t.rounds>0)||!t.alive)return;const R=t.range||0,R0=t.rangeBase||R/1.4,pu=.5+.5*Math.sin(elapsed*4);ctx.save();ctx.strokeStyle='#ffd36b';ctx.shadowColor='#ffd36b';ctx.shadowBlur=10+6*pu;ctx.globalAlpha=.7+.2*pu;ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(t.x,t.y,R*sx,R*sy,0,0,Math.PI*2);ctx.stroke();ctx.shadowBlur=0;ctx.globalAlpha=.07;ctx.fillStyle='#ffd36b';ctx.fill();ctx.globalAlpha=.28;ctx.lineWidth=1;ctx.setLineDash([3,6]);ctx.beginPath();ctx.ellipse(t.x,t.y,R0*sx,R0*sy,0,0,Math.PI*2);ctx.stroke();ctx.restore()}
function boostTag(t,dy){if(!(t.rounds>0)||!t.alive)return;const s='RNG '+t.rounds;ctx.save();ctx.font="800 9px 'IBM Plex Mono', monospace";ctx.textAlign='center';ctx.textBaseline='middle';const w=ctx.measureText(s).width+8;ctx.fillStyle='rgba(13,20,18,.88)';ctx.strokeStyle='#ffd36b';ctx.lineWidth=1;ctx.beginPath();ctx.roundRect(-w/2,dy-6,w,12,3);ctx.fill();ctx.stroke();ctx.fillStyle='#ffd36b';ctx.fillText(s,0,dy+.5);ctx.restore()}
// Base turret (f.turrets): plate, rotating barrel, HP bar, a dashed range ring while it has a target; a wreck once down.
function drawTurret(t){const c=t.side===0?'#bafc82':'#ff7768',x=t.x,y=t.y;ctx.save();if(!t.alive){ctx.translate(x,y);ctx.fillStyle='#1d1f1b';ctx.strokeStyle='#3c3a33';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(-11,-8);ctx.lineTo(-4,-12);ctx.lineTo(9,-9);ctx.lineTo(12,4);ctx.lineTo(5,11);ctx.lineTo(-9,10);ctx.lineTo(-12,1);ctx.closePath();ctx.fill();ctx.stroke();ctx.fillStyle='#2b2a25';ctx.beginPath();ctx.arc(-1,0,5.5,0,Math.PI*2);ctx.fill();ctx.rotate(t.angle||0);ctx.strokeStyle='#4a463c';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(3,1);ctx.lineTo(10,4);ctx.stroke();ctx.rotate(-(t.angle||0));for(let i=0;i<3;i++){const q=((elapsed*.35+i/3)%1);ctx.globalAlpha=.35*(1-q);ctx.fillStyle='#8a8577';ctx.beginPath();ctx.arc(Math.sin(i*2.1+elapsed)*3,-6-q*22,3+q*6,0,Math.PI*2);ctx.fill()}ctx.restore();return}
const R=(t.range||110),fired=t.firedAt!=null&&elapsed-t.firedAt<.12;if(t.aim){ctx.save();ctx.globalAlpha=.32;ctx.strokeStyle=c;ctx.setLineDash([5,5]);ctx.lineDashOffset=-elapsed*14;ctx.lineWidth=1.2;ctx.beginPath();ctx.ellipse(x,y,R*sx,R*sy,0,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=.05;ctx.fillStyle=c;ctx.fill();ctx.restore()}
boostRing(t);ctx.translate(x,y);ctx.shadowColor=c;ctx.shadowBlur=t.aim?14:8;ctx.fillStyle=t.side===0?'#213428':'#3b2221';ctx.strokeStyle=c;ctx.lineWidth=2;ctx.beginPath();ctx.roundRect(-11,-11,22,22,4);ctx.fill();ctx.stroke();ctx.shadowBlur=0;ctx.rotate(t.angle||0);const kick=fired?-3:0;ctx.fillStyle='#0d1412';ctx.fillRect(2+kick,-3.5,15,7);ctx.fillStyle=t.hitFlash>0?'#fff4d0':c;ctx.fillRect(3+kick,-2.2,13,4.4);ctx.beginPath();ctx.arc(0,0,7,0,Math.PI*2);ctx.fillStyle=t.hitFlash>0?'#fff4d0':c;ctx.fill();ctx.strokeStyle='#0d1412';ctx.lineWidth=2;ctx.stroke();ctx.fillStyle='#0d1412';ctx.beginPath();ctx.arc(0,0,2.4,0,Math.PI*2);ctx.fill();if(fired){ctx.fillStyle='#fff1b8';ctx.shadowColor='#ffe08a';ctx.shadowBlur=14;ctx.beginPath();ctx.arc(19,0,4,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0}ctx.rotate(-(t.angle||0));ctx.fillStyle='#1a211c';ctx.fillRect(-13,-19,26,3.5);ctx.fillStyle=t.hp/t.max<=.3?'#ff6158':c;ctx.fillRect(-13,-19,26*Math.max(0,t.hp/t.max),3.5);boostTag(t,-31);ctx.restore()}
// Mine shape: a small circle with the ✹ glyph; dim until armed, red ring when an Ember mine is spotted.
function drawMines(){for(const m of mines){ctx.save();ctx.globalAlpha=m.armed?.95:.5;ctx.fillStyle='#3b3324';ctx.strokeStyle=m.side===0?'#c9b27a':'#ff7768';ctx.lineWidth=m.side===1?2.2:1.4;ctx.beginPath();ctx.arc(m.x,m.y,6,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle='#c9b27a';ctx.font="700 9px 'IBM Plex Mono'";ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('✹',m.x,m.y+.5);ctx.restore()}}
function draw(){ctx.save();if(cameraShake>0){const q=cameraShake/.28;ctx.translate((Math.random()-.5)*8*q,(Math.random()-.5)*6*q)}grid();drawTerrain();drawSpawnFx();base(0);base(1);for(const t of turrets)drawTurret(t);for(const h of (hospitals||[]))drawHospital(h);for(const t of (towers||[]))drawTower(t);drawShields();for(const p of capturePulses){const q=p.t/p.life,x=W*p.zone/8;ctx.save();ctx.globalAlpha=Math.max(0,1-q);ctx.strokeStyle=p.side===0?'#bafc82':'#ff7768';ctx.shadowColor=ctx.strokeStyle;ctx.shadowBlur=16;ctx.lineWidth=2+2*(1-q);ctx.strokeRect(x+2,3,W/8-4,H-6);ctx.beginPath();ctx.arc(x+W/16,H/2,8+q*H*.42,0,Math.PI*2);ctx.stroke();ctx.restore()}for(const p of spendPulses){const q=Math.min(1,p.t/1.4);ctx.save();ctx.globalAlpha=1-q;ctx.strokeStyle=p.side===0?'#bafc82':'#ff7768';ctx.lineWidth=3*(1-q)+1;ctx.shadowColor=ctx.strokeStyle;ctx.shadowBlur=22;ctx.beginPath();ctx.arc(p.x,p.y,13+q*60,0,Math.PI*2);ctx.stroke();ctx.restore()}for(const p of healPopups){ctx.save();ctx.globalAlpha=Math.max(0,1-p.t/.9);ctx.fillStyle='#e5ffa8';ctx.font="700 10px 'IBM Plex Mono'";ctx.textAlign='center';ctx.shadowColor='#d6ff9b';ctx.shadowBlur=10;ctx.fillText(`+${p.amount} HP`,p.x,p.y-12-p.t*20);ctx.restore()}for(const p of sparks){ctx.globalAlpha=Math.max(0,p.life*2);ctx.fillStyle=p.col;ctx.fillRect(p.x,p.y,2.4,2.4)}ctx.globalAlpha=1;for(const u of units){if(u.medicTarget){const p=u.medicTarget,pulse=(elapsed*28)%12;ctx.save();ctx.globalAlpha=.72;ctx.setLineDash([5,4]);ctx.lineDashOffset=-pulse;ctx.strokeStyle='#a9dfff';ctx.lineWidth=2.5;ctx.shadowColor='#78c9ff';ctx.shadowBlur=10;ctx.beginPath();ctx.moveTo(u.x,u.y);ctx.lineTo(p.x,p.y);ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=.9;ctx.fillStyle='#e5f5ff';const q=(elapsed*1.8)%1;ctx.beginPath();ctx.arc(u.x+(p.x-u.x)*q,u.y+(p.y-u.y)*q,2.5,0,Math.PI*2);ctx.fill();ctx.restore()}}for(const s of shots){const q=Math.max(0,Math.min(1,1-s.life/s.maxLife)),role=typeOf(s.type).role;if(role==='armor'&&window.GBW_FX_ON)continue;ctx.save();ctx.globalAlpha=Math.min(1,s.life/s.maxLife*1.5);ctx.strokeStyle=s.col;ctx.fillStyle=s.col;ctx.shadowColor=s.col;ctx.shadowBlur=role==='armor'?12:8;if(s.arc){const dist=Math.hypot(s.tx-s.x,s.ty-s.y),mx=(s.x+s.tx)/2,my=Math.min(s.y,s.ty)-Math.min(120,36+dist*.42),bez=tt=>{const u=1-tt;return [u*u*s.x+2*u*tt*mx+tt*tt*s.tx,u*u*s.y+2*u*tt*my+tt*tt*s.ty]},t=q;ctx.globalAlpha=.62;ctx.lineWidth=3.2;ctx.strokeStyle=s.col;ctx.shadowBlur=16;ctx.beginPath();ctx.moveTo(s.x,s.y);ctx.quadraticCurveTo(mx,my,s.tx,s.ty);ctx.stroke();const t0=Math.max(0,t-.24);ctx.globalAlpha=.95;ctx.lineWidth=6;ctx.strokeStyle='#fff6d4';ctx.shadowBlur=20;ctx.beginPath();for(let i=0;i<=10;i++){const p=bez(t0+(t-t0)*i/10);if(i)ctx.lineTo(p[0],p[1]);else ctx.moveTo(p[0],p[1])}ctx.stroke();const head=bez(t);ctx.globalAlpha=1;ctx.fillStyle='#fff8e6';ctx.shadowBlur=24;ctx.beginPath();ctx.arc(head[0],head[1],7.5,0,Math.PI*2);ctx.fill();ctx.fillStyle=s.col;ctx.beginPath();ctx.arc(head[0],head[1],3.6,0,Math.PI*2);ctx.fill()}else if(role==='ranged'){ctx.globalAlpha*=.82;ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(s.x,s.y);ctx.lineTo(s.tx,s.ty);ctx.stroke();ctx.globalAlpha=1;ctx.strokeStyle='#e8fff5';ctx.lineWidth=1.2;ctx.beginPath();ctx.moveTo(s.x,s.y);ctx.lineTo(s.tx,s.ty);ctx.stroke()}else{const px=s.x+(s.tx-s.x)*q,py=s.y+(s.ty-s.y)*q,tail=role==='armor'?.22:.16,ex=s.x+(s.tx-s.x)*Math.max(0,q-tail),ey=s.y+(s.ty-s.y)*Math.max(0,q-tail);ctx.lineWidth=role==='armor'?3:2;ctx.beginPath();ctx.moveTo(ex,ey);ctx.lineTo(px,py);ctx.stroke();ctx.beginPath();ctx.arc(px,py,role==='armor'?4:2.3,0,Math.PI*2);ctx.fill()}ctx.restore()}for(const e of combatFx){const q=e.t/e.life;ctx.save();ctx.globalAlpha=Math.max(0,1-q);ctx.strokeStyle=e.col;ctx.fillStyle=e.col;ctx.shadowColor=e.col;ctx.shadowBlur=e.kind==='blast'?18:10;if(e.kind==='mortarLaunch'){const R=12+q*e.r;ctx.globalAlpha=Math.max(0,1-q);ctx.fillStyle='#fff7d6';ctx.shadowBlur=26;ctx.beginPath();ctx.arc(e.x,e.y,9+q*10,0,Math.PI*2);ctx.fill();ctx.globalAlpha=Math.max(0,1-q)*.75;ctx.strokeStyle='#fff1c4';ctx.lineWidth=3.5;ctx.beginPath();ctx.arc(e.x,e.y,R,0,Math.PI*2);ctx.stroke();ctx.globalAlpha=Math.max(0,1-q)*.5;ctx.fillStyle='#e7dfd0';ctx.beginPath();ctx.arc(e.x,e.y-10-q*22,10+q*16,0,Math.PI*2);ctx.fill()}else if(e.kind==='mortar'){const delay=e.delay||0;if(delay>0&&e.t<delay){const iq=e.t/delay;ctx.globalAlpha=.92;ctx.strokeStyle='#ffe08a';ctx.lineWidth=3;ctx.setLineDash([7,5]);ctx.beginPath();ctx.arc(e.x,e.y,Math.max(10,e.r*(.3+.7*iq)),0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=.85;ctx.beginPath();ctx.moveTo(e.x-12,e.y);ctx.lineTo(e.x+12,e.y);ctx.moveTo(e.x,e.y-12);ctx.lineTo(e.x,e.y+12);ctx.stroke()}else{const span=Math.max(.05,e.life-delay),q2=Math.max(0,Math.min(1,(e.t-delay)/span));if(q2<.4){ctx.globalAlpha=(1-q2/.4)*.95;ctx.fillStyle='#fff4d0';ctx.shadowBlur=30;ctx.beginPath();ctx.arc(e.x,e.y,e.r*(.25+q2),0,Math.PI*2);ctx.fill()}ctx.globalAlpha=Math.max(0,1-q2);ctx.strokeStyle='#ffe7a8';ctx.lineWidth=6;ctx.shadowBlur=22;ctx.beginPath();ctx.arc(e.x,e.y,e.r,0,Math.PI*2);ctx.stroke();ctx.globalAlpha=Math.max(0,1-q2)*.7;ctx.strokeStyle=e.col;ctx.lineWidth=3.5;ctx.beginPath();ctx.arc(e.x,e.y,e.r*(.5+q2*.65),0,Math.PI*2);ctx.stroke();ctx.globalAlpha=Math.max(0,.62*(1-q2));ctx.fillStyle='#3a2414';ctx.beginPath();ctx.ellipse(e.x,e.y,e.r*.92,e.r*.46,0,0,Math.PI*2);ctx.fill()}}else if(e.kind==='detonate'){const R=e.r*(.35+q*.95);ctx.shadowBlur=26;ctx.globalAlpha=Math.max(0,1-q)*.55;const g=ctx.createRadialGradient(e.x,e.y,0,e.x,e.y,R);g.addColorStop(0,'#fff6d8');g.addColorStop(.35,e.col);g.addColorStop(1,'rgba(255,120,60,0)');ctx.fillStyle=g;ctx.beginPath();ctx.arc(e.x,e.y,R,0,Math.PI*2);ctx.fill();ctx.globalAlpha=Math.max(0,1-q);ctx.lineWidth=3.2*(1-q)+1;ctx.strokeStyle='#ffe2a8';ctx.beginPath();ctx.arc(e.x,e.y,e.r*(.5+q*.9),0,Math.PI*2);ctx.stroke();ctx.strokeStyle=e.col;ctx.lineWidth=1.6;ctx.setLineDash([4,5]);ctx.beginPath();ctx.arc(e.x,e.y,e.r*(.3+q*1.3),0,Math.PI*2);ctx.stroke();ctx.setLineDash([])}else if(e.kind==='muzzle'){for(let i=0;i<6;i++){const a=i*Math.PI/3,r=e.r*(.3+q*.8);ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(e.x+Math.cos(a)*r*.35,e.y+Math.sin(a)*r*.35);ctx.lineTo(e.x+Math.cos(a)*r,e.y+Math.sin(a)*r);ctx.stroke()}}else{ctx.lineWidth=e.kind==='blast'?3:2;ctx.beginPath();ctx.arc(e.x,e.y,4+q*e.r,0,Math.PI*2);ctx.stroke();if(e.kind==='blast'){ctx.globalAlpha*=.22;ctx.beginPath();ctx.arc(e.x,e.y,q*e.r*.7,0,Math.PI*2);ctx.fill()}}ctx.restore()}ctx.globalAlpha=1;drawMines();for(const u of units)drawUnit(u);drawHpEvents();drawTimeLine();ctx.restore();}

  // ---- Towers and Team HP (f.towers, f.shield, f.hpEvents, f.towerPts; only with TOWERS=1) ----
  const TEAM_COL = s => (s === 0 ? '#bafc82' : '#ff7768');
  // Gun tower: a taller plate than the base turret, a rotating barrel, an HP bar, a dashed range ring while it has a target.
  function drawGun(t) {
    const c = TEAM_COL(t.side), x = t.x, y = t.y;
    ctx.save();
    if (!t.alive) {
      ctx.translate(x, y); ctx.globalAlpha = .5; ctx.fillStyle = '#1d1f1b'; ctx.strokeStyle = '#3c3a33'; ctx.lineWidth = 2;
      ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 + .3, r = i % 2 ? 9 : 13; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); } ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore(); return;
    }
    const R = t.range || 105, fired = t.firedAt != null && elapsed - t.firedAt < .12;
    if (t.aim) {
      ctx.save(); ctx.globalAlpha = .3; ctx.strokeStyle = c; ctx.setLineDash([5, 5]); ctx.lineDashOffset = -elapsed * 14; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.ellipse(x, y, R * sx, R * sy, 0, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = .045; ctx.fillStyle = c; ctx.fill(); ctx.restore();
    }
    boostRing(t);
    ctx.translate(x, y); ctx.shadowColor = c; ctx.shadowBlur = t.aim ? 16 : 9;
    ctx.fillStyle = t.side === 0 ? '#213428' : '#3b2221'; ctx.strokeStyle = t.hitFlash > 0 ? '#fff4d0' : c; ctx.lineWidth = 2.4;
    ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 + Math.PI / 6; ctx.lineTo(Math.cos(a) * 14, Math.sin(a) * 14); } ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0; ctx.save(); ctx.rotate(t.angle || 0); const kick = fired ? -3 : 0;
    ctx.fillStyle = '#0d1412'; ctx.fillRect(1 + kick, -4, 19, 8); ctx.fillStyle = t.hitFlash > 0 ? '#fff4d0' : c; ctx.fillRect(2 + kick, -2.6, 17, 5.2); ctx.restore();
    ctx.fillStyle = '#0d1412'; ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = c; ctx.beginPath(); ctx.arc(0, 0, 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1a211c'; ctx.fillRect(-14, -22, 28, 3); ctx.fillStyle = t.hp / t.max <= .3 ? '#ff6158' : c; ctx.fillRect(-14, -22, 28 * Math.max(0, t.hp / t.max), 3);
    boostTag(t, -34);
    ctx.restore();
  }
  // Depot: a supply crate with a $ mark and an HP bar. While it stands its base wears a shield (drawShields); a wreck with the rebuild countdown once down.
  function drawDepot(t) {
    const c = TEAM_COL(t.side), x = t.x, y = t.y;
    ctx.save(); ctx.translate(x, y);
    if (!t.alive) {
      ctx.globalAlpha = .5; ctx.fillStyle = '#1d1f1b'; ctx.strokeStyle = '#3c3a33'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(-16, -12, 32, 24, 3); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = '#4a483f'; ctx.beginPath(); ctx.moveTo(-16, -12); ctx.lineTo(16, 12); ctx.moveTo(16, -12); ctx.lineTo(-16, 12); ctx.stroke();
      if (t.rebuild > 0) { ctx.globalAlpha = .85; ctx.fillStyle = '#c9c4b3'; ctx.font = "700 10px 'IBM Plex Mono', monospace"; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t.rebuild + 's', 0, -19); }
      ctx.restore(); return;
    }
    ctx.shadowColor = c; ctx.shadowBlur = t.hitFlash ? 18 : 8;
    ctx.fillStyle = t.side === 0 ? '#213428' : '#3b2221'; ctx.strokeStyle = t.hitFlash > 0 ? '#fff4d0' : c; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.roundRect(-18, -14, 36, 28, 4); ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0;
    ctx.strokeStyle = c; ctx.globalAlpha = .55; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-18, -5); ctx.lineTo(18, -5); ctx.moveTo(-18, 5); ctx.lineTo(18, 5); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillStyle = c; ctx.font = "700 12px 'IBM Plex Mono', monospace"; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('$', 0, 1);
    ctx.fillStyle = '#1a211c'; ctx.fillRect(-16, -22, 32, 3); ctx.fillStyle = t.hp / t.max <= .3 ? '#ff6158' : c; ctx.fillRect(-16, -22, 32 * Math.max(0, t.hp / t.max), 3);
    ctx.restore();
  }
  // Forward post (range launch flow, docs/FORWARD-POST.md): an oval copy of the base (same fill, stroke, glow, cross emblem) with a flag on a mast and an HP bar. While it builds: a dashed
  // ghost with a progress ring; once destroyed: a flattened wreck with the rebuild countdown. New units of that side deploy beside it.
  function drawPost(t) {
    const c = TEAM_COL(t.side), x = t.x, y = t.y, fl = t.side === 0 ? 1 : -1;
    ctx.save(); ctx.translate(x, y);
    if (t.building || (!t.alive && t.glow > 0 && !(t.rebuild > 0))) {
      // Construction VFX: ghost shell outline, team fill rising inside the oval, scaffold struts, a mast that grows, a few sparks, progress ring. Cheap: no gradients, <= 3 sparks (1 on phones, no glow).
      const pr = Math.max(0, Math.min(1, t.build || 0)), lite = typeof innerWidth !== 'undefined' && Math.min(innerWidth, innerHeight) < 500;
      ctx.globalAlpha = .4; ctx.strokeStyle = c; ctx.lineWidth = 1.4; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.ellipse(0, 2, 16, 11, 0, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      if (pr > 0) {
        ctx.save(); ctx.beginPath(); ctx.ellipse(0, 2, 16, 11, 0, 0, Math.PI * 2); ctx.clip();
        ctx.globalAlpha = .55; ctx.fillStyle = t.side === 0 ? '#2f5a3c' : '#5e302d'; ctx.fillRect(-16, 13 - 22 * pr, 32, 22 * pr);
        ctx.globalAlpha = .9; ctx.fillStyle = c; ctx.fillRect(-16, 13 - 22 * pr - 1, 32, 1.5); ctx.restore();
        ctx.globalAlpha = .6; ctx.strokeStyle = '#c9c4b3'; ctx.lineWidth = 1; ctx.beginPath();
        ctx.moveTo(-13, 10); ctx.lineTo(-13, -10); ctx.moveTo(13, 10); ctx.lineTo(13, -10); ctx.moveTo(-13, -10); ctx.lineTo(13, -10);
        ctx.moveTo(-13, 10); ctx.lineTo(13, -10); ctx.stroke();
        ctx.globalAlpha = .9; ctx.strokeStyle = c; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(0, -9 - 17 * pr); ctx.stroke();
        const n = lite ? 1 : 3;
        for (let i = 0; i < n; i++) {
          const ph = (elapsed * 2.3 + i / n + t.side * .37) % 1, ang = (i * 2.1 + Math.floor(elapsed * 2.3 + i / n) * 1.7) % (Math.PI * 2);
          const sx = Math.cos(ang) * 13 * (0.4 + ph), sy = 13 - 22 * pr - ph * 10 + Math.sin(ang) * 3;
          ctx.globalAlpha = 1 - ph; ctx.fillStyle = i % 2 ? '#fff4d0' : c; ctx.fillRect(sx - 1, sy - 1, 2, 2);
        }
      }
      ctx.globalAlpha = .95; ctx.strokeStyle = c; ctx.lineWidth = 3; ctx.shadowColor = c; ctx.shadowBlur = lite ? 0 : 10;
      if (t.glow > 0) {   // unlock moment (Range postMoment/postFxDraw): ring burst + 'OB/FOB UNLOCKED' tag over the post
        const g = t.glow, k = 1 - g; ctx.save(); ctx.shadowBlur = 0; ctx.strokeStyle = c; ctx.lineWidth = 2;
        for (let i = 0; i < 3; i++) { const r = 24 + (k * 66 + i * 14) % 66; ctx.globalAlpha = Math.max(0, g * (1 - r / 90)); ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke(); }
        ctx.globalAlpha = Math.min(1, g * 1.6); ctx.fillStyle = c; ctx.font = "700 10px 'IBM Plex Mono', monospace"; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText((t.slot === 'B' ? 'FOB' : 'OB') + ' UNLOCKED', 0, -30); ctx.restore();
      }
      if (t.glow > 0) { ctx.shadowBlur = lite ? 0 : 10 + 22 * t.glow; ctx.lineWidth = 3 + 3 * t.glow; }   // just unlocked: the build ring flares
      ctx.beginPath(); ctx.arc(0, 0, 21, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pr); ctx.stroke();
      ctx.shadowBlur = 0; ctx.globalAlpha = .25; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, 21, 0, Math.PI * 2); ctx.stroke();
      if (pr > 0) { ctx.globalAlpha = .9; ctx.fillStyle = c; ctx.font = "700 9px 'IBM Plex Mono', monospace"; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText((t.slot === 'B' ? 'FOB ' : 'OB ') + Math.floor(pr * 100) + '%', 0, 24); ctx.textBaseline = 'alphabetic'; }
      ctx.restore(); return;
    }
    if (!t.alive) {
      ctx.globalAlpha = .5; ctx.fillStyle = '#1d1f1b'; ctx.strokeStyle = '#3c3a33'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-15, 9); ctx.lineTo(-4, 2); ctx.lineTo(6, 6); ctx.lineTo(15, 10); ctx.lineTo(15, 12); ctx.lineTo(-15, 12); ctx.closePath(); ctx.fill(); ctx.stroke();
      if (t.rebuild > 0) { ctx.globalAlpha = .85; ctx.fillStyle = '#c9c4b3'; ctx.font = "700 10px 'IBM Plex Mono', monospace"; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t.rebuild + 's', 0, -8); }
      ctx.restore(); return;
    }
    // Same look as the side's base (base()): dark team fill, team stroke and glow, the solid cross emblem, in an oval; flag on a mast.
    ctx.shadowColor = c; ctx.shadowBlur = t.hitFlash ? 20 : 14;
    ctx.fillStyle = t.side === 0 ? '#213428' : '#3b2221'; ctx.strokeStyle = t.hitFlash > 0 ? '#fff4d0' : c; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(0, 2, 16, 11, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0;
    ctx.fillStyle = c; ctx.fillRect(-1.5, -5, 3, 14); ctx.fillRect(-7, 0.5, 14, 3);
    ctx.strokeStyle = c; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(0, -26); ctx.stroke();
    const wave = Math.sin(elapsed * 5 + t.side) * 1.5;
    ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(0, -26); ctx.lineTo(fl * 11, -23 + wave); ctx.lineTo(0, -19); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#1a211c'; ctx.fillRect(-15, 16, 30, 3); ctx.fillStyle = t.hp / t.max <= .3 ? '#ff6158' : c; ctx.fillRect(-15, 16, 30 * Math.max(0, t.hp / t.max), 3);
    // Safe spawn (docs/SAFE-SPAWN.md): enemy ground near or a recent hit = new units skip this post; a faint amber dashed ring says so.
    if (t.unsafe) { ctx.save(); ctx.globalAlpha = .55 + .25 * Math.sin(elapsed * 6); ctx.strokeStyle = '#ffb347'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.ellipse(0, 2, 21, 15, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); }
    // Name under the post (A = OB operating base, B = FOB forward operating base), side color, small but legible on phones.
    ctx.fillStyle = c; ctx.font = "700 9px 'IBM Plex Mono', monospace"; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(t.slot === 'B' ? 'FOB' : 'OB', 0, 21); ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }
  function drawTower(t) { if (t.kind === 'gun') drawGun(t); else if (t.kind === 'depot') drawDepot(t); else if (t.kind === 'post') drawPost(t); }
  // Base shield dome, up while that side's depot stands. Breaks with a ring that fades over ~0.7 s.
  function drawShields() {
    if (!towersOn) return;
    for (const s of [0, 1]) {
      const d = towers.find(t => t.kind === 'depot' && t.side === s), x = s === 0 ? 13 : W - 13, y = H / 2;
      if (shield[s]) {
        const pulse = .5 + .5 * Math.sin(elapsed * 3 + s);
        ctx.save(); ctx.globalAlpha = .13 + .05 * pulse; ctx.fillStyle = '#7fd8ff'; ctx.shadowColor = '#7fd8ff'; ctx.shadowBlur = 14;
        ctx.beginPath(); ctx.ellipse(x, y, 38, 54, 0, s === 0 ? -Math.PI / 2 : Math.PI / 2, s === 0 ? Math.PI / 2 : Math.PI * 1.5); ctx.fill();
        ctx.globalAlpha = .5; ctx.strokeStyle = '#bfeaff'; ctx.lineWidth = 1.4; ctx.setLineDash([6, 5]); ctx.lineDashOffset = -elapsed * 12; ctx.stroke(); ctx.restore();
      } else if (d && d.downAt != null && elapsed - d.downAt < .7) {
        const q = (elapsed - d.downAt) / .7;
        ctx.save(); ctx.globalAlpha = 1 - q; ctx.strokeStyle = '#bfeaff'; ctx.lineWidth = 3 * (1 - q) + 1; ctx.shadowColor = '#7fd8ff'; ctx.shadowBlur = 16;
        ctx.beginPath(); ctx.ellipse(x, y, 38 + q * 26, 54 + q * 26, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      }
    }
  }
  // Team HP events (f.hpEvents, newest ~2 s): "-8 TOWER" over the structure, "-3 ZONE z3" over the lost zone (which flashes),
  // "-1 SIEGE" and "+1 HP" over the base. Each event is painted from its age, so there is no client state.
  function drawHpEvents() {
    if (!towersOn || !hpEvents.length) return;
    const lane = [0, 0];
    for (const e of hpEvents) {
      const age = elapsed - e.at; if (age < 0 || age > 1.6) continue;
      const s = e.side, a = Math.max(0, 1 - age / 1.6), gain = e.why === 'regen';
      let x = s === 0 ? 40 : W - 40, y = H / 2 - 40, txt;
      if (e.why === 'tower') {
        const st = e.kind === 'hospital' ? (hospitals || []).find(h => h.side === s) : e.kind === 'turret' ? (turrets || []).find(t => t.side === s) : towers.find(t => t.kind === e.kind && t.side === s);
        if (st) { x = st.x; y = st.y - 30; }
        txt = `-${Math.round(e.amount)} ${e.kind === 'gun' ? 'GUN' : e.kind === 'depot' ? 'DEPOT' : e.kind === 'post' ? 'POST' : e.kind === 'hospital' ? 'HOSP' : e.kind === 'turret' ? 'TURRET' : 'TOWER'}`;
      } else if (e.why === 'zone') {
        const zx = W * ((e.zone || 1) - .5) / 8; x = zx; y = 30;
        ctx.save(); ctx.globalAlpha = a * .22; ctx.fillStyle = TEAM_COL(s); ctx.fillRect(zx - W / 16 + 2, 3, W / 8 - 4, H - 6); ctx.restore();
        txt = `-${Math.round(e.amount)} ZONE z${e.zone}`;
      } else if (e.why === 'siege') txt = `-${Math.round(e.amount)} SIEGE`;
      else txt = `${gain ? '+' : '-'}${Math.round(e.amount)} HP`;
      const k = lane[s]++;
      ctx.save(); ctx.globalAlpha = a; ctx.textAlign = 'center'; ctx.font = "700 11px 'IBM Plex Mono', monospace";
      ctx.fillStyle = gain ? '#e5ffa8' : '#ffd0c8'; ctx.shadowColor = gain ? '#d6ff9b' : '#ff6158'; ctx.shadowBlur = 10;
      ctx.fillText(txt, x, y - age * 22 - k * 12); ctx.restore();
    }
  }
  // Last 60 s: the tie-break the match will use, TIME / HP / TOWERS, top centre.
  function drawTimeLine() {
    if (!towersOn || !(timeLimit > 0)) return;
    const left = timeLimit - elapsed; if (left > 60 || left < 0) return;
    const h0 = Math.ceil(Math.max(0, hp[0])), h1 = Math.ceil(Math.max(0, hp[1]));
    const m = Math.floor(left / 60), sec = Math.floor(left % 60);
    const txt = `TIME ${m}:${String(sec).padStart(2, '0')}  ·  HP ${h0}–${h1}  ·  TOWERS ${towerPts[0]}–${towerPts[1]}`;
    ctx.save(); ctx.font = "700 11px 'IBM Plex Mono', monospace"; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const w = ctx.measureText(txt).width + 18, x = W / 2, y = 14, urgent = left <= 10 && Math.floor(elapsed * 4) % 2 === 0;
    ctx.fillStyle = 'rgba(8,12,11,.78)'; ctx.strokeStyle = urgent ? '#ff6158' : 'rgba(216,224,208,.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(x - w / 2, y - 10, w, 20, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = h0 === h1 ? '#e8e4d0' : (h0 > h1 ? '#bafc82' : '#ff7768'); ctx.fillText(txt, x, y + .5); ctx.restore();
  }

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
    combatFx = (f.combatFx || []).filter(p => !(p.kind === 'mine-lay' && p.side === 1)).map(p => Object.assign({}, p, { x: p.x * sx, y: p.y * sy }));
    spawnFx = (f.spawnFx || []).map(p => Object.assign({}, p, { x: p.x * sx, y: p.y * sy }));
    spendPulses = (f.spendPulses || []).map(p => Object.assign({}, p, { x: p.x * sx, y: p.y * sy }));
    healPopups = (f.healPopups || []).map(p => Object.assign({}, p, { x: p.x * sx, y: p.y * sy }));
    capturePulses = f.capturePulses || [];
    // mines (docs/MINES.md): Green's always shown, Ember's only once spotted by a Green scout or drone
    mines = (f.mines || []).filter(m => m.side === 0 || m.spotted).map(m => Object.assign({}, m, { x: m.x * sx, y: m.y * sy }));
    turrets = (f.turrets || []).map(t => Object.assign({}, t, { x: t.x * sx, y: t.y * sy }));
    hospitals = (f.hospitals || []).map(h => Object.assign({}, h, { x: h.x * sx, y: h.y * sy }));
    towersOn = !!f.towersOn; timeLimit = f.timeLimit || 0;
    towers = (towersOn ? (f.towers || []) : []).map(t => Object.assign({}, t, { x: t.x * sx, y: t.y * sy }));
    shield = towersOn ? (f.shield || []) : []; hpEvents = towersOn ? (f.hpEvents || []) : []; towerPts = f.towerPts || [0, 0];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  // Side panel arsenal icon: drawUnit's own body (same shape and team colour, no HP bar, no glow) on a small canvas,
  // ringed by a solid dark outline (~1.5 CSS px) so it reads at panel size. One scale for every type, so a Breaker
  // reads bigger than a Scout, as on the field. Cached as a data URL. An unknown type draws as the generic circle.
  const iconCache = new Map();
  function icon(type, side, cssPx) {
    const px = Math.max(8, Math.round(cssPx || 16)), key = `${type}|${side}|${px}`;
    if (iconCache.has(key)) return iconCache.get(key);
    let url = '';
    if (typeof document !== 'undefined') {
      const dim = px * 2, ow = 3, body = document.createElement('canvas'), cv = document.createElement('canvas');
      body.width = body.height = cv.width = cv.height = dim;
      const keep = ctx;
      try {
        ctx = body.getContext('2d');
        Object.defineProperty(ctx, 'shadowBlur', { get: () => 0, set: () => {} });
        const maxR = Math.max(typeOf(type).r, ...Object.values(TYPES).map(t => t.r)), k = (dim / 2 - ow) / (maxR + 1);
        ctx.setTransform(k, 0, 0, k, dim / 2, dim / 2);
        const dir = side === 0 ? 1 : -1;
        drawUnit({ type, side, x: 0, y: 0, hp: 1, max: 1, age: 1, hitFlash: 0, dir, facingX: dir, facingY: 0, icon: true });
        // Outline: stamp the body's silhouette in black around a ring of offsets, then the body on top.
        const out = cv.getContext('2d'), sil = document.createElement('canvas');
        sil.width = sil.height = dim;
        const sc = sil.getContext('2d');
        sc.drawImage(body, 0, 0); sc.globalCompositeOperation = 'source-in'; sc.fillStyle = '#000'; sc.fillRect(0, 0, dim, dim);
        for (let i = 0; i < 16; i++) { const q = i * Math.PI / 8; out.drawImage(sil, Math.cos(q) * ow, Math.sin(q) * ow); }
        out.drawImage(body, 0, 0);
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
