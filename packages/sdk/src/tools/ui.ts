// MCP Apps views (extension io.modelcontextprotocol/ui, spec 2026-01-26): self-contained HTML, no external scripts,
// fonts or images, so they render in any compliant host's sandboxed iframe without CSP exceptions.
// Each view speaks the postMessage JSON-RPC bridge: ui/initialize → ui/notifications/initialized, then renders the
// tool result from ui/notifications/tool-result (structuredContent). All third-party text is set with textContent.
import type { UiResource } from "./types.js";

const MIME = "text/html;profile=mcp-app" as const;

const STYLE = `
:root{--bg:#120b10;--panel:#1b1118;--panel2:#22151e;--line:#34222e;--text:#f8ece8;--text2:#d6bfc7;--text3:#a48b96;--brand:#ff6fa5;--brand2:#ff9a6b;--buy:#3ddc97;--sell:#ff5a52;--warn:#f5c84c;color-scheme:dark}
:root[data-theme=light]{--bg:#fff7f9;--panel:#ffffff;--panel2:#fdf0f4;--line:#f1d9e2;--text:#2a1520;--text2:#5b3a49;--text3:#8a6676;--brand:#d63a76;--brand2:#e0703f;--buy:#118a55;--sell:#d2352d;--warn:#a87a00;color-scheme:light}
*{box-sizing:border-box}html,body{margin:0;background:transparent;color:var(--text);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 16px;max-width:560px}
.row{display:flex;align-items:center;gap:10px}.sp{flex:1}
.av{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,var(--brand),var(--brand2));display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:15px;flex:none}
.sym{font-weight:800;font-size:16px}.name{color:var(--text3);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px}
.price{font-weight:800;font-size:18px;text-align:right}.chg{font-size:12.5px;text-align:right}
.up{color:var(--buy)}.down{color:var(--sell)}.muted{color:var(--text3)}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}
.stat{background:var(--panel2);border-radius:10px;padding:8px 10px}.stat b{display:block;font-size:13.5px}.stat span{font-size:11px;color:var(--text3)}
.bar{height:6px;background:var(--panel2);border-radius:99px;margin-top:12px;overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--brand),var(--brand2))}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.chip{font-size:11.5px;border:1px solid var(--line);border-radius:99px;padding:2px 8px;color:var(--text2)}
.chip.warn{border-color:var(--warn);color:var(--warn)}
.foot{margin-top:10px;font-size:11px;color:var(--text3);display:flex;gap:8px}
a,button.link{color:var(--brand);text-decoration:none;background:none;border:0;padding:0;font:inherit;cursor:pointer}
button.cta{margin-top:12px;width:100%;height:42px;border:0;border-radius:11px;background:var(--brand);color:#fff;font-weight:800;font-size:14.5px;cursor:pointer}
button.cta[disabled]{opacity:.45;cursor:default}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:12px 0 0}dt{color:var(--text3);font-size:12.5px}dd{margin:0;font-weight:600;text-align:right}
.badge{font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;border-radius:6px;padding:2px 7px;background:var(--panel2);color:var(--text2)}
.badge.pending{color:var(--warn)}.badge.confirmed,.badge.signed{color:var(--buy)}.badge.failed,.badge.expired{color:var(--sell)}
svg{display:block;width:100%;height:auto}
`;

/** The postMessage bridge shared by every view. Exposes window.claudia = { call, openLink, onResult }. */
const BRIDGE = `
(function(){
  var seq=0,pending={},handlers=[];
  function send(m){try{window.parent.postMessage(m,"*")}catch(e){}}
  function request(method,params){var id=++seq;send({jsonrpc:"2.0",id:id,method:method,params:params||{}});
    return new Promise(function(res,rej){pending[id]={res:res,rej:rej};setTimeout(function(){if(pending[id]){delete pending[id];rej(new Error("timeout"))}},20000)})}
  function theme(ctx){if(ctx&&ctx.theme)document.documentElement.setAttribute("data-theme",ctx.theme==="light"?"light":"dark")}
  window.addEventListener("message",function(e){
    if(e.source!==window.parent)return;var d=e.data;if(!d||d.jsonrpc!=="2.0")return;
    if(d.id!=null&&!d.method&&pending[d.id]){var p=pending[d.id];delete pending[d.id];d.error?p.rej(new Error(d.error.message||"error")):p.res(d.result);return}
    if(d.method==="ui/notifications/tool-result"){handlers.forEach(function(h){try{h(d.params||{})}catch(err){}});return}
    if(d.method==="ui/notifications/host-context-changed"){theme(d.params);return}
    if(d.id!=null&&d.method){send({jsonrpc:"2.0",id:d.id,result:{}})}
  });
  window.claudia={
    call:function(name,args){return request("tools/call",{name:name,arguments:args||{}})},
    openLink:function(url){return request("ui/open-link",{url:url}).catch(function(){window.open(url,"_blank","noopener")})},
    onResult:function(h){handlers.push(h);if(window.__CLAUDIA_RESULT__)h(window.__CLAUDIA_RESULT__)}
  };
  request("ui/initialize",{protocolVersion:"2026-01-26",capabilities:{},clientInfo:{name:"claudia-view",version:"0.3.0"}})
    .then(function(r){theme(r&&r.hostContext);send({jsonrpc:"2.0",method:"ui/notifications/initialized",params:{}})}).catch(function(){});
  if(window.ResizeObserver){new ResizeObserver(function(){var b=document.body;send({jsonrpc:"2.0",method:"ui/notifications/size-changed",params:{width:Math.ceil(b.scrollWidth),height:Math.ceil(b.scrollHeight)}})}).observe(document.body)}
})();
function h(tag,attrs){var el=document.createElement(tag);if(attrs)for(var k in attrs){if(k==="text")el.textContent=attrs[k];else if(k==="cls")el.className=attrs[k];else el.setAttribute(k,attrs[k])}
  for(var i=2;i<arguments.length;i++){var c=arguments[i];if(c==null||c===false)continue;el.appendChild(typeof c==="string"?document.createTextNode(c):c)}return el}
function usd(n){if(typeof n!=="number"||!isFinite(n))return "–";var a=Math.abs(n);if(a>=1e9)return "$"+(n/1e9).toFixed(2)+"B";if(a>=1e6)return "$"+(n/1e6).toFixed(2)+"M";if(a>=1e3)return "$"+(n/1e3).toFixed(1)+"K";if(a>=1)return "$"+n.toFixed(2);if(a===0)return "$0";return "$"+n.toPrecision(3)}
function pct(n,d){return typeof n==="number"&&isFinite(n)?n.toFixed(d==null?1:d)+"%":"–"}
function ago(s){if(typeof s!=="number")return "";if(s<60)return Math.round(s)+"s ago";if(s<3600)return Math.round(s/60)+"m ago";return Math.round(s/3600)+"h ago"}
function plain(s){return String(s==null?"":s).replace(/[\\u0000-\\u001f\\u200b-\\u200f\\u202a-\\u202e]/g,"").slice(0,80)}
`;

const page = (title: string, body: string, script: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${STYLE}</style></head><body>${body}<script>${BRIDGE}${script}</script></body></html>`;

const COIN_CARD = page(
  "Claudia coin",
  `<div class="card" id="root"><div class="muted">Loading coin…</div></div>`,
  `
claudia.onResult(function(r){
  var s=r.structuredContent||{},c=s.coin||{},st=s.stats||{},root=document.getElementById("root");root.textContent="";
  var sym=plain(c.symbol||"?"),chg=c.change1hPct;
  root.appendChild(h("div",{cls:"row"},h("div",{cls:"av",text:sym.replace(/^\\$/,"").slice(0,2).toUpperCase()}),
    h("div",{cls:"sp"},h("div",{cls:"sym",text:"$"+sym.replace(/^\\$/,"")}),h("div",{cls:"name",text:plain(c.name)})),
    h("div",null,h("div",{cls:"price",text:usd(c.priceUsd)}),h("div",{cls:"chg "+(chg>=0?"up":"down"),text:(chg>=0?"+":"")+pct(chg)+" 1h"}))));
  var stats=[["Market cap",usd(c.mcapUsd)],["Liquidity",usd(c.liquidityUsd)],["Volume 1h",usd(c.volume1hUsd)],["Holders",c.holders!=null?String(c.holders):"–"],["Top 10",pct(c.top10Pct)],["Dev holds",pct(c.devHoldPct)]];
  var g=h("div",{cls:"grid"});stats.forEach(function(x){g.appendChild(h("div",{cls:"stat"},h("b",{text:x[1]}),h("span",{text:x[0]})))});root.appendChild(g);
  if(c.phase!=="migrated"&&typeof c.bondingPct==="number"){var bar=h("div",{cls:"bar"},h("i",{style:"width:"+Math.max(0,Math.min(100,c.bondingPct))+"%"}));root.appendChild(bar);
    root.appendChild(h("div",{cls:"foot"},h("span",{text:"Bonding curve "+pct(c.bondingPct,0)})))}
  var chips=h("div",{cls:"chips"}),mix=[["Snipers",st.snipersPct],["Bundlers",st.bundlersPct],["Insiders",st.insidersPct],["Fresh",st.freshPct]];
  mix.forEach(function(m){if(typeof m[1]==="number")chips.appendChild(h("span",{cls:"chip",text:m[0]+" "+pct(m[1]*100)}))});
  ((s.security&&s.security.warnings)||[]).slice(0,4).forEach(function(w){chips.appendChild(h("span",{cls:"chip warn",text:plain(w)}))});
  if(chips.childNodes.length)root.appendChild(chips);
  var foot=h("div",{cls:"foot"});if(c.url){var a=h("button",{cls:"link",text:"Open on Claudia"});a.onclick=function(){claudia.openLink(c.url)};foot.appendChild(a)}
  if(typeof s.dataAgeSec==="number")foot.appendChild(h("span",{text:"Data "+ago(s.dataAgeSec)}));foot.appendChild(h("span",{text:"Not financial advice"}));root.appendChild(foot);
});`,
);

const CHART = page(
  "Claudia chart",
  `<div class="card" id="root"><div class="muted">Loading chart…</div></div>`,
  `
claudia.onResult(function(r){
  var s=r.structuredContent||{},cs=(s.candles||[]).filter(function(x){return x&&isFinite(x.c)}),root=document.getElementById("root");root.textContent="";
  var sym=plain((s.coin&&s.coin.symbol)||"");
  if(!cs.length){root.appendChild(h("div",{cls:"muted",text:"No candles yet for this coin."}));return}
  var first=cs[0].o||cs[0].c,last=cs[cs.length-1].c,ch=first?((last-first)/first*100):0;
  root.appendChild(h("div",{cls:"row"},h("div",{cls:"sp"},h("div",{cls:"sym",text:(sym?"$"+sym.replace(/^\\$/,"")+" · ":"")+(s.resolution||"")}),h("div",{cls:"name",text:cs.length+" candles"})),
    h("div",null,h("div",{cls:"price",text:usd(last)}),h("div",{cls:"chg "+(ch>=0?"up":"down"),text:(ch>=0?"+":"")+pct(ch)}))));
  var W=540,H=220,P=6,lo=Infinity,hi=-Infinity;cs.forEach(function(x){lo=Math.min(lo,x.l||x.c);hi=Math.max(hi,x.h||x.c)});if(hi===lo){hi+=1e-12;lo-=1e-12}
  var y=function(v){return P+(H-2*P)*(1-(v-lo)/(hi-lo))},bw=(W-2*P)/cs.length,ns="http://www.w3.org/2000/svg";
  var svg=document.createElementNS(ns,"svg");svg.setAttribute("viewBox","0 0 "+W+" "+H);svg.setAttribute("role","img");svg.setAttribute("aria-label","Price chart");
  cs.forEach(function(x,i){var up=x.c>=x.o,col=up?"var(--buy)":"var(--sell)",cx=P+i*bw+bw/2;
    var wick=document.createElementNS(ns,"line");wick.setAttribute("x1",cx);wick.setAttribute("x2",cx);wick.setAttribute("y1",y(x.h||x.c));wick.setAttribute("y2",y(x.l||x.c));wick.setAttribute("stroke",col);svg.appendChild(wick);
    var b=document.createElementNS(ns,"rect"),t=y(Math.max(x.o,x.c)),bt=y(Math.min(x.o,x.c));b.setAttribute("x",cx-Math.max(1,bw*0.35));b.setAttribute("width",Math.max(1,bw*0.7));b.setAttribute("y",t);b.setAttribute("height",Math.max(1,bt-t));b.setAttribute("fill",col);svg.appendChild(b)});
  root.appendChild(svg);
  var foot=h("div",{cls:"foot"},h("span",{text:"High "+usd(hi)}),h("span",{text:"Low "+usd(lo)}));if(typeof s.dataAgeSec==="number")foot.appendChild(h("span",{text:"Data "+ago(s.dataAgeSec)}));root.appendChild(foot);
});`,
);

const CONFIRM = page(
  "Claudia confirm",
  `<div class="card" id="root"><div class="muted">Preparing…</div></div>`,
  `
var cur=null,timer=null;
function render(){var s=cur||{},sum=s.summary||{},root=document.getElementById("root");root.textContent="";
  var title=sum.kind==="launch"?"Launch $"+plain(sum.symbol||""):(sum.side==="sell"?"Sell ":"Buy ")+(sum.symbol?"$"+plain(sum.symbol):"coin");
  root.appendChild(h("div",{cls:"row"},h("div",{cls:"sym sp",text:title}),h("span",{cls:"badge "+(s.status||""),text:s.status||""})));
  var dl=h("dl");(sum.lines||[]).forEach(function(l){dl.appendChild(h("dt",{text:plain(l[0])}));dl.appendChild(h("dd",{text:plain(l[1])}))});root.appendChild(dl);
  var left=s.expiresAt?Math.max(0,Math.round((Date.parse(s.expiresAt)-Date.now())/1000)):0,open=s.status==="pending"&&left>0;
  var btn=h("button",{cls:"cta",text:open?"Review and sign on Claudia":(s.status==="pending"?"Expired — ask for a new one":"Done")});if(!open)btn.setAttribute("disabled","");
  btn.onclick=function(){if(s.confirmUrl)claudia.openLink(s.confirmUrl)};root.appendChild(btn);
  var foot=h("div",{cls:"foot"});if(open)foot.appendChild(h("span",{text:"Link expires in "+left+"s"}));
  var ref=h("button",{cls:"link",text:"Refresh status"});ref.onclick=function(){claudia.call("get_trade_status",{id:s.id}).then(function(r){if(r&&r.structuredContent){cur=r.structuredContent;render()}})};
  if(s.id)foot.appendChild(ref);foot.appendChild(h("span",{text:"You sign with your own wallet. Nothing moves before that."}));root.appendChild(foot);
}
claudia.onResult(function(r){cur=r.structuredContent||{};render();clearInterval(timer);timer=setInterval(render,1000)});`,
);

export const UI_RESOURCES: UiResource[] = [
  { uri: "ui://claudia/coin-card", name: "coin-card", title: "Coin card", description: "A coin's price, market cap, holders and wallet mix.", mimeType: MIME, html: COIN_CARD, servers: ["data", "local"] },
  { uri: "ui://claudia/chart", name: "chart", title: "Price chart", description: "Candlestick chart for a coin.", mimeType: MIME, html: CHART, servers: ["data", "local"] },
  { uri: "ui://claudia/confirm-trade", name: "confirm-trade", title: "Confirm a trade", description: "Summary of a prepared trade or launch with a button to sign it on useclaudia.xyz.", mimeType: MIME, html: CONFIRM, servers: ["trade", "local"] },
];

/** _meta for an MCP Apps resource (no external domains needed). */
export const UI_RESOURCE_META = { ui: { prefersBorder: false, csp: { connectDomains: [] as string[], resourceDomains: [] as string[] } } };

/** _meta that links a tool to its view: the 2026-01-26 key plus the older flat key some hosts still read. */
export function toolUiMeta(uri: string): Record<string, unknown> {
  return { ui: { resourceUri: uri }, "ui/resourceUri": uri };
}
