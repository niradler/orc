/** Self-contained dataset dashboard, also used in the source-dev gallery. */
export const CHAT_DASHBOARD_HTML = `<!doctype html><html lang="en"><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;padding:20px;background:#fafafa;color:#25262a;font:14px system-ui}h1{font-size:20px;margin:0 0 8px}p{color:#62666e}button{min-height:44px;padding:0 12px;background:#25262a;color:white;border:0;border-radius:6px}svg{display:block;width:100%;max-height:240px}text{font:13px system-ui;fill:#62666e}</style>
</head><body><h1>Dataset dashboard</h1><p id="summary">Revenue by quarter · example dataset</p>
<button id="metric" type="button">Show orders</button>
<svg viewBox="0 0 400 240" role="img" aria-label="Quarterly revenue chart"></svg>
<script>const quarters=['Q1','Q2','Q3','Q4'];const revenue=[42,68,57,91];const orders=[31,48,73,62];let metric='revenue';
function draw(){const values=metric==='revenue'?revenue:orders;document.querySelector('svg').innerHTML=values.map((n,i)=>'<rect x="'+(25+i*95)+'" y="'+(200-n*1.8)+'" width="55" height="'+(n*1.8)+'" rx="3" fill="#506585"/><text x="'+(52+i*95)+'" y="225" text-anchor="middle">'+quarters[i]+'</text><text x="'+(52+i*95)+'" y="'+(190-n*1.8)+'" text-anchor="middle">'+n+'</text>').join('');document.querySelector('svg').setAttribute('aria-label','Quarterly '+metric+' chart')}
document.querySelector('button').onclick=()=>{metric=metric==='revenue'?'orders':'revenue';document.querySelector('button').textContent=metric==='revenue'?'Show orders':'Show revenue';draw()};draw();</script></body></html>`;
