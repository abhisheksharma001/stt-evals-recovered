// T-70 palette contrast check. Mirrors the HSL triplets in
// artifacts/stt-benchmark/src/index.css; edit both together. Run: node scripts/check-theme-contrast.mjs
const P = {
  background: [38,40,95], foreground: [26,30,13], border: [34,20,82],
  card: [40,45,98], cardBorder: [36,22,88],
  sidebar: [36,30,92], sidebarPrimary: [14,68,40], sidebarPrimaryFg: [40,45,98], sidebarAccent: [34,28,86],
  primary: [14,68,40], primaryFg: [40,45,98],
  secondary: [34,28,88], muted: [36,28,90], mutedFg: [28,14,36], accent: [34,28,88],
  destructive: [348,60,40], destructiveFg: [40,45,98],
  success: [152,45,28], successFg: [40,45,98],
  warning: [36,85,30], warningFg: [40,45,98],
  chart3: [214,45,40], chart4: [37,60,33], chart5: [322,40,42],
  eRo:[37,60,33], eUnit:[147,35,30], eVin:[214,45,40], ePhone:[322,40,40], eName:[11,55,40], eAddr:[178,40,28], eLoad:[76,45,28], eCity:[249,40,45],
};
const hslToRgb=([h,s,l])=>{s/=100;l/=100;const k=n=>(n+h/30)%12;const a=s*Math.min(l,1-l);const f=n=>l-a*Math.max(-1,Math.min(k(n)-3,Math.min(9-k(n),1)));return [f(0),f(8),f(4)];};
const lum=rgb=>{const [r,g,b]=rgb.map(c=>c<=0.03928?c/12.92:((c+0.055)/1.055)**2.4);return 0.2126*r+0.7152*g+0.0722*b;};
const cr=(a,b)=>{const l1=lum(hslToRgb(P[a])),l2=lum(hslToRgb(P[b]));return ((Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05)).toFixed(2);};
const hex=k=>'#'+hslToRgb(P[k]).map(c=>Math.round(c*255).toString(16).padStart(2,'0')).join('');
const pairs=[['foreground','background'],['foreground','card'],['foreground','sidebar'],['foreground','muted'],['foreground','secondary'],
['mutedFg','background'],['mutedFg','card'],['mutedFg','sidebar'],['mutedFg','muted'],['mutedFg','secondary'],['mutedFg','sidebarAccent'],
['primary','background'],['primary','card'],['primaryFg','primary'],['sidebarPrimaryFg','sidebarPrimary'],
['destructive','background'],['destructive','card'],['destructiveFg','destructive'],
['success','background'],['success','card'],['successFg','success'],
['warning','background'],['warning','card'],['warningFg','warning'],
['chart3','background'],['chart4','background'],['chart5','background'],
['eRo','background'],['eUnit','background'],['eVin','background'],['ePhone','background'],['eName','background'],['eAddr','background'],['eLoad','background'],['eCity','background'],
['border','background'],['cardBorder','card']];
let fail=0;for(const [a,b] of pairs){const r=cr(a,b);const min=(a==='border'||a==='cardBorder')?1.2:4.5;const ok=+r>=min;if(!ok)fail++;console.log((ok?'ok  ':'FAIL')+' '+r.padStart(6)+'  '+a+' on '+b);}
console.log('fails:',fail);
console.log('hex', Object.fromEntries(['background','foreground','border','card','primary','success','warning','destructive','mutedFg'].map(k=>[k,hex(k)])));
