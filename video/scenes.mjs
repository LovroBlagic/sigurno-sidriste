// HTML za naslovne kartice, MCP chat scenu i preklop s titlovima/kursorom (1280x720).

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500&display=swap" rel="stylesheet">`;

const ANCHOR = `<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="6" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 9v19M10 14h12M5 19c1 6 6 9 11 9s10-3 11-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

const BASE = `
  :root { --navy:#0f2233; --navy2:#16324a; --paper:#f4efe4; --soft:#a9b8c6; --accent:#e0694f; --grass:#3fbf7f; --sand:#f2c14e; }
  * { box-sizing:border-box; margin:0; }
  html,body { width:1280px; height:720px; overflow:hidden; }
  body { background: radial-gradient(1200px 700px at 70% 30%, var(--navy2), var(--navy)); color:var(--paper); font-family:"IBM Plex Sans",sans-serif; }
  .wrap { position:absolute; inset:0; display:flex; flex-direction:column; justify-content:center; padding:0 120px 90px; }
  h1,h2 { font-family:"Fraunces",serif; font-weight:700; letter-spacing:.005em; }
  .in { opacity:0; transform:translateY(18px); animation:in .7s cubic-bezier(.2,.7,.2,1) forwards; }
  @keyframes in { to { opacity:1; transform:none; } }
  .waves { position:absolute; left:0; right:0; bottom:0; height:200px; opacity:.16; }
`;

export const CAPTION_CSS = `
  #cap { position:fixed; left:50%; bottom:28px; transform:translateX(-50%); z-index:99999; max-width:980px; width:max-content;
    background:rgba(10,22,34,.86); color:#fff; font:500 22px/1.38 "IBM Plex Sans",sans-serif; text-align:center;
    padding:12px 22px; border-radius:14px; box-shadow:0 8px 28px rgba(0,0,0,.35); transition:opacity .25s; pointer-events:none; }
  #cap:empty { opacity:0; }
  #cur { position:fixed; z-index:99998; width:26px; height:26px; margin:-4px 0 0 -4px; pointer-events:none; transition:transform .08s;
    background:no-repeat center/contain url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M4 2l15 11-6.5 1.2L16 21l-3 1.5-3.6-6.9L4 20z' fill='%23fff' stroke='%23000' stroke-width='1.4' stroke-linejoin='round'/%3E%3C/svg%3E"); }
  .ripple { position:fixed; z-index:99997; width:44px; height:44px; margin:-22px 0 0 -22px; border-radius:50%; border:3px solid #e0694f;
    pointer-events:none; animation:rip .55s ease-out forwards; }
  @keyframes rip { from { transform:scale(.3); opacity:1; } to { transform:scale(1.4); opacity:0; } }
`;

// Ubacuje se u stranicu aplikacije prije učitavanja: titlovi + vidljivi kursor + krug na klik
export const OVERLAY_INIT = `
  addEventListener('DOMContentLoaded', () => {
    const st = document.createElement('style'); st.textContent = ${JSON.stringify(CAPTION_CSS)}; document.head.append(st);
    const cap = Object.assign(document.createElement('div'), { id: 'cap' });
    const cur = Object.assign(document.createElement('div'), { id: 'cur' });
    cur.style.left = '1300px'; document.body.append(cap, cur);
    addEventListener('mousemove', (e) => { cur.style.left = e.clientX + 'px'; cur.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', (e) => {
      cur.style.transform = 'scale(.85)';
      const r = Object.assign(document.createElement('div'), { className: 'ripple' });
      r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'; document.body.append(r); setTimeout(() => r.remove(), 600);
    }, true);
    addEventListener('mouseup', () => { cur.style.transform = ''; }, true);
    window.__caption = (t) => { cap.textContent = t || ''; };
  });
`;

const WAVES = `<svg class="waves" viewBox="0 0 1280 200" preserveAspectRatio="none"><path d="M0 120 Q160 80 320 120 T640 120 T960 120 T1280 120 V200 H0Z" fill="#7fb3d5"/><path d="M0 150 Q160 115 320 150 T640 150 T960 150 T1280 150 V200 H0Z" fill="#7fb3d5" opacity=".6"/></svg>`;

const page = (css, html, caption) => `<!doctype html><html lang="hr"><head><meta charset="utf-8">${FONTS}
<style>${BASE}${CAPTION_CSS}${css}</style></head><body style="display:none">${WAVES}${html}<div id="cap">${caption}</div></body></html>`;

export function cardProblem(caption) {
  return page(`
    .eyebrow { color:var(--accent); font:600 16px "IBM Plex Sans"; letter-spacing:.16em; text-transform:uppercase; margin-bottom:22px; }
    .stat { font:700 148px/1 "Fraunces",serif; color:#fff; }
    .stat span { color:var(--grass); }
    .lbl { font:500 34px/1.3 "IBM Plex Sans"; color:var(--paper); max-width:900px; margin-top:18px; }
    .sub { margin-top:26px; color:var(--soft); font-size:20px; display:flex; gap:12px; align-items:center; }
    .sub i { width:12px; height:12px; border-radius:50%; background:var(--grass); display:inline-block; }
    .src { position:absolute; right:40px; top:34px; color:var(--soft); font-size:13px; opacity:.7; }`,
    `<div class="wrap">
      <div class="eyebrow in">Hrvatski Jadran</div>
      <div class="stat in" style="animation-delay:.25s">25–65<span> %</span></div>
      <div class="lbl in" style="animation-delay:.6s">brodova u praćenim uvalama sidri ravno na livadi posidonije</div>
      <div class="sub in" style="animation-delay:1.6s"><i></i>Posidonia oceanica raste oko 1 cm godišnje</div>
    </div><div class="src">Satelitsko praćenje sidrenja, Croatia Week</div>`, caption);
}

export function cardIdea(caption) {
  const chips = [["Dno", "pijesak · mulj · stijene", "#f2c14e"], ["Morska trava", "posidonija", "#3fbf7f"], ["Dubina", "uživo, EMODnet", "#7fb3d5"],
    ["Zaklon", "8 smjerova", "#c9b8ff"], ["Vjetar", "idućih 12 h", "#e0694f"]];
  return page(`
    .brand { display:flex; align-items:center; gap:18px; }
    .brand svg { width:64px; height:64px; color:var(--accent); }
    .brand h1 { font-size:76px; }
    .tag { font-size:28px; color:var(--soft); margin:14px 0 46px; }
    .chips { display:flex; gap:16px; flex-wrap:wrap; }
    .chip { background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.14); border-radius:16px; padding:16px 20px; min-width:186px; }
    .chip b { display:flex; align-items:center; gap:10px; font:600 22px "IBM Plex Sans"; }
    .chip b i { width:14px; height:14px; border-radius:4px; display:inline-block; }
    .chip small { display:block; color:var(--soft); font-size:15px; margin-top:4px; }
    .eq { font:700 30px "Fraunces"; margin-top:40px; color:#fff; }
    .eq span { color:var(--grass); }`,
    `<div class="wrap">
      <div class="brand in">${ANCHOR}<h1>Sigurno sidrište</h1></div>
      <div class="tag in" style="animation-delay:.3s">Gdje sidriti na hrvatskom Jadranu, u jednom koraku</div>
      <div class="chips">${chips.map(([a, b, c], i) => `<div class="chip in" style="animation-delay:${0.9 + i * 0.55}s"><b><i style="background:${c}"></i>${a}</b><small>${b}</small></div>`).join("")}</div>
      <div class="eq in" style="animation-delay:4.2s">→ <span>jedan jasan odgovor</span></div>
    </div>`, caption);
}

export function chatScene(caption, question, answerHtml) {
  return page(`
    .chat { position:absolute; left:50%; top:46px; transform:translateX(-50%); width:880px; background:#f7f4ee; color:#16222e;
      border-radius:20px; box-shadow:0 30px 80px rgba(0,0,0,.45); overflow:hidden; }
    .bar { display:flex; align-items:center; gap:10px; padding:14px 20px; background:#ece6da; border-bottom:1px solid #ddd4c4; font:600 15px "IBM Plex Sans"; color:#4a5b6b; }
    .bar i { width:12px; height:12px; border-radius:50%; background:#d4cbbb; display:inline-block; }
    .bar span { margin-left:10px; }
    .body { padding:22px 26px 26px; display:grid; gap:14px; min-height:520px; align-content:start; }
    .me { justify-self:end; background:#16324a; color:#fff; padding:12px 18px; border-radius:18px 18px 4px 18px; font-size:19px; max-width:80%; }
    .tool { justify-self:start; display:inline-flex; align-items:center; gap:10px; font:500 14px "IBM Plex Mono"; color:#1d4e6e;
      background:#e3edf3; border:1px solid #c5d9e6; border-radius:999px; padding:7px 14px; opacity:0; }
    .tool svg { width:18px; height:18px; color:#e0694f; }
    .ai { font-size:17px; line-height:1.5; opacity:0; }
    .ai ol { margin:8px 0 0 0; padding-left:22px; display:grid; gap:6px; }
    .ai b { font-weight:600; }
    .ai .m { color:#4a5b6b; font-size:15px; }
    .ai .warn { margin-top:10px; color:#2f7d5b; font-size:15px; }
    .caret::after { content:"▍"; animation:blink 1s steps(1) infinite; color:#16324a; }
    @keyframes blink { 50% { opacity:0; } }
    .show { animation:in .5s ease forwards; }`,
    `<div class="chat">
      <div class="bar"><i></i><i></i><i></i><span>AI asistent · povezan MCP server: sigurno-sidriste</span></div>
      <div class="body">
        <div class="me"><span id="q" class="caret"></span></div>
        <div class="tool" id="tool">${ANCHOR}pronadi_sidriste · mjesto: "Pakleni otoci"</div>
        <div class="ai" id="ai">${answerHtml}</div>
      </div>
    </div>
    <script>
      window.start = () => { const q = ${JSON.stringify(question)}; const el = document.getElementById('q'); let i = 0;
      const t = setInterval(() => { el.textContent = q.slice(0, ++i); if (i >= q.length) { clearInterval(t); el.classList.remove('caret');
        setTimeout(() => document.getElementById('tool').classList.add('show'), 350);
        setTimeout(() => document.getElementById('ai').classList.add('show'), 1500); } }, 42); };
    </script>`, caption);
}

export function cardOutro(caption) {
  return page(`
    .wrap { align-items:center; text-align:center; padding-bottom:110px; }
    .brand svg { width:84px; height:84px; color:var(--accent); }
    h1 { font-size:84px; margin-top:12px; }
    .tag { font:500 32px "Fraunces"; color:var(--grass); margin-top:14px; }
    .src { margin-top:40px; color:var(--soft); font-size:16px; letter-spacing:.02em; }`,
    `<div class="wrap">
      <div class="brand in">${ANCHOR}</div>
      <h1 class="in" style="animation-delay:.2s">Sigurno sidrište</h1>
      <div class="tag in" style="animation-delay:.8s">Čuvaj more. Spavaj mirno.</div>
      <div class="src in" style="animation-delay:1.3s">Otvoreni podaci: EMODnet · Open-Meteo · OpenStreetMap · Bioportal HAOP</div>
    </div>`, caption);
}
