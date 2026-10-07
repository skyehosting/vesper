/**
 * GLSL for the Star (research 07 §2.2): a displaced icosphere orb — white-hot core, granulated plasma body, a limb
 * that brightens into the corona colour — inside a corona billboard (tight halo, wide glow, slow streamers, the
 * brand's four-point glint, the listening ring), a halo of motes, and the "nebula" style's domain-warped gas cloud.
 * Every audio/state input is a uniform: styles and states crossfade, they never switch shaders.
 *
 * Light is ADDED (custom blending ONE/ONE, alpha untouched) and written with alpha 0: the canvas is premultiplied, so
 * the glow adds light to whatever is behind it (the night stage) instead of painting a box.
 */
import { SIMPLEX_NOISE_3D } from './noise.glsl'

/** Uniforms shared by every Star material (one object, so one update per frame feeds them all). */
export const COMMON_UNIFORMS = /* glsl */ `
uniform float uTime;      // seconds; frozen under reduced motion
uniform float uEnv;       // output (voice) envelope 0..1
uniform float uLow;
uniform float uMid;
uniform float uHigh;
uniform float uPulse;     // rate-limited onset pulse 0..1
uniform float uMic;       // the user's mic envelope 0..1
uniform float uEnergy;    // state base brightness
uniform float uBright;    // audio + throb brightness multiplier (≤ 1.15)
uniform float uSwirl;
uniform float uNoise;
uniform float uGather;
uniform float uSat;
uniform float uError;
uniform float uRing;
uniform float uVoice;
uniform float uMotion;    // 1 full motion, 0 reduced
uniform float uOrbR;      // orb radius in the billboard's units (the quad spans -1..1)
uniform vec3 uCore;
uniform vec3 uBody;
uniform vec3 uCorona;
uniform vec3 uRim;
uniform vec3 uMicCol;
`

const HELPERS = /* glsl */ `
vec3 saturateCol(vec3 c, float s) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return mix(vec3(l), c, s);
}
const vec3 ERROR_TINT = vec3(1.0, 0.34, 0.32);
`

// ── Orb ────────────────────────────────────────────────────────────────────────────────────────
export const ORB_VERTEX = /* glsl */ `
${COMMON_UNIFORMS}
${SIMPLEX_NOISE_3D}
varying vec3 vNormalW;
varying vec3 vViewDir;
varying vec3 vSurf;
varying float vDisp;

float disp(vec3 n) {
  float t = uTime;
  float big = snoise(n * 1.3 + vec3(0.0, t * 0.21, t * 0.1)) * (0.01 + 0.016 * uNoise + 0.07 * uLow * uVoice);
  float fine = snoise(n * 3.4 + vec3(t * 0.6, 0.0, t * 0.35)) * (0.003 + 0.005 * uNoise + 0.025 * uHigh * uVoice);
  return (big + fine + uPulse * 0.018 * uVoice) * uMotion;
}

void main() {
  vec3 n = normalize(position);
  float d = disp(n);
  vec3 p = position * (1.0 + d);
  // Normal after displacement from two displaced neighbours (research 07 §2.2 A).
  vec3 up = abs(n.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 t = normalize(cross(n, up));
  vec3 b = cross(n, t);
  float e = 0.015;
  vec3 n1 = normalize(n + e * t);
  vec3 n2 = normalize(n + e * b);
  float r = length(position);
  vec3 p1 = n1 * r * (1.0 + disp(n1));
  vec3 p2 = n2 * r * (1.0 + disp(n2));
  vec3 nn = normalize(cross(p1 - p, p2 - p));
  if (dot(nn, n) < 0.0) nn = -nn;
  vec4 world = modelMatrix * vec4(p, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * nn);
  vViewDir = normalize(cameraPosition - world.xyz);
  vSurf = n;
  vDisp = d;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`

export const ORB_FRAGMENT = /* glsl */ `
${COMMON_UNIFORMS}
${SIMPLEX_NOISE_3D}
${HELPERS}
varying vec3 vNormalW;
varying vec3 vViewDir;
varying vec3 vSurf;
varying float vDisp;

void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(vViewDir);
  float f = clamp(dot(N, V), 0.0, 1.0);
  float t = uTime;
  // Plasma granulation drifting over the surface (two octaves, cells and lanes).
  vec3 q = vSurf * 3.1 + vec3(0.0, -t * 0.12 * (0.4 + uSwirl), t * 0.05);
  float g1 = snoise(q);
  float g2 = snoise(q * 2.4 + vec3(t * 0.1 * uSwirl, 1.7, 0.0));
  float gran = clamp(0.64 + 0.24 * g1 + 0.12 * g2, 0.0, 1.0);
  // Body → core toward the centre of the disc; the voice lights the core.
  vec3 body = mix(uBody * 0.72, uBody * 1.02, gran);
  vec3 col = mix(body, uCore, smoothstep(0.05, 0.95, f) * (0.6 + 0.3 * gran));
  // A white-hot heart: above 1.0 at the centre, so the bloom (high quality) turns it into glare.
  col += uCore * pow(f, 3.0) * (0.32 + 0.12 * uEnv * uVoice + 0.08 * uPulse * uVoice);
  col += uBody * vDisp * 2.0;
  // Limb: the edge brightens into the rim/corona colour — an atmosphere rather than a hard ball.
  float limb = pow(1.0 - f, 2.8);
  vec3 rim = mix(mix(uRim, uCorona, 0.4), ERROR_TINT, uError * 0.8);
  col = mix(col, rim * (1.0 + 0.2 * uEnv * uVoice + 0.2 * uHigh * uVoice), limb * 0.8);
  col += uMicCol * limb * uRing * (0.15 + 0.55 * uMic);
  col = saturateCol(col, uSat);
  col *= uEnergy * uBright;
  gl_FragColor = vec4(col, 1.0);
}
`

// ── Camera-facing quads ────────────────────────────────────────────────────────────────────────
export const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv * 2.0 - 1.0;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec2 scale = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
  mv.xy += position.xy * scale;
  gl_Position = projectionMatrix * mv;
}
`

export const CORONA_FRAGMENT = /* glsl */ `
${COMMON_UNIFORMS}
${SIMPLEX_NOISE_3D}
${HELPERS}
varying vec2 vUv;

void main() {
  vec2 p = vUv;
  float r = length(p);
  if (r > 1.0) discard;
  float a = atan(p.y, p.x);
  float t = uTime;
  float out_ = max(r - uOrbR, 0.0);             // distance outside the orb
  float rr = r / uOrbR;
  vec2 dir = vec2(cos(a), sin(a));
  // Streamers: angular noise that churns slowly and reaches further with the voice.
  float n1 = snoise(vec3(dir * 1.5, t * 0.08 + out_ * 1.2));
  float n2 = snoise(vec3(dir * 3.2 + 4.0, t * 0.14 - out_ * 2.0));
  float streak = smoothstep(-0.25, 0.85, n1 * 0.65 + n2 * 0.35);
  float reach = 0.16 + 0.08 * uNoise + 0.14 * uMid * uVoice + 0.05 * uPulse * uVoice;
  float halo = exp(-out_ * 16.0);                                   // hugs the limb
  float glow = exp(-out_ * 4.2) * 0.42;                             // the wide soft light
  float streamers = exp(-out_ / max(reach, 0.02)) * streak * 0.55;
  vec3 rim = mix(mix(uRim, uCorona, 0.35), ERROR_TINT, uError * 0.7);
  vec3 col = rim * halo * 0.9 + uCorona * (glow + streamers);
  // The four-point glint (the brand's star): thin rays turning slowly, longer with the voice.
  float rot = t * 0.02;
  float rays = pow(abs(cos(2.0 * (a - rot))), 300.0);
  float rays2 = pow(abs(cos(2.0 * (a - rot - 0.785398))), 900.0);
  float rayLen = 0.3 + 0.22 * uEnv * uVoice + 0.08 * uPulse * uVoice;
  float rayFade = smoothstep(uOrbR * 0.6, uOrbR * 1.02, r);
  col += mix(uCore, uRim, 0.3) * (rays * exp(-out_ / rayLen) * 0.5 + rays2 * exp(-out_ / (rayLen * 0.45)) * 0.14) * rayFade;
  // Listening ring: the user's voice in its own hue, so "who is talking" reads at a glance.
  float ringR = uOrbR * (1.5 + 0.18 * uMic);
  float wob = snoise(vec3(dir * 1.2, t * 0.5)) * 0.005 * uMotion;
  float ring = exp(-pow((r - ringR - wob) / (0.016 + 0.02 * uMic), 2.0));
  col += uMicCol * ring * uRing * (0.6 + 0.9 * uMic);
  col += uMicCol * exp(-out_ * 6.0) * uRing * (0.08 + 0.3 * uMic);
  col = saturateCol(col, uSat);
  col *= uEnergy * uBright;
  col *= smoothstep(1.0, 0.62, r);              // fades to nothing well inside the quad
  gl_FragColor = vec4(col, 0.0);
}
`

/** A soft core bloom drawn over the orb (always on; real bloom adds to it on `high`). */
export const FRONT_GLOW_FRAGMENT = /* glsl */ `
${COMMON_UNIFORMS}
${HELPERS}
varying vec2 vUv;
uniform float uGlow;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float g = exp(-r * r * 9.0) * 0.22 + exp(-r * r * 40.0) * 0.18;
  vec3 col = mix(uCore, uBody, smoothstep(0.0, 0.6, r)) * g * (0.75 + 0.5 * uEnv * uVoice);
  col = saturateCol(col, uSat) * uEnergy * uBright * uGlow;
  gl_FragColor = vec4(col * smoothstep(1.0, 0.7, r), 0.0);
}
`

// ── Motes ──────────────────────────────────────────────────────────────────────────────────────
export const MOTES_VERTEX = /* glsl */ `
${COMMON_UNIFORMS}
${SIMPLEX_NOISE_3D}
attribute vec4 aSeed;        // x: angle, y: radius, z: height, w: random
uniform float uPx;           // device pixels per world unit at distance 1
uniform float uOrbWorld;     // the orb's radius in world units
varying float vAlpha;
varying float vWarm;

void main() {
  float t = uTime;
  float speed = (0.04 + 0.07 / aSeed.y) * (0.5 + uSwirl * 1.3);
  float ang = aSeed.x + t * speed * uMotion;
  float rad = aSeed.y * mix(0.7, 1.0, clamp(uGather, 0.0, 1.2)) * (1.0 + 0.06 * uEnv * uVoice + 0.04 * uPulse * uVoice);
  vec3 pos = vec3(cos(ang) * rad, aSeed.z * rad, sin(ang) * rad);
  pos += vec3(snoise(vec3(aSeed.w * 13.0, t * 0.15, 0.0)), snoise(vec3(0.0, aSeed.w * 17.0, t * 0.15)), 0.0) * 0.035 * uMotion;
  // The swarm is a slightly tilted disc, seen a little from above.
  float c = cos(0.24), s = sin(0.24);
  pos = vec3(pos.x, pos.y * c - pos.z * s, pos.y * s + pos.z * c);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  float twinkle = 0.6 + 0.4 * sin(t * (0.8 + aSeed.w * 1.6) + aSeed.w * 40.0);
  float front = smoothstep(-0.25, 0.5, pos.z);
  // Motes passing in front of the orb fade, so the disc stays clean (they read as dust, not dirt).
  vec4 centre = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float overDisc = (1.0 - smoothstep(uOrbWorld * 0.85, uOrbWorld * 1.15, length(mv.xy - centre.xy))) * step(0.0, pos.z);
  vAlpha = twinkle * (0.3 + 0.7 * aSeed.w) * mix(0.35, 1.0, front) * (1.0 - 0.8 * overDisc);
  vWarm = aSeed.w;
  gl_PointSize = max(1.5, uPx * (0.012 + 0.02 * aSeed.w) * (1.0 + 0.4 * uEnv * uVoice) / max(-mv.z, 0.1));
}
`

export const MOTES_FRAGMENT = /* glsl */ `
${COMMON_UNIFORMS}
${HELPERS}
varying float vAlpha;
varying float vWarm;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a = smoothstep(0.5, 0.0, d);
  a = a * a * (0.6 + 0.4 * a);
  vec3 col = mix(uRim, uCore, vWarm * 0.6 + 0.3);
  col = mix(col, uCorona, (1.0 - vWarm) * 0.35);
  col = mix(col, uMicCol, uRing * 0.4);
  col = saturateCol(col, uSat) * uEnergy * uBright;
  gl_FragColor = vec4(col * a * vAlpha * 1.4, 0.0);
}
`

// ── Nebula ─────────────────────────────────────────────────────────────────────────────────────
export const NEBULA_FRAGMENT = /* glsl */ `
${COMMON_UNIFORMS}
${SIMPLEX_NOISE_3D}
${HELPERS}
varying vec2 vUv;
uniform float uOctaves;

float fbm(vec3 p) {
  float v = 0.0;
  float amp = 0.55;
  for (int i = 0; i < 5; i++) {
    if (float(i) >= uOctaves) break;
    v += amp * snoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    amp *= 0.5;
  }
  return v;
}

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

void main() {
  vec2 p = vUv * 1.18;
  float r = length(p);
  if (r > 1.18) discard;
  float t = uTime;
  // A slow spiral: inner gas turns faster than the outer veil, the voice stirs it.
  float spin = t * 0.05 * (0.5 + uSwirl) + (1.3 - r) * (1.1 + 0.5 * uMid * uVoice);
  vec2 q = rot(spin) * p;
  float f = fbm(vec3(q * 1.8, t * 0.045));
  float g = fbm(vec3(q * 3.4 + f * 1.3, t * 0.07 + 7.0));
  float arms = 0.5 + 0.5 * sin(atan(q.y, q.x) * 2.0 + r * 6.0 + f * 2.2);
  float density = smoothstep(1.0, 0.08, r) * (0.35 + 0.65 * smoothstep(-0.4, 0.7, f)) * (0.45 + 0.55 * arms);
  density *= mix(0.75, 1.0, uGather);
  vec3 gas = mix(uCorona, uBody, smoothstep(-0.35, 0.65, g));
  gas = mix(gas, uMicCol, uRing * 0.25 * smoothstep(0.3, 0.9, r));
  float core = exp(-r * r * (26.0 - 10.0 * uEnv * uVoice)) * (0.95 + 0.45 * uEnv * uVoice + 0.2 * uPulse * uVoice);
  float halo = exp(-r * r * 5.5) * 0.28;
  vec3 col = gas * density * 1.15 + uCore * core * 0.95 + mix(uRim, uCore, 0.4) * halo;
  // Sparkle where the gas is densest, quickened by the sibilants.
  float sparkle = pow(max(snoise(vec3(q * 15.0, t * (0.35 + 1.4 * uHigh * uVoice))), 0.0), 7.0) * density;
  col += uCore * sparkle * 1.2;
  float ringR = 0.8 + 0.1 * uMic;
  float ring = exp(-pow((r - ringR) / (0.02 + 0.025 * uMic), 2.0));
  col += uMicCol * ring * uRing * (0.55 + 0.9 * uMic);
  col = mix(col, col * vec3(1.25, 0.55, 0.5), uError * 0.6);
  col = saturateCol(col, uSat) * uEnergy * uBright;
  col *= smoothstep(1.15, 0.7, r);
  gl_FragColor = vec4(col, 0.0);
}
`

/** Final pass for the bloom chain: fade the light to nothing before the canvas edge (no visible box). */
export const EDGE_FADE_EFFECT = /* glsl */ `
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 p = (uv - 0.5) * resolution / min(resolution.x, resolution.y) * 2.0;
  float k = smoothstep(1.0, 0.72, length(p));
  outputColor = vec4(inputColor.rgb * k, inputColor.a);
}
`

/**
 * The chat backdrop's legibility guard (v1.1, backdrop.logic.ts): no output pixel's max channel above the cap (values
 * are sRGB-encoded: the canvas is `flat linear`). Linear (untouched) below 0.6 × cap — hairlines keep their crisp
 * core-to-glow ratio — and an exponential shoulder above it that never exceeds the cap; HDR light above 1 is
 * compressed too. Hue is kept. The cap is spatial: `uCap` over the message column (|x − ½| ≤ `uColHalf`, canvas
 * width fractions), `uCapOut` outside it where no text sits, with a `uColEdge`-wide smooth edge.
 * `uInk` = 1 (Armilla in the light theme lays ink with real alpha over the page): the same curve bounds the ink's
 * coverage (alpha, premultiplied colour scaled with it), so no pixel darkens the page by more than the cap.
 */
export const LUMA_CAP_EFFECT = /* glsl */ `
uniform float uCap;
uniform float uCapOut;
uniform float uColHalf;
uniform float uColEdge;
uniform float uInk;
float capCurve(float m, float cap) {
  float knee = 0.6 * cap;
  if (m <= knee) return m;
  float room = cap - knee;
  return knee + room * (1.0 - exp(-(m - knee) / max(room, 1e-4)));
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  float inside = 1.0 - smoothstep(uColHalf, uColHalf + max(uColEdge, 1e-4), abs(uv.x - 0.5));
  float cap = clamp(mix(uCapOut, uCap, inside), 0.02, 1.0);
  if (cap > 0.999) {
    outputColor = inputColor;
    return;
  }
  if (uInk > 0.5) {
    float a = clamp(inputColor.a, 0.0, 1.0);
    outputColor = max(inputColor, vec4(0.0)) * (a > 1e-5 ? capCurve(a, cap) / a : 1.0);
    return;
  }
  vec3 c = max(inputColor.rgb, vec3(0.0));
  float m = max(max(c.r, c.g), c.b);
  c *= m > 1e-5 ? capCurve(m, cap) / m : 1.0;
  outputColor = vec4(c, inputColor.a);
}
`
