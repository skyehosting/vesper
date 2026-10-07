/**
 * GLSL for Armilla (three ShaderMaterial, WebGL2). Every material writes PREMULTIPLIED colour with one blend
 * (ONE, ONE_MINUS_SRC_ALPHA): in the dark theme alpha is 0, so light adds onto the page (no box, no night window);
 * in the light theme the same shapes are drawn as ink with real alpha (`uInk` = 1). No textures but the voice scope.
 */
import { SIMPLEX_NOISE_3D } from '../../noise.glsl'
import { SCOPE_N, SCOPE_TAPER } from './armilla.logic'

const f = (n: number): string => (Number.isInteger(n) ? `${n}.0` : String(n))

const COMMON = /* glsl */ `
const float PI = 3.141592653589793;
const float TAU = 6.283185307179586;
`

// ── Rings: one ribbon mesh for the horizon (ring 0) and the three gimbals (1 outer … 3 inner) ───────────────────────
export const RING_VERTEX = /* glsl */ `
${COMMON}
attribute float aT;
attribute float aSide;
attribute float aRing;
uniform mat4 uRingM[4];
uniform float uRadius[4];
uniform float uTime;
uniform float uSwell;
uniform sampler2D uScope;
uniform float uScopeWho;
uniform float uScopeLevel;
uniform float uWaveOn;
uniform float uAmp;
uniform vec2 uRes;
uniform float uDpr;
uniform float uCoreR;
uniform float uGlowPx;
uniform float uLineW[4];
uniform float uWater;
varying float vAcross;
varying float vHalfW;
varying float vFront;
varying float vT;
varying float vRing;
varying float vOcc;
varying float vU;
varying float vWho;
varying float vLive;

// The oscilloscope's drawn frame (armilla.logic Scope): SCOPE_N texels across the front, r = height (128 ± 127),
// read LINEAR and clamped at u (0 = the left end … 1 = the right end).
float scopeAt(float u) {
  float r = texture2D(uScope, vec2((clamp(u, 0.0, 1.0) * ${f(SCOPE_N - 1)} + 0.5) / ${f(SCOPE_N)}, 0.5)).r;
  return (r * 255.0 - 128.0) / 127.0;
}

float scopeTaper(float u) {
  return smoothstep(0.0, ${f(SCOPE_TAPER)}, u) * smoothstep(0.0, ${f(SCOPE_TAPER)}, 1.0 - u);
}

// The horizon's height at angle th (armilla.logic horizonWave, transliterated): a live oscilloscope of the REAL voice
// across the front half, standing still — u runs from the left end (0) to the right end (1), uniform in screen x. The
// back half (behind the bead) stays still.
float horizonY(float th, out float who, out float live) {
  float u = 0.5 + 0.5 * cos(th);
  float front = step(0.0, sin(th));
  who = uScopeWho;
  live = clamp(uScopeLevel * 1.4, 0.0, 1.0) * scopeTaper(u) * front * uWaveOn;
  // At rest: a long, slow swell, like calm water.
  float swell = uSwell * 0.006 * sin(2.0 * th + uTime * 0.35) * sin(3.0 * th - uTime * 0.21);
  return scopeAt(u) * uAmp * front * uWaveOn + swell;
}

vec3 ringPoint(int ring, float th, out float who, out float live) {
  who = 0.0;
  live = 0.0;
  if (ring == 0) {
    float R = uRadius[0];
    return vec3(R * cos(th), horizonY(th, who, live), R * sin(th));
  }
  // The gimbals: a true circle, only turned (owner, v1.1: no audio displacement on the inner rings, in any state).
  float R = uRadius[ring];
  return (uRingM[ring] * vec4(R * cos(th), R * sin(th), 0.0, 1.0)).xyz;
}

void main() {
  int ring = int(aRing + 0.5);
  float th = aT * TAU;
  float who;
  float live;
  float w2;
  float l2;
  vec3 p0 = ringPoint(ring, th, who, live);
  vec3 p1 = ringPoint(ring, th + 0.0025, w2, l2);
  vec4 v0 = viewMatrix * vec4(p0, 1.0);
  vec4 vc = viewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec4 c0 = projectionMatrix * v0;
  vec4 c1 = projectionMatrix * viewMatrix * vec4(p1, 1.0);
  vec2 s0 = c0.xy / c0.w * uRes * 0.5;
  vec2 s1 = c1.xy / c1.w * uRes * 0.5;
  vec2 tg = s1 - s0;
  tg = length(tg) > 1e-5 ? normalize(tg) : vec2(1.0, 0.0);
  vec2 nrm = vec2(-tg.y, tg.x);
  float R = max(uRadius[ring], 1e-3);
  float front = clamp((v0.z - vc.z) / R, -1.0, 1.0);
  // Lines are a touch thinner behind (depth cue) and the outer gimbal carries graduations (wider ribbon).
  float hw = uLineW[ring] * uDpr * mix(0.72, 1.0, smoothstep(-0.6, 0.6, front));
  float tick = ring == 1 ? 3.2 * uDpr : (ring == 0 ? 1.6 * uDpr : 0.0);
  float extent = hw + tick + uGlowPx * 3.0 + 1.0 + (ring == 0 ? 0.0 : 1.25 * uDpr);
  c0.xy += nrm * aSide * extent / (uRes * 0.5) * c0.w;
  vAcross = aSide * extent;
  vHalfW = hw;
  vFront = front;
  vT = aT;
  vRing = aRing;
  vU = 0.5 + 0.5 * cos(th);
  vWho = who;
  vLive = live;
  // Behind the bead: hidden by the liquid, seen dimmed through the clear glass above it.
  float dc = length(v0.xy - vc.xy);
  float behind = 1.0 - smoothstep(-0.08, 0.0, v0.z - vc.z);
  float inDisc = 1.0 - smoothstep(uCoreR * 0.92, uCoreR * 1.08, dc);
  float throughGlass = smoothstep(uWater - 0.01, uWater + 0.03, v0.y - vc.y);
  vOcc = 1.0 - behind * inDisc * mix(0.94, 0.6, throughGlass);
  gl_Position = c0;
}
`

export const RING_FRAGMENT = /* glsl */ `
${COMMON}
uniform vec3 uRingCol[4];
uniform vec3 uInkCol[4];
uniform vec3 uMicCol;
uniform vec3 uInkMic;
uniform float uInk;
uniform float uBrightHorizon;
uniform float uBrightGimbal;
uniform float uBackdrop;
uniform vec2 uRes;
uniform float uDim;
uniform float uGlowPx;
uniform float uDpr;
uniform float uSweep;
uniform float uComet[4];
uniform float uTicks;
uniform float uRingGain[4];
uniform float uDebug;
varying float vAcross;
varying float vHalfW;
varying float vFront;
varying float vT;
varying float vRing;
varying float vOcc;
varying float vU;
varying float vWho;
varying float vLive;

void main() {
  int ring = int(vRing + 0.5);
  float d = abs(vAcross);
  // Box-filtered hairline (sub-pixel lines get fainter, never jaggy) plus a soft glow. The gimbals are machined
  // rings: two rails with a faint web between them; the horizon is one line.
  float line;
  if (ring == 0) line = clamp(vHalfW + 0.5 - d, 0.0, 1.0);
  else {
    float rail = 1.25 * uDpr;
    float dr = abs(d - rail);
    line = clamp(vHalfW + 0.5 - dr, 0.0, 1.0) + mix(0.16, 0.08, uBackdrop) * (1.0 - smoothstep(rail - 0.5, rail + 0.5, d));
  }
  float glow = exp(-d * d / (2.0 * uGlowPx * uGlowPx));
  // Graduations: the outer gimbal every 10° (30° longer); the horizon every 5°, front half only.
  float tick = 0.0;
  if (uTicks > 0.0) {
    if (ring == 1) {
      float u = vT * 36.0;
      float along = abs(fract(u + 0.5) - 0.5) / max(fwidth(u), 1e-5);
      float major = step(abs(fract(vT * 12.0 + 0.5) - 0.5) * 12.0, 0.02);
      float len = mix(2.0, 3.2, major) * uDpr;
      tick = (1.0 - smoothstep(0.4, 1.1, along)) * (1.0 - smoothstep(len - 0.5, len + 0.5, d)) * mix(0.35, 0.6, major);
    } else if (ring == 0) {
      float u = vT * 72.0;
      float along = abs(fract(u + 0.5) - 0.5) / max(fwidth(u), 1e-5);
      tick = (1.0 - smoothstep(0.4, 1.0, along)) * (1.0 - smoothstep(1.1 * uDpr, 1.6 * uDpr, d)) * 0.3 * smoothstep(0.1, 0.7, vFront);
    }
    tick *= uTicks;
  }
  float depth = mix(0.3, 1.0, smoothstep(-0.85, 0.55, vFront));
  // Thinking: a comet of light runs each ring (head bright, tail behind).
  float k = fract(uComet[ring] - vT);
  // Behind text the head is longer and softer (no flicker against glyph edges).
  float comet = uSweep * (exp(-k * mix(18.0, 10.0, uBackdrop)) * 0.9 + exp(-k * 4.0) * 0.18);
  float gain = uRingGain[ring];
  float lit = (1.0 + comet + vLive * 0.35) * gain;
  vec3 col = uRingCol[ring];
  vec3 ink = uInkCol[ring];
  if (ring == 0) {
    col = mix(col, uMicCol, vWho);
    ink = mix(ink, uInkMic, vWho);
  }
  float cover = max(line, tick);
  float occ = vOcc * depth * uDim;
  if (ring == 0) {
    // The horizon fades out over the last 24 px before the canvas edge instead of being cut off there.
    float ex = min(gl_FragCoord.x, uRes.x - gl_FragCoord.x);
    occ *= smoothstep(0.0, 24.0 * uDpr, ex);
  }
  // Only the horizon follows the voice (owner, v1.1); behind text the lines are crisp hairlines (little glow).
  float bright = ring == 0 ? uBrightHorizon : uBrightGimbal;
  vec3 emit = col * (cover * 0.95 + glow * mix(0.16, 0.04, uBackdrop)) * lit * occ * bright;
  // Ink: the line itself, no glow wash.
  float a = clamp(cover * 0.78 * min(lit, 1.6) * occ, 0.0, 1.0);
  gl_FragColor = vec4(mix(emit, ink * a, uInk), a * uInk);
  if (uDebug > 0.5 && ring == 0) gl_FragColor = vec4(vec3(1.0 - vU, vU, 0.0) * cover, 0.0);
}
`

// ── The bead (liquid light in a glass shell) and its halo: one camera-facing quad at the centre ─────────────────────
export const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * length(modelMatrix[0].xyz);
  gl_Position = projectionMatrix * mv;
}
`

export const BEAD_FRAGMENT = /* glsl */ `
${COMMON}
${SIMPLEX_NOISE_3D}
uniform float uHalf;
uniform float uCoreR;
uniform float uFlow;
uniform float uTime;
uniform float uOctaves;
uniform vec2 uElev;      // (sin, cos) of the camera's elevation
uniform float uLevel;    // liquid level (bead radii, 0 = the equator = the horizon's plane)
uniform float uSlosh;    // long waves (the AI's low band)
uniform float uChop;     // short waves (the AI's mid/high bands)
uniform float uRipple;   // concentric ripples (the owner's voice)
uniform float uSwirl;    // a turning wave (thinking)
uniform float uWaveT;
uniform vec3 uBeadCol;
uniform vec3 uRingCol;
uniform vec3 uHaloCol;
uniform vec3 uMicCol;
uniform vec3 uInkBead;
uniform vec3 uInkRing;
uniform float uInk;
uniform float uBright;
uniform float uDim;
uniform float uError;
uniform float uHalo;
uniform float uListen;
uniform float uBehind;
varying vec2 vUv;

// The liquid's surface height (bead radii) at (x, z) in the bead's world-aligned frame.
float surface(vec2 xz) {
  float t = uWaveT;
  float h = uLevel;
  h += uSlosh * (0.075 * sin(3.1 * xz.x - 4.6 * t) + 0.04 * sin(2.3 * xz.y + 1.9 * xz.x - 3.3 * t + 1.0));
  h += uChop * 0.022 * sin(11.0 * xz.x + 4.0 * xz.y - 9.0 * t) * sin(7.0 * xz.y - 6.0 * t);
  float r = length(xz);
  h += uRipple * 0.035 * sin(16.0 * r + 7.0 * t) * (1.0 - r * 0.6);
  float a = atan(xz.y, xz.x);
  h += uSwirl * 0.03 * sin(2.0 * a - 2.4 * t) * r;
  h += 0.012 * sin(1.7 * xz.x + 0.8 * t) * sin(1.3 * xz.y - 0.6 * t);
  return h;
}

void main() {
  vec2 p = (vUv * 2.0 - 1.0) * uHalf;
  float r = length(p);
  // Halo: wide and low-frequency (kind to text on top), fading out well inside the quad (no box).
  float fade = 1.0 - smoothstep(uHalf * 0.5, uHalf * 0.98, r);
  float halo = (exp(-r * r / 0.40) * 0.06 + exp(-r * r / 0.07) * 0.12) * fade * uHalo;
  vec3 haloCol = mix(uHaloCol, uMicCol, uListen * 0.6);
  vec3 emit = haloCol * halo;
  // Ink (light theme): no halo wash at all — the glass is drawn, the light is not.
  float alpha = 0.0;
  vec3 ink = vec3(0.0);

  float rr = r / uCoreR;
  float px = max(fwidth(rr), 1e-4);
  if (rr < 1.0 + 3.0 * px) {
    vec2 q = p / uCoreR;
    float z = sqrt(max(0.0, 1.0 - dot(q, q)));
    // View basis in the bead's world-aligned frame: right, up, toward the camera.
    vec3 up = vec3(0.0, uElev.y, -uElev.x);
    vec3 bk = vec3(0.0, uElev.x, uElev.y);
    vec3 P = vec3(q.x, 0.0, 0.0) + q.y * up + z * bk;
    float fres = pow(1.0 - z, 3.0);
    float hP = surface(P.xz);
    vec3 liquidDeep = mix(uRingCol * 0.42, uHaloCol * 0.5, 0.25);
    vec3 liquidTop = mix(uRingCol, uBeadCol, 0.6) * 0.92;
    vec3 col = vec3(0.0);
    float a = 0.0;
    float below = hP - P.y;
    // Waterline on the front glass: a fine bright meniscus.
    float wl = px * 1.6 / max(uElev.y * z + 0.05, 0.05);
    float men = exp(-(below * below) / (wl * wl));
    if (below > 0.0) {
      // Through the front glass into the liquid: it glows most just under its surface.
      float glow = 0.42 + 0.58 * exp(-below * 3.2);
      float n = snoise(vec3(P.xz * 2.2, uFlow * 0.08)) * 0.5 + 0.5;
      if (uOctaves > 1.5) n = mix(n, snoise(vec3(P.xz * 5.0 + 3.0, uFlow * 0.11)) * 0.5 + 0.5, 0.35);
      vec3 lc = mix(liquidDeep, liquidTop, glow) * (0.88 + 0.24 * n) * mix(0.62, 1.0, pow(z, 0.5));
      col = lc;
      a = 0.62 - 0.22 * glow;
    } else {
      // Above the waterline: the ray runs down through clear glass and may meet the liquid's top surface.
      float t = (P.y - hP) / max(uElev.x, 0.02);
      vec3 H = P - bk * t;
      for (int i = 0; i < 2; i++) {
        float hh = surface(H.xz);
        t = (P.y - hh) / max(uElev.x, 0.02);
        H = P - bk * t;
      }
      if (dot(H, H) < 1.0) {
        // The surface seen at a grazing angle: a bright sheet with the waves written in its shading.
        float e = 0.02;
        vec3 ns = normalize(vec3(-(surface(H.xz + vec2(e, 0.0)) - surface(H.xz)) / e, 1.0, -(surface(H.xz + vec2(0.0, e)) - surface(H.xz)) / e));
        vec3 L = normalize(vec3(-0.4, 0.8, 0.45));
        float shade = clamp(0.45 + 0.7 * dot(ns, L) - 0.35 * ns.z, 0.3, 1.1);
        float edge = 1.0 - smoothstep(0.86, 1.0, length(H.xz));
        // A faint caustic keeps it a liquid, not a flat cream sheet.
        float cau = snoise(vec3(H.xz * 6.0, uFlow * 0.12)) * 0.5 + 0.5;
        col = mix(liquidDeep, liquidTop, 0.7) * shade * mix(0.6, 0.9, edge) * (0.62 + 0.22 * cau);
        a = 0.2;
      } else {
        // Clear glass: only a faint tint of the light inside.
        // Clear glass: the dome is lit from below by the liquid, brightest just above the waterline and where the
        // glass turns away (its inner wall catches the light).
        float above = max(P.y - hP, 0.0);
        col = liquidTop * (0.13 * exp(-above * 2.6) + 0.1 * fres) + liquidDeep * 0.04;
        a = 0.05 + 0.1 * exp(-above * 2.6);
      }
    }
    col += liquidTop * men * 0.75;
    a = max(a, men * 0.55);
    // Glass: fresnel rim, a hairline shell, and a small window reflection up-left.
    vec3 hv = normalize(normalize(vec3(-0.55, 0.62, 0.56)) + vec3(0.0, 0.0, 1.0));
    vec3 nrm = vec3(q, z);
    float spec = pow(max(dot(nrm, hv), 0.0), 150.0);
    float sq = (rr - 1.0) / (px * 0.9 + 0.006);
    float shell = exp(-sq * sq);
    float disc = 1.0 - smoothstep(1.0 - px, 1.0 + px, rr);
    vec3 errCol = vec3(1.0, 0.36, 0.32);
    vec3 rimCol = mix(uRingCol, errCol, uError);
    vec3 bead = col + rimCol * (fres * 0.4 + shell * 0.45) + vec3(1.0) * spec * 0.5;
    emit = emit * (1.0 - disc * 0.85) + bead * disc;
    // Light theme: the same glass as ink — liquid tinted, shell a hairline, the highlight left as the page.
    // Behind text the ink bead is its shell and meniscus only (no liquid body fill).
    float fill = mix(a, men * 0.55, uBehind);
    float ia = disc * clamp(fill * 0.8 + fres * 0.18, 0.0, 1.0) + shell * 0.6;
    ia = clamp(ia * (1.0 - spec * 0.9), 0.0, 1.0);
    vec3 inkCol = mix(uInkBead, mix(uInkRing, errCol * 0.55, uError), clamp(fres * 1.2 + shell, 0.0, 1.0));
    inkCol = mix(inkCol, uInkBead * 0.55, men);
    ink = ink * (1.0 - ia) + inkCol * ia;
    alpha = alpha * (1.0 - ia) + ia;
  }
  // Filled areas fade faster than lines when dimmed (behind text): dim².
  float dimA = uDim * uDim;
  emit *= uBright * dimA;
  ink *= dimA;
  alpha *= dimA;
  // Dither (±½ of an 8-bit step): no banding in the faint, wide halo.
  float dz = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  emit += dz / 255.0;
  alpha = max(0.0, alpha + dz / 255.0 * uInk);
  gl_FragColor = vec4(mix(max(emit, 0.0), ink, uInk), alpha * uInk);
}
`

// ── Pivot jewels where the gimbals are pinned to each other ─────────────────────────────────────────────────────────
export const JEWEL_VERTEX = /* glsl */ `
attribute float aGlow;
uniform float uSize;
uniform float uDpr;
varying float vGlow;
varying float vFront;
void main() {
  vec4 mv = viewMatrix * vec4(position, 1.0);
  vec4 vc = viewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vFront = clamp((mv.z - vc.z) / 0.6, -1.0, 1.0);
  vGlow = aGlow;
  gl_PointSize = uSize * uDpr * mix(0.75, 1.0, vFront * 0.5 + 0.5);
  gl_Position = projectionMatrix * mv;
}
`

export const JEWEL_FRAGMENT = /* glsl */ `
uniform vec3 uCol;
uniform vec3 uInkCol;
uniform float uInk;
uniform float uBright;
uniform float uDim;
varying float vGlow;
varying float vFront;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float core = 1.0 - smoothstep(0.18, 0.42, d);
  float glow = exp(-d * d * 5.0) * 0.35;
  float depth = mix(0.35, 1.0, vFront * 0.5 + 0.5);
  float lit = (1.0 + vGlow) * depth * uDim;
  vec3 emit = uCol * (core + glow) * lit * uBright;
  float a = clamp(core * 0.8 * lit, 0.0, 1.0);
  gl_FragColor = vec4(mix(emit, uInkCol * a, uInk), a * uInk);
}
`
