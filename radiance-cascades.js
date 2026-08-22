/**
 * A small, dependency free radiance cascades renderer, written for rtx-on.
 *
 * The page is modelled as a heightfield: a flat background at z = 0 with a handful of raised
 * rounded rectangles standing on it, lit by a single round light hanging above. Rather than
 * tracing paths from the camera, the renderer solves the radiance field of that scene with
 * radiance cascades (Alexander Sannikov, 2023): a hierarchy of probe grids where each level
 * up trades spatial resolution for angular resolution, and covers a ray interval four times
 * longer than the level below it.
 *
 * The whole hierarchy is merged from the top down into cascade 0, whose probes sit one per
 * pixel of a reduced resolution grid. Averaging the directions of a cascade 0 probe gives the
 * irradiance at that point, which is all the compositing pass needs: the image is the albedo
 * of the page, dimmed by how much light reaches it.
 *
 * Everything below works in "base pixels", the pixels of that reduced resolution grid. Scene
 * coordinates handed to setScene() and setLightPosition() are in the units the caller frames
 * the scene with, and are converted on the way in.
 */

// Number of cascade levels. Level 0 has one probe per base pixel and 4 directions; each level
// up halves the probe grid on both axes and quadruples the number of directions, so every
// cascade holds the same number of rays and lives in a texture of the same size.
const cascadeCount = 5;
// Probe grids are halved cascadeCount - 1 times, so the base grid is a multiple of that.
const baseAlignment = 1 << (cascadeCount - 1);
// Size of the base grid along its largest side, as a fraction of the canvas and within bounds.
// Irradiance is smooth, so it is solved well below the resolution of the page and upsampled.
const baseScale = 1 / 3;
const minBaseSize = 96;
const maxBaseSize = 384;

// Radiance reaching the scene from beyond its bounds, and radiance of the light itself, both
// as a fraction of the light value. The sky stands in for the light bounced around by
// everything the page does not model, and is what keeps shadows from going black.
const skyStrength = 1.21;
const lightStrength = 0.45;
// How much of the light hitting a raised element is bounced back onto the page by its sides.
const bounceStrength = 0.6;
// How quickly the light dims with distance. A light hanging over a plane falls off with the
// power 1.5, which over the size of a page leaves the far end of it too dark to read a shadow
// on, so it is flattened towards an even wash.
const falloffPower = 0.6;

// Lowest level allowed to catch the light. The levels below it hold 4 and 16 directions,
// too few to spread the light over smoothly, and they only ever reach a few pixels out
// anyway: leaving it to level 2 and up costs nothing and keeps the light clean.
const lightLevel = 2.5;

// How many frames to render after a change. A frame is a full solve of the radiance field;
// the extra ones only refine the bounced light, which is fed back from the frame before.
const convergeFrames = 3;

// Vertex shader shared by every pass: a unit quad stretched onto a rectangle of clip space.
// Passes covering the whole target draw it over [-1, 1], the ones drawing a single raised
// element only over the part of the target that element covers.
const quadVertexShader = `#version 300 es
in vec2 aPos;
uniform vec4 uRect;
void main() {
  gl_Position = vec4(mix(uRect.xy, uRect.zw, aPos), 0.0, 1.0);
}`;

// Signed distance to a rounded rectangle, negative inside it. Shared by the passes that
// rasterize the scene and the ones that rasterize its albedo.
const roundedBoxShader = `
float roundedBox(vec2 p, vec2 center, vec2 halfSize, float radius) {
  vec2 q = abs(p - center) - halfSize + radius;
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - radius;
}`;

// Rasterize the scene into the grid the rays march through: the albedo of whatever stands at
// each base pixel, and the signed distance to the nearest raised element, in base pixels.
// Marching uses that distance to step over empty space, and its sign to know when a ray is
// inside the footprint of an element and has to be tested against its height.
const sceneFragmentShader = `#version 300 es
precision highp float;
uniform sampler2D uElements;
uniform int uCount;
uniform vec3 uBackground;
out vec4 fragColor;
${roundedBoxShader}
void main() {
  vec2 p = gl_FragCoord.xy;
  float nearest = 4096.0;
  vec3 albedo = uBackground;

  for (int i = 0; i < uCount; i++) {
    vec4 rect = texelFetch(uElements, ivec2(i * 2, 0), 0);
    vec4 color = texelFetch(uElements, ivec2(i * 2 + 1, 0), 0);
    float d = roundedBox(p, rect.xy, rect.zw, color.w);
    if (d < nearest) {
      nearest = d;
      if (d < 0.0) {
        albedo = color.rgb;
      }
    }
  }

  fragColor = vec4(albedo, nearest);
}`;

// Rasterize the albedo of the page at the resolution of the canvas, with the coverage of the
// raised elements in the alpha channel. Drawn once per scene, then read by every composite.
const albedoFragmentShader = `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform vec2 uHalf;
uniform float uRadius;
uniform vec3 uColor;
out vec4 fragColor;
${roundedBoxShader}
void main() {
  float d = roundedBox(gl_FragCoord.xy, uCenter, uHalf, uRadius);
  float coverage = clamp(0.5 - d, 0.0, 1.0);
  fragColor = vec4(uColor, 1.0) * coverage;
}`;

// One cascade level, merged with the level above it.
//
// Every texel of the target is one ray: the texture is split into a grid of sub images, one
// per direction, each holding the probes of the cascade. The ray is marched over the interval
// this level is responsible for, and what it did not resolve is filled in by interpolating
// the four directions of the level above that subdivide it.
const cascadeFragmentShader = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uUpper;
uniform sampler2D uBounced;
uniform vec2 uBase;
uniform int uCascade;
uniform float uInterval;
uniform vec4 uLight;
uniform vec3 uLightColor;
uniform vec3 uSky;
uniform float uHeight;
uniform float uBounce;
uniform bool uMerge;
out vec4 fragColor;

const float TAU = 6.283185307179586;
const float PI = 3.141592653589793;
// Rays step by at least this much, so that one grazing an element still terminates.
const float minStep = 0.75;
const float falloffPower = ${falloffPower.toFixed(3)};
const float lightLevel = ${lightLevel.toFixed(1)};
const int maxSteps = 96;

void main() {
  ivec2 texel = ivec2(gl_FragCoord.xy);
  int spacing = 1 << uCascade;
  ivec2 probes = ivec2(uBase) / spacing;
  // sub image the texel falls in, and the probe within it
  ivec2 corner = texel / probes;
  ivec2 probe = texel % probes;
  // directions are laid out on a side x side grid of sub images
  int side = 2 << uCascade;
  int direction = corner.y * side + corner.x;
  float angle = TAU * (float(direction) + 0.5) / float(side * side);
  vec2 ray = vec2(cos(angle), sin(angle));
  vec2 origin = (vec2(probe) + 0.5) * float(spacing);

  // Interval of this level. Levels start where the one below them stopped, and are four times
  // as long, so level i covers [uInterval * (4^i - 1) / 3, uInterval * (4^(i+1) - 1) / 3].
  float near = uInterval * (pow(4.0, float(uCascade)) - 1.0) / 3.0;
  float far = uInterval * (pow(4.0, float(uCascade) + 1.0) - 1.0) / 3.0;

  // The probe stands on the background, or on top of a raised element. Read without
  // filtering: a probe just inside the edge of an element must not be smoothed into standing
  // beside it, or it picks up the shadow lying there and draws a line along the edge.
  float elevation = texelFetch(uScene, ivec2(origin), 0).a < 0.0 ? uHeight : 0.0;
  // A ray leaving the probe towards the light climbs from the height of the probe to the
  // height of the light: this is the rate it climbs at, in height per base pixel travelled.
  // It is what turns flat footprints into shadows of a length, rather than endless streaks.
  float toLight = length(uLight.xy - origin);
  float climb = (uLight.z - elevation) / max(toLight, 1.0);

  // Half the angle the light covers, seen from the probe. A disc lying on the page would
  // wrap all the way around a probe standing on it, and the page would break into a lit disc
  // and a dimmer outside; this one hangs above the page instead, so its angle closes on a
  // right angle and there is no edge to it anywhere.
  float spread = atan(uLight.w / max(toLight, 1.0));
  // How much of this direction the light covers, worked out exactly rather than left to
  // whether the middle of the direction happens to land on it, which would otherwise show as
  // rings of directions catching the light and directions missing it.
  float toCenter = atan(uLight.y - origin.y, uLight.x - origin.x);
  float away = mod(angle - toCenter + PI, TAU) - PI;
  float wedge = PI / float(side * side);
  float covered = 0.0;
  // a probe standing under the light sees it all around, so the overlap is taken on the turn
  // before and the turn after as well
  for (int turn = -1; turn <= 1; turn++) {
    float from = away + float(turn) * TAU;
    covered += max(min(from + wedge, spread) - max(from - wedge, -spread), 0.0);
  }
  covered /= 2.0 * wedge;

  // The share of every direction the light covers adds up to the share of the whole circle it
  // covers, so making up for that share leaves a lit point with the brightness a light hanging
  // uLight.z above the page would give it, whichever level ends up catching it.
  float share = spread / PI;
  float above = max(uLight.z - elevation, 1.0);
  float falloff = pow(above * above / (above * above + toLight * toLight), falloffPower);
  vec3 sent = uLightColor * covered * falloff / share;

  // Which level catches the light. Handing it to whichever interval it falls in would draw a
  // ring wherever two levels disagree, as their probes stand in different places and are not
  // quite the same distance from it: instead the two levels either side of it share it, by
  // weights that always add up to one however the distance is measured.
  float level = clamp(log(1.0 + 3.0 * toLight / uInterval) / log(4.0), lightLevel, float(${cascadeCount} - 1) + 0.5);
  float weight = max(0.0, 1.0 - abs(level - float(uCascade) - 0.5));
  bool reaches = covered > 0.0 && weight > 0.0;

  vec3 radiance = vec3(0.0);
  float transmittance = 1.0;
  // A level either side of the one the distance falls in still takes a share of the light,
  // and tests it for shadow as far along as its own interval reaches.
  float end = reaches ? clamp(toLight, near, far) : far;
  float t = near;
  bool lit = false;

  for (int marched = 0; marched < maxSteps; marched++) {
    if (t >= end) {
      if (lit || !reaches) {
        break;
      }
      // Reached the light with nothing in the way. The light hangs above the page, so it
      // takes nothing away from the sky behind it: the ray carries on to the end of the
      // interval with what it had.
      radiance += transmittance * sent * weight;
      lit = true;
      end = far;
      continue;
    }

    vec2 p = origin + ray * t;
    vec2 uv = p / uBase;
    // Nothing stands outside the page: leave the scene in one step.
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
      t = end;
      continue;
    }

    vec4 scene = texture(uScene, uv);
    if (scene.a < 0.0) {
      float under = (uHeight - elevation - climb * t) / uHeight;
      if (under > 0.0) {
        // Blocked by the side of an element, which sends back the light it caught. A ray
        // passing just under the top of it is only grazed, and still sees most of the sky
        // over it: what it loses is how deeply it runs into the side.
        vec3 bounced = scene.rgb * texture(uBounced, uv).rgb * uBounce;
        radiance += transmittance * mix(uSky, bounced, min(under, 1.0));
        transmittance = 0.0;
        break;
      }
      // Over the top of it: step to the far side of the footprint.
      t += max(-scene.a, minStep);
    } else {
      t += max(scene.a, minStep);
    }
  }

  // What the ray did not resolve comes from the level above, or from the sky at the top.
  vec3 upper = uSky;
  if (uMerge) {
    ivec2 upperProbes = probes / 2;
    int upperSide = side * 2;
    // Position of this probe within the sparser grid of the level above.
    vec2 position = vec2(probe) * 0.5 - 0.25;
    vec2 fraction = fract(position);
    ivec2 corner2 = ivec2(floor(position));
    vec3 sum = vec3(0.0);

    for (int i = 0; i < 4; i++) {
      int child = direction * 4 + i;
      ivec2 subImage = ivec2(child % upperSide, child / upperSide) * upperProbes;
      for (int j = 0; j < 4; j++) {
        ivec2 offset2 = ivec2(j & 1, j >> 1);
        ivec2 at = clamp(corner2 + offset2, ivec2(0), upperProbes - 1);
        vec2 blend = mix(1.0 - fraction, fraction, vec2(offset2));
        sum += blend.x * blend.y * texelFetch(uUpper, subImage + at, 0).rgb;
      }
    }

    upper = sum * 0.25;
  }

  fragColor = vec4(radiance + transmittance * upper, 1.0);
}`;

// Average the four directions of every cascade 0 probe into the irradiance it receives.
const irradianceFragmentShader = `#version 300 es
precision highp float;
uniform sampler2D uCascade;
uniform vec2 uBase;
out vec4 fragColor;
void main() {
  ivec2 probe = ivec2(gl_FragCoord.xy);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    sum += texelFetch(uCascade, ivec2(i % 2, i / 2) * ivec2(uBase) + probe, 0).rgb;
  }
  fragColor = vec4(sum * 0.25, 1.0);
}`;

// Draw the page: its albedo, dimmed by the irradiance reaching it.
//
// Irradiance is solved on the base grid and read back here at the resolution of the canvas.
// A plain bilinear read would let the shadow lying next to a raised element bleed over its
// edge, so the four texels around a pixel are weighted by how well they match it: an element
// is lit by the probes standing on elements, the background by the ones standing on it.
const compositeFragmentShader = `#version 300 es
precision highp float;
uniform sampler2D uAlbedo;
uniform sampler2D uIrradiance;
uniform sampler2D uScene;
uniform vec2 uCanvas;
uniform vec2 uBase;
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uCanvas;
  vec4 albedo = texture(uAlbedo, uv);
  // The pixels along the edge of an element are only partly covered by it. They still belong
  // to one side or the other: left in between they would take some of the shadow lying
  // outside, and draw a line just inside every edge.
  float here = albedo.a > 0.5 ? 1.0 : 0.0;

  vec2 position = uv * uBase - 0.5;
  vec2 fraction = fract(position);
  ivec2 corner = ivec2(floor(position));
  vec3 sum = vec3(0.0);
  float total = 0.0;

  for (int i = 0; i < 4; i++) {
    ivec2 offset = ivec2(i & 1, i >> 1);
    ivec2 at = clamp(corner + offset, ivec2(0), ivec2(uBase) - 1);
    vec2 weight = mix(1.0 - fraction, fraction, vec2(offset));
    float raised = texelFetch(uScene, at, 0).a < 0.0 ? 1.0 : 0.0;
    float matches = raised == here ? 1.0 : 0.04;
    float w = weight.x * weight.y * matches + 1e-4;
    sum += w * texelFetch(uIrradiance, at, 0).rgb;
    total += w;
  }

  fragColor = vec4(albedo.rgb * (sum / total), 1.0);
}`;

/**
 * Compile a shader, throwing on a compilation error.
 * @param {WebGL2RenderingContext} gl
 * @param {number} type
 * @param {string} source
 * @returns {WebGLShader}
 */
function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`Shader failed to compile: ${gl.getShaderInfoLog(shader)}`);
  }

  return shader;
}

/**
 * Link a program from a fragment shader and the shared vertex shader, and collect the
 * locations of its uniforms.
 * @param {WebGL2RenderingContext} gl
 * @param {string} fragmentSource
 * @returns {{program: WebGLProgram, uniforms: Object<string, WebGLUniformLocation>}}
 */
function createProgram(gl, fragmentSource) {
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, quadVertexShader));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.bindAttribLocation(program, 0, 'aPos');
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Program failed to link: ${gl.getProgramInfoLog(program)}`);
  }

  const uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const { name } = gl.getActiveUniform(program, i);
    uniforms[name] = gl.getUniformLocation(program, name);
  }

  return { program, uniforms };
}

/**
 * Create a texture, and the framebuffer rendering into it.
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} height
 * @param {number} internalFormat
 * @param {number} type
 * @param {number} filter
 * @returns {{texture: WebGLTexture, framebuffer: WebGLFramebuffer, width: number, height: number}}
 */
function createTarget(gl, width, height, internalFormat, type, filter) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, gl.RGBA, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error('Framebuffer is incomplete.');
  }

  return { texture, framebuffer, width, height };
}

/**
 * Size of the base grid, the probe grid of cascade 0, covering a canvas of the given size.
 * Both sides are rounded to a multiple of the number of times the grid is halved, so that
 * every cascade lands on whole probes. The rounding leaves the grid slightly off the
 * proportions of the canvas, which only shows as rays measuring distance along one axis by up
 * to a few percent more than along the other.
 * @param {number} width canvas width, in pixels
 * @param {number} height canvas height, in pixels
 * @returns {{width: number, height: number}} size of the base grid
 */
function baseSize(width, height) {
  const longest = Math.max(width, height);
  const target = Math.min(maxBaseSize, Math.max(minBaseSize, Math.round(longest * baseScale)));
  const scale = target / longest;
  const round = (size) => Math.max(baseAlignment, Math.round((size * scale) / baseAlignment) * baseAlignment);

  return { width: round(width), height: round(height) };
}

/**
 * Start a radiance cascades renderer on a canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {object} scene see setScene()
 * @param {object} config
 * @param {{halfWidth: number, halfHeight: number}} config.extent half extent of the scene the canvas frames
 * @param {number} config.height height of the raised elements, in scene units
 * @param {number[]} config.lightPosition [x, y, z] of the light, in scene units
 * @param {number} config.lightSize radius of the light, in scene units
 * @param {number} config.lightVal brightness of the light, between 0 and 1
 * @returns {object|null} the renderer, or null if the browser cannot run it
 */
function makeRadianceCascades(canvas, scene, config) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'low-power',
  });

  if (!gl) {
    console.warn('rtx-on: WebGL2 is not available.');
    return null;
  }

  // Radiance is accumulated in floating point targets, and the distance field needs the range
  // and the linear filtering that come with them.
  if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
    console.warn('rtx-on: floating point render targets are not available.');
    return null;
  }

  const { halfWidth, halfHeight } = config.extent;
  const base = baseSize(canvas.width, canvas.height);
  // Scene units to base pixels. Positions convert along their own axis, lengths with the
  // average of the two, as the scene only has one of them.
  const scaleX = base.width / (2 * halfWidth);
  const scaleY = base.height / (2 * halfHeight);
  const scale = Math.sqrt(scaleX * scaleY);
  const toBaseX = (x) => (x + halfWidth) * scaleX;
  const toBaseY = (y) => (y + halfHeight) * scaleY;

  const float16 = gl.HALF_FLOAT;
  const targets = {
    scene: createTarget(gl, base.width, base.height, gl.RGBA16F, float16, gl.LINEAR),
    albedo: createTarget(gl, canvas.width, canvas.height, gl.RGBA8, gl.UNSIGNED_BYTE, gl.LINEAR),
    // Cascades all hold the same number of rays: probes shrink by four as directions grow by
    // four, so a level always fits in a grid twice the size of the base grid.
    cascades: [
      createTarget(gl, 2 * base.width, 2 * base.height, gl.RGBA16F, float16, gl.NEAREST),
      createTarget(gl, 2 * base.width, 2 * base.height, gl.RGBA16F, float16, gl.NEAREST),
    ],
    // Irradiance of the current frame, and of the one before it, which the rays read to know
    // how much light the sides of the raised elements bounce back.
    irradiance: [
      createTarget(gl, base.width, base.height, gl.RGBA16F, float16, gl.LINEAR),
      createTarget(gl, base.width, base.height, gl.RGBA16F, float16, gl.LINEAR),
    ],
  };

  for (const { framebuffer } of targets.irradiance) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  const programs = {
    scene: createProgram(gl, sceneFragmentShader),
    albedo: createProgram(gl, albedoFragmentShader),
    cascade: createProgram(gl, cascadeFragmentShader),
    irradiance: createProgram(gl, irradianceFragmentShader),
    composite: createProgram(gl, compositeFragmentShader),
  };

  const quad = gl.createVertexArray();
  gl.bindVertexArray(quad);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // The raised elements, as two texels each: their rectangle, then their color and radius.
  const elementsTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, elementsTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Longest ray the hierarchy has to cover, so that a probe anywhere on the page can see the
  // whole of it, split into the interval of cascade 0.
  const diagonal = Math.hypot(base.width, base.height);
  const interval = Math.max(1, (3 * diagonal) / (4 ** cascadeCount - 1));
  const height = config.height * scale;
  const lightColor = [1, 1, 1].map((channel) => channel * config.lightVal * lightStrength);
  const sky = [1, 1, 1].map((channel) => channel * config.lightVal * skyStrength);

  let elements = [];
  let background = [1, 1, 1];
  let light = [0, 0, 0, 1];
  let frame = 0;
  let animation = 0;

  /**
   * Draw the bound program over a rectangle of the bound target, in clip space.
   */
  function draw(uniforms, x0 = -1, y0 = -1, x1 = 1, y1 = 1) {
    gl.uniform4f(uniforms.uRect, x0, y0, x1, y1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * Bind a texture to a texture unit, and point a sampler uniform at it.
   */
  function bind(uniform, texture, unit) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(uniform, unit);
  }

  /**
   * Bind a target for drawing into.
   */
  function target({ framebuffer, width, height: h }) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, width, h);
  }

  /**
   * Rasterize the scene: the distance field the rays march through, and the albedo of the
   * page at the resolution of the canvas. Only needed when the scene changes.
   */
  function rasterize() {
    const data = new Float32Array(Math.max(1, elements.length) * 8);
    elements.forEach((element, i) => {
      data.set([
        toBaseX(element.center[0]),
        toBaseY(element.center[1]),
        element.half[0] * scaleX,
        element.half[1] * scaleY,
        ...element.color,
        element.radius * scale,
      ], i * 8);
    });

    gl.bindTexture(gl.TEXTURE_2D, elementsTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, Math.max(2, elements.length * 2), 1, 0, gl.RGBA, gl.FLOAT, data);

    const { program, uniforms } = programs.scene;
    gl.useProgram(program);
    target(targets.scene);
    bind(uniforms.uElements, elementsTexture, 0);
    gl.uniform1i(uniforms.uCount, elements.length);
    gl.uniform3fv(uniforms.uBackground, background);
    draw(uniforms);

    rasterizeAlbedo();
  }

  /**
   * Rasterize the albedo of the page: the background, then every raised element over it.
   */
  function rasterizeAlbedo() {
    const { program, uniforms } = programs.albedo;
    gl.useProgram(program);
    target(targets.albedo);
    gl.clearColor(background[0], background[1], background[2], 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Elements are drawn with their coverage in alpha, so their rounded corners come out
    // smooth rather than stepped.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const scaleCanvasX = canvas.width / (2 * halfWidth);
    const scaleCanvasY = canvas.height / (2 * halfHeight);
    const scaleCanvas = Math.sqrt(scaleCanvasX * scaleCanvasY);

    for (const element of elements) {
      gl.uniform2f(uniforms.uCenter,
        (element.center[0] + halfWidth) * scaleCanvasX,
        (element.center[1] + halfHeight) * scaleCanvasY);
      gl.uniform2f(uniforms.uHalf, element.half[0] * scaleCanvasX, element.half[1] * scaleCanvasY);
      gl.uniform1f(uniforms.uRadius, element.radius * scaleCanvas);
      gl.uniform3fv(uniforms.uColor, element.color);
      // only rasterize over the part of the canvas the element covers
      const clamped = (value) => Math.min(1, Math.max(-1, value));
      draw(uniforms,
        clamped((element.center[0] - element.half[0]) / halfWidth),
        clamped((element.center[1] - element.half[1]) / halfHeight),
        clamped((element.center[0] + element.half[0]) / halfWidth),
        clamped((element.center[1] + element.half[1]) / halfHeight));
    }

    gl.disable(gl.BLEND);
  }

  /**
   * Solve the radiance field and draw the page with it.
   */
  function render() {
    const bounced = targets.irradiance[frame % 2];
    const solved = targets.irradiance[(frame + 1) % 2];

    // Cascades are solved from the top down, each one merging what the level above resolved,
    // so the hierarchy only ever needs the two targets it ping pongs between.
    const { program, uniforms } = programs.cascade;
    gl.useProgram(program);
    bind(uniforms.uScene, targets.scene.texture, 0);
    bind(uniforms.uBounced, bounced.texture, 1);
    gl.uniform2f(uniforms.uBase, base.width, base.height);
    gl.uniform1f(uniforms.uInterval, interval);
    gl.uniform4fv(uniforms.uLight, light);
    gl.uniform3fv(uniforms.uLightColor, lightColor);
    gl.uniform3fv(uniforms.uSky, sky);
    gl.uniform1f(uniforms.uHeight, height);
    gl.uniform1f(uniforms.uBounce, bounceStrength);

    for (let cascade = cascadeCount - 1; cascade >= 0; cascade--) {
      const into = targets.cascades[cascade % 2];
      const from = targets.cascades[(cascade + 1) % 2];
      target(into);
      gl.uniform1i(uniforms.uCascade, cascade);
      gl.uniform1i(uniforms.uMerge, cascade < cascadeCount - 1 ? 1 : 0);
      bind(uniforms.uUpper, from.texture, 2);
      draw(uniforms);
    }

    {
      const { program: p, uniforms: u } = programs.irradiance;
      gl.useProgram(p);
      target(solved);
      bind(u.uCascade, targets.cascades[0].texture, 0);
      gl.uniform2f(u.uBase, base.width, base.height);
      draw(u);
    }

    {
      const { program: p, uniforms: u } = programs.composite;
      gl.useProgram(p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      bind(u.uAlbedo, targets.albedo.texture, 0);
      bind(u.uIrradiance, solved.texture, 1);
      bind(u.uScene, targets.scene.texture, 2);
      gl.uniform2f(u.uCanvas, canvas.width, canvas.height);
      gl.uniform2f(u.uBase, base.width, base.height);
      draw(u);
    }

    frame++;
  }

  /**
   * Render until the bounced light has settled, then stop: the scene does not move on its
   * own, so there is nothing to redraw until the page changes.
   */
  function loop() {
    animation = 0;
    render();
    if (frame < convergeFrames) {
      animation = requestAnimationFrame(loop);
    }
  }

  /**
   * Solve the scene again from the next frame on.
   */
  function resume() {
    frame = 0;
    if (!animation) {
      animation = requestAnimationFrame(loop);
    }
  }

  /**
   * Stop rendering. The canvas keeps showing the last frame drawn.
   */
  function pause() {
    cancelAnimationFrame(animation);
    animation = 0;
  }

  /**
   * Replace the scene.
   * @param {object} next
   * @param {number[]} next.background color of the background, as [red, green, blue]
   * @param {Array<{center: number[], half: number[], radius: number, color: number[]}>} next.elements
   *   raised elements, in scene units
   */
  function setScene(next) {
    background = next.background;
    elements = next.elements;
    rasterize();
    resume();
  }

  /**
   * Move the light.
   * @param {number[]} position [x, y, z] in scene units
   */
  function setLightPosition(position) {
    light = [toBaseX(position[0]), toBaseY(position[1]), position[2] * scale, config.lightSize * scale];
    resume();
  }

  setLightPosition(config.lightPosition);
  setScene(scene);

  return { setScene, setLightPosition, resume, pause };
}

export { makeRadianceCascades };
