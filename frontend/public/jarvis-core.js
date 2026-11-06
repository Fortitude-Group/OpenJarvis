// JARVIS core — the GPU layer behind the HUD rings (WebGL2).
//
//   * raymarched plasma core inside a holographic lattice globe
//   * ~80k particles positioned entirely in the vertex shader, one formation
//     per state (idle galaxy, listening sphere, thinking gyroscope, speaking
//     bursts) and blended between them as the state changes
//   * HDR bloom, state-change shockwave, chromatic fringe, hex-grid floor glow
//
// API (window.JarvisCore):
//   init(canvas, { getAnalyser, getLevel })  -> true if WebGL2 came up
//   setState('IDLE'|'LISTENING'|'THINKING'|'SPEAKING')
//   active                                   -> false means draw the 2D fallback
(function () {
  'use strict';

  const STATES = ['IDLE', 'LISTENING', 'THINKING', 'SPEAKING'];
  const PAL = [[0.22, 0.85, 1.0], [0.30, 1.0, 0.69], [1.0, 0.62, 0.18], [0.75, 0.94, 1.0]];
  const FOV = 35 * Math.PI / 180, TAN = Math.tan(FOV / 2);
  const NBINS = 64;
  const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let gl = null, cv = null, ok = false, opts = {};
  let P = {}, T = {}, vao = null, fftTex = null, nParticles = 80000;
  const w = [1, 0, 0, 0], tgt = [1, 0, 0, 0];
  let state = 'IDLE', shockAt = -99, time = 0, last = 0, boot = REDUCE ? 1 : 0;
  let yaw = 0, pitch = 0, tyaw = 0, tpitch = 0;
  const fftSm = new Float32Array(NBINS), fftU8 = new Uint8Array(NBINS);
  let raw = null;

  // ---------------------------------------------------------------- shaders
  const FS_TRI = `#version 300 es
out vec2 vUv;
void main(){
  vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));
  vUv=p; gl_Position=vec4(p*2.-1.,0.,1.);
}`;

  const PARTICLE_VS = `#version 300 es
precision highp float;
uniform mat4 uVP;
uniform float uT,uLevel,uBoot,uPx,uShock,uGain,uTrail,uMode;
uniform vec4 uW;
uniform vec3 uC0,uC1,uC2,uC3;
uniform sampler2D uFFT;
out vec3 vCol; out float vA;
uint pcg(uint v){uint s=v*747796405u+2891336453u;uint w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
float rnd(uint v){return float(pcg(v))/4294967295.;}
mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
vec3 rX(vec3 p,float a){p.yz=rot(a)*p.yz;return p;}
vec3 rY(vec3 p,float a){p.xz=rot(a)*p.xz;return p;}
vec3 rZ(vec3 p,float a){p.xy=rot(a)*p.xy;return p;}
float fft(float x){return texture(uFFT,vec2(clamp(x,0.,1.)*.96+.02,.5)).r;}
// loop speeds of the formations that recycle particles (also used by the wrap test)
const float VI=.045, VT=.4, VS=.55;

vec3 formation(float t,vec4 r,float r5,vec4 w,out float a){
  float th=r.x*6.2831853, ph=acos(clamp(2.*r.y-1.,-1.,1.));
  vec3 dir=vec3(sin(ph)*cos(th),cos(ph),sin(ph)*sin(th));

  // IDLE: accretion disc. Matter is born at the rim, streams inward along three
  // spiral arms, speeds up and brightens as it falls, then dissolves into the core.
  vec3 pI; float aI;
  if(r.w<.82){
    float arm=floor(r.w/.82*3.);
    float s=fract(r.z+t*VI*(.8+.4*r5));
    float rr=mix(3.4,.62,pow(s,1.6));    // slow at the rim, accelerating inwards
    float ang=arm*2.0944-2.7*log(rr)+(r5-.5)*(.18+.16*rr)-t*.06;
    pI=vec3(cos(ang)*rr,(r.y-.5)*.06*rr,sin(ang)*rr);
    pI+=.045*rr*vec3(sin(pI.z*2.3+t*1.4+r5*6.),.4*sin(pI.x*1.9-t*1.1),cos(pI.x*2.1+t*.9+r5*6.));
    pI=rZ(rX(pI,1.2),.3);
    aI=smoothstep(0.,.12,s)*(1.-smoothstep(.7,.97,s))*(.3+.7*s);
  } else {
    // electrons on their own tilted orbits, each at its own speed
    float rr=.6+.35*r.z, sp=(1.2+1.6*r5)*(r.x<.5?1.:-1.)/rr;
    pI=rZ(rX(vec3(cos(th+t*sp)*rr,0.,sin(th+t*sp)*rr),r.y*3.1416),r5*6.2832);
    aI=.55;
  }

  // LISTENING: sphere that rides the mic spectrum; particles drift across it
  vec3 dl=rY(dir,t*(.15+.5*r5)*(r.z<.5?1.:-1.));
  float fL=fft(abs(dl.y));
  vec3 pL=dl*(1.08+fL*.75+.03*sin(ph*14.-t*5.));
  float aL=.15+fL*.9;

  // THINKING: three counter-rotating gyroscope rings + streams into the core
  vec3 pT; float aT;
  if(r.w<.7){
    float k=floor(r.w/.7*3.);
    float sp=(1.6+k*.5)*(mod(k,2.)*2.-1.)*(.85+.3*r5);
    float an=th+t*sp, rr=1.16+k*.16+(r.z-.5)*.04;
    pT=vec3(cos(an)*rr,(r.y-.5)*.02,sin(an)*rr);
    pT=rX(pT,k*1.0472+.6+t*.3*(k-1.)); pT=rZ(pT,k*2.0944+t*.17);
    aT=.35;
  } else {
    float s=fract(r.z+t*VT), rr=3.0*(1.-s)+.5, an=th+s*9.;
    pT=rX(vec3(cos(an)*rr,(r.y-.5)*.6*(1.-s),sin(an)*rr),1.1);
    aT=.4*sin(s*3.14159);
  }

  // SPEAKING: shells bursting outwards, pushed by the voice spectrum
  float sh=fract(r.z+t*VS);
  float fS=fft(abs(th/3.14159265-1.));
  vec3 pS=rY(dir,t*.2)*(.95+sh*(1.1+uLevel*1.9)+fS*.4);
  float aS=(1.-sh)*(1.-sh)*(.12+uLevel*.4+fS*.4);

  a=aI*w.x+aL*w.y+aT*w.z+aS*w.w;
  return pI*w.x+pL*w.y+pT*w.z+pS*w.w;
}
// true if a recycling formation looped this particle between t0 and t1
// (its streak would otherwise be drawn right across the screen)
bool wrapped(float z,float r5,float t0,float t1,vec4 w){
  float vi=VI*(.8+.4*r5);
  return (w.x>.01&&floor(z+t0*vi)!=floor(z+t1*vi))
      || (w.z>.01&&floor(z+t0*VT)!=floor(z+t1*VT))
      || (w.w>.01&&floor(z+t0*VS)!=floor(z+t1*VS));
}
void main(){
  bool lines=uMode<.5;
  uint pid=uint(lines?(gl_VertexID>>1):gl_VertexID);
  float tail=lines?float(gl_VertexID&1):0.;
  uint u=pid*5u;
  vec4 r=vec4(rnd(u),rnd(u+1u),rnd(u+2u),rnd(u+3u)); float r5=rnd(u+4u);
  vec4 w=uW/max(dot(uW,vec4(1.)),1e-4);
  float a; vec3 p=formation(uT-tail*uTrail,r,r5,w,a);
  if(lines&&wrapped(r.z,r5,uT-uTrail,uT,w)) a=0.;

  // boot: particles fly in from far away and settle into formation
  float th=r.x*6.2831853, ph=acos(clamp(2.*r.y-1.,-1.,1.));
  vec3 dir=vec3(sin(ph)*cos(th),cos(ph),sin(ph)*sin(th));
  float d=r.z*.45, bb=smoothstep(d,d+.55,uBoot);
  p=mix(dir*(5.+r.x*5.),p,bb); a*=mix(.15,1.,bb);

  // shockwave on state change
  if(uShock>=0.){
    float R=uShock*3.2, dl=length(p)-R, k=exp(-dl*dl*4.)*max(0.,1.-uShock/1.4);
    p+=normalize(p+1e-4)*k*.22; a+=k*.8;
  }

  a*=.7+.3*sin(uT*2.3+r.w*40.);
  if(lines) a*=1.-tail;            // streak fades out towards its tail
  vec3 col=uC0*w.x+uC1*w.y+uC2*w.z+uC3*w.w;
  col=mix(col,vec3(1.),.3*r.z*r.z*r.z)*(.8+.4*r.y);
  vCol=col; vA=a*uGain;
  gl_Position=uVP*vec4(p,1.);
  float sz=(.006+.018*r5*r5)*(1.+uLevel*.4);
  gl_PointSize=lines?1.:clamp(uPx*sz/gl_Position.w,1.,24.);
}`;

  const PARTICLE_FS = `#version 300 es
precision highp float;
uniform float uMode;
in vec3 vCol; in float vA; out vec4 o;
void main(){
  if(uMode<.5){ o=vec4(vCol*vA,0.); return; }
  vec2 q=gl_PointCoord*2.-1.; float d=dot(q,q);
  if(d>1.) discard;
  o=vec4(vCol*exp(-d*4.)*vA,0.);
}`;

  const CORE_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform vec3 uCam,uRt,uUp,uFw;
uniform float uTan,uAsp,uT,uLevel,uBoot;
uniform vec4 uW;
uniform vec3 uC0,uC1,uC2,uC3;
float hash(vec3 p){p=fract(p*.3183099+.1);p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float noise(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.-2.*f);
  return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm(vec3 p){float a=.5,s=0.;for(int i=0;i<4;i++){s+=a*noise(p);p=p*2.03+vec3(1.7,9.2,3.1);a*=.5;}return s;}
float h11(float n){return fract(sin(n*127.1+311.7)*43758.5453);}
float n1(float x){float i=floor(x),f=fract(x);f=f*f*(3.-2.*f);return mix(h11(i),h11(i+1.),f);}
vec2 hitSphere(vec3 ro,vec3 rd,float R){float b=dot(ro,rd),c=dot(ro,ro)-R*R,h=b*b-c;
  if(h<0.) return vec2(-1.);h=sqrt(h);return vec2(-b-h,-b+h);}
// Fresnel term. The cosine is clamped to [0,1]: dead centre it can round to
// 1.0000001, and pow() of the resulting negative base is NaN, which the bloom
// then smeared into flickering blocks.
float fres(vec3 n,vec3 rd,float k){return pow(1.-clamp(dot(n,-rd),0.,1.),k);}
float lattice(vec3 p,float t){
  p.xz=mat2(cos(t),-sin(t),sin(t),cos(t))*p.xz; p=normalize(p);
  float lat=acos(clamp(p.y,-1.,1.))/3.14159*10., lon=(atan(p.z,p.x+1e-7)/6.28318+.5)*24.;
  vec2 g=abs(fract(vec2(lat,lon))-.5);
  return smoothstep(.43,.5,max(g.x,g.y));
}
void main(){
  vec2 q=vUv*2.-1.;
  vec3 ro=uCam, rd=normalize(uFw+q.x*uAsp*uTan*uRt+q.y*uTan*uUp);
  vec4 w=uW/max(dot(uW,vec4(1.)),1e-4);
  vec3 col=uC0*w.x+uC1*w.y+uC2*w.z+uC3*w.w;
  float boot=smoothstep(.15,.9,uBoot);
  float R=.46*(1.+uLevel*.18*(w.y+w.w)+.025*sin(uT*1.7))*boot+1e-3;
  float b=dot(ro,rd), dmin=sqrt(max(dot(ro,ro)-b*b,0.));
  vec3 acc=col*(.06+.16*uLevel)*exp(-max(dmin-R,0.)*4.5);   // soft halo

  // plasma: raymarched turbulent filaments
  vec2 hs=hitSphere(ro,rd,R);
  if(hs.x>0.){
    float dt=(hs.y-hs.x)/32., spd=.45+w.z*1.7+w.w*.8, T=uT*spd;
    for(int i=0;i<32;i++){
      vec3 p=ro+rd*(hs.x+dt*(float(i)+.5));
      float rl=min(length(p)/R,1.), ang=T*.6+rl*2.2;
      vec3 pp=vec3(cos(ang)*p.x-sin(ang)*p.z,p.y,sin(ang)*p.x+cos(ang)*p.z);
      float n=fbm(pp*(6./max(R*2.,.2))+vec3(0.,-T*.8,T*.3));
      float ridge=pow(clamp(1.-abs(n*2.-1.),0.,1.),8.);
      float d=(smoothstep(.55,.95,n)*.25+ridge*(.8+w.z*1.2))*(1.-rl*rl);
      acc+=mix(col,vec3(1.),ridge*.6)*d*dt*(2.4+uLevel*4.);
    }
    acc+=col*fres(normalize(ro+rd*hs.x),rd,3.)*(.7+uLevel);
    acc+=col*exp(-dmin/R*6.)*.12;
  }

  // holographic lattice globe around the core
  float Rs=R*1.42; vec2 hg=hitSphere(ro,rd,Rs);
  if(hg.x>0.){
    float lt=uT*(.12+w.z*.5);
    float fr=fres(normalize(ro+rd*hg.x),rd,2.);
    float lines=lattice(ro+rd*hg.x,lt)*(.35+fr)+lattice(ro+rd*hg.y,lt)*.12;
    acc+=col*lines*(.16+.25*w.y+.3*uLevel)+col*fr*.12;
  }

  // lightning: jagged arcs from the core out towards the rings
  float tp=-dot(ro,uFw)/dot(rd,uFw);
  vec3 pw=ro+rd*tp; vec2 pl=vec2(dot(pw,uRt),dot(pw,uUp));
  float rho=length(pl);
  float en=w.z*.9+w.w*(.25+uLevel*1.1)+w.y*.15;
  if(en>.02&&boot>.5&&rho>R*.85){
    float phi=atan(pl.y,pl.x), arcs=0.;
    for(int k=0;k<6;k++){
      float fk=float(k), seed=floor(uT*(5.+fk)+fk*1.7);
      float a0=h11(seed*13.1+fk*7.7)*6.2831853;
      float reach=R+(.3+.6*h11(seed*3.3+fk))*(.7+uLevel);
      float jag=(n1(rho*8.+seed*5.)-.5)*.9+(n1(rho*25.+seed*2.)-.5)*.3;
      float da=mod(phi-a0+3.14159265,6.2831853)-3.14159265;
      float dd=abs(rho*da-jag*(rho-R)*.7);
      float on=step(.25,h11(floor(uT*24.)+fk*3.1));
      arcs+=exp(-dd*140.)*(1.-smoothstep(reach*.7,reach,rho))*on;
    }
    acc+=mix(col,vec3(1.),.5)*arcs*en*1.4;
  }
  o=vec4(clamp(acc*boot,0.,16.),0.);
}`;

  const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o; uniform sampler2D uTex;
vec3 safe(vec3 c){return (any(isnan(c))||any(isinf(c)))?vec3(0.):clamp(c,0.,32.);}
void main(){ vec3 c=safe(texture(uTex,vUv).rgb); float m=max(c.r,max(c.g,c.b));
  o=vec4(c*smoothstep(.6,1.8,m),1.); }`;

  const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o; uniform sampler2D uTex; uniform vec2 uDir;
void main(){
  vec3 c=texture(uTex,vUv).rgb*.227;
  c+=(texture(uTex,vUv+uDir*1.385).rgb+texture(uTex,vUv-uDir*1.385).rgb)*.316;
  c+=(texture(uTex,vUv+uDir*3.231).rgb+texture(uTex,vUv-uDir*3.231).rgb)*.070;
  o=vec4(c,1.);
}`;

  const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uScene,uB1,uB2;
uniform vec2 uRes; uniform float uT,uShock,uLevel; uniform vec3 uTint;
float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
float hexEdge(vec2 p){vec2 r=vec2(1.,1.7320508),h=r*.5;
  vec2 a=mod(p,r)-h,b=mod(p-h,r)-h; vec2 g=dot(a,a)<dot(b,b)?a:b; g=abs(g);
  return max(dot(g,normalize(r)),g.x);}
vec3 safe(vec3 c){return (any(isnan(c))||any(isinf(c)))?vec3(0.):clamp(c,0.,32.);}
vec3 aces(vec3 x){return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.);}
void main(){
  vec2 uv=vUv, c=uv-.5, ca=c*vec2(uRes.x/uRes.y,1.);
  float r=length(ca), sg=0.;
  if(uShock>=0.&&uShock<1.4){
    float dr=(r-uShock*.75)*16., k=exp(-dr*dr)*(1.-uShock/1.4);
    uv-=normalize(c+1e-5)*k*.010; sg=k;
  }
  float ab=.0012+.006*r*r;
  vec3 s=safe(vec3(texture(uScene,uv+c*ab).r,texture(uScene,uv).g,texture(uScene,uv-c*ab).b));
  vec3 bl=safe(texture(uB1,uv).rgb*.8+texture(uB2,uv).rgb*1.2);
  vec3 bg=mix(vec3(.006,.016,.026),uTint*.05,exp(-r*3.2));
  float e=hexEdge(ca*16.), line=smoothstep(.44,.5,e);
  float wave=.5+.5*sin(r*26.-uT*1.6);
  bg+=uTint*line*exp(-r*2.4)*(.035+.05*uLevel)*(.6+.4*wave);
  vec3 col=bg+s+bl*(.85+uLevel*.5)+uTint*sg*.35;
  col=aces(col*1.05);
  col+=(hash(vUv*uRes+fract(uT)*91.)-.5)*.022;
  o=vec4(col,1.);
}`;

  // ---------------------------------------------------------------- GL plumbing
  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('[jarvis-core] shader:', gl.getShaderInfoLog(s)); return null;
    }
    return s;
  }
  function program(vs, fs) {
    const v = compile(gl.VERTEX_SHADER, vs), f = compile(gl.FRAGMENT_SHADER, fs);
    if (!v || !f) return null;
    const p = gl.createProgram();
    gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn('[jarvis-core] link:', gl.getProgramInfoLog(p)); return null;
    }
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS), loc = {};
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name;
      loc[name] = gl.getUniformLocation(p, name);
    }
    return { p, loc };
  }
  let halfFloat = false;
  function target(wd, ht) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, halfFloat ? gl.RGBA16F : gl.RGBA8, wd, ht, 0,
      gl.RGBA, halfFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fb, tex, w: wd, h: ht };
  }
  function dropTargets() {
    for (const k in T) { gl.deleteTexture(T[k].tex); gl.deleteFramebuffer(T[k].fb); }
    T = {};
  }
  function resize() {
    // Bloom softens everything anyway, so cap the render size: ~2k px wide
    // keeps a 1440p/4K screen at full frame rate with no visible loss.
    const cw = cv.clientWidth || innerWidth, ch = cv.clientHeight || innerHeight;
    const scale = Math.min(window.devicePixelRatio || 1, 2048 / cw);
    const wd = Math.max(2, Math.round(cw * scale));
    const ht = Math.max(2, Math.round(ch * scale));
    if (T.scene && T.scene.w === wd && T.scene.h === ht) return;
    cv.width = wd; cv.height = ht; dropTargets();
    const q = (n) => [Math.max(1, wd >> n), Math.max(1, ht >> n)];
    T.scene = target(wd, ht);
    T.half = target(...q(1));
    T.qa = target(...q(2)); T.qb = target(...q(2));
    T.ea = target(...q(3)); T.eb = target(...q(3));
  }

  // ---------------------------------------------------------------- camera
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  function camera(wd, ht) {
    // One world unit = the 2D HUD's "base" radius (0.2 x the short side), so the
    // GPU core lines up with the rings drawn on the canvas above it.
    const base = Math.min(wd, ht) * 0.2;
    const dist = (ht / 2) / base / TAN;
    const eye = [dist * Math.sin(yaw) * Math.cos(pitch), dist * Math.sin(pitch), dist * Math.cos(yaw) * Math.cos(pitch)];
    const fw = norm(sub([0, 0, 0], eye)), rt = norm(cross(fw, [0, 1, 0])), up = cross(rt, fw);
    const asp = wd / ht, f = 1 / TAN, n = 0.1, fa = 60;
    const Pm = [f / asp, 0, 0, 0, 0, f, 0, 0, 0, 0, (fa + n) / (n - fa), -1, 0, 0, 2 * fa * n / (n - fa), 0];
    const V = [rt[0], up[0], -fw[0], 0, rt[1], up[1], -fw[1], 0, rt[2], up[2], -fw[2], 0,
      -dot(rt, eye), -dot(up, eye), dot(fw, eye), 1];
    const VP = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0; for (let k = 0; k < 4; k++) s += Pm[k * 4 + r] * V[c * 4 + k];
      VP[c * 4 + r] = s;
    }
    return { eye, fw, rt, up, asp, VP };
  }

  // ---------------------------------------------------------------- audio -> FFT texture
  function updateFFT(level) {
    const an = opts.getAnalyser && opts.getAnalyser();
    let N = 0;
    if (an) {
      if (!raw || raw.length !== an.frequencyBinCount) raw = new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(raw); N = raw.length;
    }
    for (let i = 0; i < NBINS; i++) {
      let v;
      if (N) {
        // log-ish mapping: voices live in the bottom of the spectrum
        const a = Math.floor(Math.pow(i / NBINS, 1.7) * N * 0.75);
        const b = Math.max(a + 1, Math.floor(Math.pow((i + 1) / NBINS, 1.7) * N * 0.75));
        let m = 0; for (let k = a; k < b; k++) m = Math.max(m, raw[k]);
        v = Math.min(1, Math.pow(m / 255, 1.4) * 1.35);
      } else {
        v = Math.max(0, level * (0.35 + 0.35 * Math.sin(i * 0.45 + time * 4) + 0.3 * Math.sin(i * 0.17 - time * 2.3)));
      }
      const s = fftSm[i];
      fftSm[i] = s + (v - s) * (v > s ? 0.5 : 0.12);
      fftU8[i] = Math.round(fftSm[i] * 255);
    }
    gl.bindTexture(gl.TEXTURE_2D, fftTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NBINS, 1, gl.RED, gl.UNSIGNED_BYTE, fftU8);
  }

  // ---------------------------------------------------------------- frame
  function pass(prog, tgtBuf, setup) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, tgtBuf ? tgtBuf.fb : null);
    gl.viewport(0, 0, tgtBuf ? tgtBuf.w : cv.width, tgtBuf ? tgtBuf.h : cv.height);
    gl.useProgram(prog.p); setup(prog.loc);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function bindTex(unit, tex, loc) {
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(loc, unit);
  }
  function setPalette(loc) {
    gl.uniform3fv(loc.uC0, PAL[0]); gl.uniform3fv(loc.uC1, PAL[1]);
    gl.uniform3fv(loc.uC2, PAL[2]); gl.uniform3fv(loc.uC3, PAL[3]);
    gl.uniform4fv(loc.uW, w);
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (!ok) return;
    const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
    time += dt * (REDUCE ? 0.35 : 1);
    boot = Math.min(1, boot + dt / 2.8);
    const k = 1 - Math.exp(-dt * 3.2);
    for (let i = 0; i < 4; i++) w[i] += (tgt[i] - w[i]) * k;
    const level = Math.max(0, Math.min(1, (opts.getLevel && opts.getLevel()) || 0));
    const shock = REDUCE ? -1 : (time - shockAt < 1.6 ? time - shockAt : -1);

    resize(); updateFFT(level);
    yaw += (tyaw + Math.sin(time * 0.13) * 0.05 - yaw) * 0.04;
    pitch += (tpitch + Math.sin(time * 0.09) * 0.03 - pitch) * 0.04;
    const cam = camera(cv.width, cv.height);
    const tint = [0, 1, 2].map((c) => (PAL[0][c] * w[0] + PAL[1][c] * w[1] + PAL[2][c] * w[2] + PAL[3][c] * w[3]) / (w[0] + w[1] + w[2] + w[3]));

    gl.bindVertexArray(vao);
    // 1) scene: plasma core + particles, additive into the HDR target
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.scene.fb);
    gl.viewport(0, 0, T.scene.w, T.scene.h);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(P.core.p);
    {
      const L = P.core.loc;
      gl.uniform3fv(L.uCam, cam.eye); gl.uniform3fv(L.uRt, cam.rt);
      gl.uniform3fv(L.uUp, cam.up); gl.uniform3fv(L.uFw, cam.fw);
      gl.uniform1f(L.uTan, TAN); gl.uniform1f(L.uAsp, cam.asp);
      gl.uniform1f(L.uT, time); gl.uniform1f(L.uLevel, level); gl.uniform1f(L.uBoot, boot);
      setPalette(L);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.useProgram(P.parts.p);
    {
      const L = P.parts.loc;
      gl.uniformMatrix4fv(L.uVP, false, cam.VP);
      gl.uniform1f(L.uT, time); gl.uniform1f(L.uLevel, level); gl.uniform1f(L.uBoot, boot);
      gl.uniform1f(L.uPx, (cv.height / 2) / TAN); gl.uniform1f(L.uShock, shock);
      const g = Math.min(1.6, 80000 / nParticles);
      setPalette(L); bindTex(0, fftTex, L.uFFT);
      // Streak length per state: long lazy trails for the slow idle disc, short
      // sharp ones for the fast states (a long streak on a fast particle smears
      // its light over the whole screen).
      const sw = w[0] + w[1] + w[2] + w[3];
      const trail = (w[0] * 0.35 + w[1] * 0.16 + w[2] * 0.06 + w[3] * 0.05) / sw;
      gl.uniform1f(L.uTrail, trail * (REDUCE ? 0.4 : 1));
      // motion streaks: a line from where each particle was uTrail seconds ago
      gl.uniform1f(L.uMode, 0); gl.uniform1f(L.uGain, 0.17 * g);
      gl.drawArrays(gl.LINES, 0, nParticles * 2);
      // glowing heads
      gl.uniform1f(L.uMode, 1); gl.uniform1f(L.uGain, 0.16 * g);
      gl.drawArrays(gl.POINTS, 0, nParticles);
    }
    gl.disable(gl.BLEND);

    // 2) bloom: bright pass, then two blur octaves
    pass(P.bright, T.half, (L) => bindTex(0, T.scene.tex, L.uTex));
    pass(P.blur, T.qa, (L) => { bindTex(0, T.half.tex, L.uTex); gl.uniform2f(L.uDir, 1.5 / T.qa.w, 0); });
    pass(P.blur, T.qb, (L) => { bindTex(0, T.qa.tex, L.uTex); gl.uniform2f(L.uDir, 0, 1.5 / T.qa.h); });
    pass(P.blur, T.ea, (L) => { bindTex(0, T.qb.tex, L.uTex); gl.uniform2f(L.uDir, 2 / T.ea.w, 0); });
    pass(P.blur, T.eb, (L) => { bindTex(0, T.ea.tex, L.uTex); gl.uniform2f(L.uDir, 0, 2 / T.ea.h); });

    // 3) composite to screen
    pass(P.comp, null, (L) => {
      bindTex(0, T.scene.tex, L.uScene); bindTex(1, T.qb.tex, L.uB1); bindTex(2, T.eb.tex, L.uB2);
      gl.uniform2f(L.uRes, cv.width, cv.height); gl.uniform1f(L.uT, time);
      gl.uniform1f(L.uShock, shock < 0 ? -1 : shock); gl.uniform1f(L.uLevel, level);
      gl.uniform3fv(L.uTint, tint);
    });
  }

  // ---------------------------------------------------------------- public API
  function init(canvas, o) {
    cv = canvas; opts = o || {};
    try {
      gl = cv.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
    } catch (e) { gl = null; }
    if (!gl) { console.warn('[jarvis-core] no WebGL2, using the 2D core'); return false; }
    halfFloat = !!gl.getExtension('EXT_color_buffer_float');
    P.core = program(FS_TRI, CORE_FS);
    P.parts = program(PARTICLE_VS, PARTICLE_FS);
    P.bright = program(FS_TRI, BRIGHT_FS);
    P.blur = program(FS_TRI, BLUR_FS);
    P.comp = program(FS_TRI, COMPOSITE_FS);
    if (!P.core || !P.parts || !P.bright || !P.blur || !P.comp) return false;

    vao = gl.createVertexArray();
    fftTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, fftTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, NBINS, 1, 0, gl.RED, gl.UNSIGNED_BYTE, fftU8);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // fewer particles on small screens (or a weak GPU reporting a tiny canvas)
    const area = (cv.clientWidth || innerWidth) * (cv.clientHeight || innerHeight);
    nParticles = area < 700 * 500 ? 30000 : 80000;

    cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); ok = false; cv.style.display = 'none'; });
    if (!REDUCE) {
      addEventListener('pointermove', (e) => {
        tyaw = ((e.clientX / innerWidth) - 0.5) * 0.16;
        tpitch = ((e.clientY / innerHeight) - 0.5) * 0.10;
      });
    }
    ok = true;
    requestAnimationFrame(frame);
    return true;
  }

  function setState(s) {
    const i = STATES.indexOf(s);
    if (i < 0 || s === state) return;
    state = s;
    for (let j = 0; j < 4; j++) tgt[j] = j === i ? 1 : 0;
    shockAt = time;
  }

  // Diagnostic: count NaN/Inf pixels in the centre of the HDR scene buffer.
  function probe(size = 240) {
    if (!ok || !halfFloat) return null;
    const s = Math.min(size, T.scene.w, T.scene.h);
    const x = (T.scene.w - s) >> 1, y = (T.scene.h - s) >> 1;
    const buf = new Float32Array(s * s * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.scene.fb);
    gl.readPixels(x, y, s, s, gl.RGBA, gl.FLOAT, buf);
    let nan = 0, inf = 0, max = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      if (v !== v) nan++; else if (!isFinite(v)) inf++; else if (v > max) max = v;
    }
    return { nan, inf, max: +max.toFixed(2) };
  }

  window.JarvisCore = { init, setState, probe, get active() { return ok; } };
})();
