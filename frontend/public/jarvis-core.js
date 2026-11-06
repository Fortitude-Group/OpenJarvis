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
  // GLSL lives in jarvis-shaders.js (load it first).
  const { FS_TRI, PARTICLE_VS, PARTICLE_FS, CORE_FS, BRIGHT_FS, BLUR_FS, COMPOSITE_FS } = window.JarvisShaders || {};

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
    if (!window.JarvisShaders) { console.warn('[jarvis-core] jarvis-shaders.js not loaded, using the 2D core'); return false; }
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
