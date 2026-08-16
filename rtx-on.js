import { makePathTracer, Cube } from 'webgl-path-tracing';
import { Vector } from 'sylvester';

// Height of the raised elements, in scene units.
const zHeight = 0.1;
// Z coordinate of the background plane (-1 is the room wall).
const zBase = 0;
// Time to make the effect appear.
const opacityTransition = '0.5s';
// Pause the renderer after this period of inactivity (in ms).
const pauseAfter = 10 * 1000;

// Camera. The field of view and this zoom, the distance of the camera to the scene, are
// picked so that a square canvas frames exactly [-1, 1] on both axes.
const squareZoom = 76;
const fov = 1.5;

const lightElevation = 1.5;
// Light position, normalized between -1 and 1 within the background element.
// Scaled to the extent of the scene to get scene coordinates.
const defaultLightPosition = [0.75, 0.75, lightElevation];
const lightSize = 0.75;
const lightValLightMode = 0.6;
const lightValDarkMode = 0.15;

// Computed value of a fully transparent color, and the color used as fallback.
const transparent = 'rgba(0, 0, 0, 0)';
const white = [1, 1, 1];

const rtxGreen = '#76b900';

// Largest dimension of the canvas, in pixels. Bigger elements are rendered into a
// smaller canvas that CSS scales back up.
// TODO: adjust this based some hardware capabilities?
// navigator.deviceMemory
// GPUSupportedLimits ?
const maxSize = 2048;

let initialized = false;
let enabled = false;
let backgroundElement;
let backgroundCanvas;
let raisedElements = [];
let ui;
let lightVal;
let lightPosition = [...defaultLightPosition];
let pauseTimer;

/**
 * Size of the canvas drawing buffer for a background element of the given size.
 * The path tracer renders at any canvas size, so the buffer covers the element pixel for
 * pixel, and is only scaled down, preserving the aspect ratio, when its largest side would
 * exceed maxSize. Sizes come from getBoundingClientRect() and can be fractional: a canvas can
 * only be an integer number of pixels wide.
 * @param {DOMRect} rect size of the background element
 * @returns {{width: number, height: number}} size of the drawing buffer, in pixels
 */
function canvasSize({ width, height }) {
  const scale = Math.min(window.devicePixelRatio || 1, maxSize / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * How much of the scene the background element covers, and the matching camera zoom.
 * The path tracer keeps the vertical field of view of its camera and widens the horizontal one
 * to match the aspect ratio of the canvas, and it renders inside a room, a cube spanning
 * [-1, 1] on every axis. So the scene is normalized to [-1, 1] along the largest side of the
 * element, to keep it within the room, and the camera is moved closer by as much so that the
 * element still fills the canvas. The scene then has the proportions of the element: shadows
 * are no longer squashed the way they were on a square canvas stretched by CSS.
 * @param {DOMRect} rect size of the background element
 * @returns {{halfWidth: number, halfHeight: number, zoom: number}} half extent of the scene, and camera zoom
 */
function sceneExtent({ width, height }) {
  const aspect = height > 0 ? width / height : 1;
  const scale = Math.max(1, aspect);

  return {
    halfWidth: aspect / scale,
    halfHeight: 1 / scale,
    zoom: squareZoom / scale,
  };
}

/**
 * Position of the light in scene coordinates.
 * @param {DOMRect} rect size of the background element
 * @returns {number[]} [x, y, z]
 */
function sceneLightPosition(rect) {
  const { halfWidth, halfHeight } = sceneExtent(rect);
  const [x, y, z] = lightPosition;

  return [x * halfWidth, y * halfHeight, z];
}

/**
 * Extract the background color of an element as an RGB array.
 * Uses the color stored as a data attribute by removeStyle() when present.
 * Only supports the rgb() syntax, returns white for anything else.
 * @param {HTMLElement} element
 * @returns {number[]} [red, green, blue], each between 0 and 1
 */
function extractRGBColor(element) {
  const color = element.dataset.backgroundColor || window.getComputedStyle(element).backgroundColor;

  if (color === transparent) {
    return [...white];
  }

  const channels = color.match(/\d+/g);
  if (!color.startsWith('rgb') || !channels || channels.length < 3) {
    console.error(`Unsupported color format. Only rgb() is supported. returning white. Received ${color}.`);
    return [...white];
  }

  return channels.slice(0, 3).map((channel) => Number(channel) / 255);
}

/**
 * Remove the background color and box shadow of an element, storing them as data attributes.
 * @param {HTMLElement} element
 */
function removeStyle(element) {
  element.style.transition = `box-shadow ${opacityTransition} ease-in-out 0.2s, background-color ${opacityTransition} ease-in-out 0.2s`;

  const { boxShadow, backgroundColor, mixBlendMode } = window.getComputedStyle(element);

  element.dataset.boxShadow = boxShadow;
  element.style.boxShadow = 'none';

  element.dataset.backgroundColor = backgroundColor;
  element.style.backgroundColor = 'transparent';

  // if element has white background,
  // set mix-blend-mode: multiply so that any white children blends nicely with the (now potentially gray) background
  // TODO: Should we do that more often?
  if (backgroundColor === 'rgb(255, 255, 255)') {
    element.dataset.mixBlendMode = mixBlendMode;
    element.style.mixBlendMode = 'multiply';
  }
}

/**
 * Restore the styles saved by removeStyle().
 * @param {HTMLElement} element
 */
function restoreStyle(element) {
  const { boxShadow, backgroundColor, mixBlendMode } = element.dataset;

  if (boxShadow) {
    element.style.boxShadow = boxShadow;
  }
  if (backgroundColor) {
    element.style.backgroundColor = backgroundColor;
  }
  if (mixBlendMode) {
    element.style.mixBlendMode = mixBlendMode;
  }
}

/**
 * Build the scene: the background plane, plus one cube per raised element.
 * @param {HTMLElement} background
 * @param {Iterable<HTMLElement>} elements raised elements
 * @returns {Cube[]} the objects of the scene
 */
function makeScene(background, elements) {
  const backgroundRect = background.getBoundingClientRect();
  const { halfWidth, halfHeight } = sceneExtent(backgroundRect);
  let nextObjectId = 0;

  // Background element, covering the entire floor of the room.
  // For now, always make it white, for a better effect.
  // TODO: Retain the hue
  const objects = [
    new Cube(
      Vector.create([-1, -1, zBase - 1]),
      Vector.create([1, 1, zBase]),
      nextObjectId++,
      Vector.create([...white]),
    ),
  ];

  // Viewport coordinates, normalized to the extent of the scene within the background element.
  // TODO: should we also handle scroll position?
  const toSceneX = (x) => halfWidth * ((2 * (x - backgroundRect.left)) / backgroundRect.width - 1);
  const toSceneY = (y) => halfHeight * (1 - (2 * (y - backgroundRect.top)) / backgroundRect.height);

  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    // ignore elements that have no height or width
    if (rect.height === 0 || rect.width === 0) {
      continue;
    }

    objects.push(new Cube(
      Vector.create([toSceneX(rect.left), toSceneY(rect.bottom), zBase]),
      Vector.create([toSceneX(rect.right), toSceneY(rect.top), zBase + zHeight]),
      nextObjectId++,
      Vector.create(extractRGBColor(element)),
    ));
  }

  return objects;
}

/**
 * Return all elements that have a box shadow and are descendants of the passed element
 * @param {HTMLElement} element
 * @returns {HTMLElement[]} all elements with box shadow
 */
function getBoxShadowDescendants(element) {
  return [...element.querySelectorAll('*')]
    .filter((descendant) => window.getComputedStyle(descendant).boxShadow !== 'none');
}

/**
 * Size and position the canvas so that it covers the background element.
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} element background element
 * @param {boolean} [startDisplayed] when false, the canvas starts hidden and fades in
 */
function styleCanvas(canvas, element, startDisplayed = false) {
  const rect = element.getBoundingClientRect();
  const { borderTopWidth, borderLeftWidth } = window.getComputedStyle(element);

  // the canvas can be of any size, so give it the size of the element it covers
  const { width, height } = canvasSize(rect);

  canvas.inert = true;
  // only assign when the size actually changes: assigning resets the drawing buffer
  if (canvas.width !== width) {
    canvas.width = width;
  }
  if (canvas.height !== height) {
    canvas.height = height;
  }

  Object.assign(canvas.style, {
    position: 'absolute',
    // offset the position of the canvas by the border width
    // See examples/inside.html to understand why this is needed
    top: `-${borderTopWidth}`,
    left: `-${borderLeftWidth}`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    zIndex: '-1',
    overflow: 'hidden',
  });

  if (!startDisplayed) {
    canvas.style.opacity = '0';
    canvas.style.transition = `opacity ${opacityTransition} ease-in-out`;
  }
}

/**
 * Pause the renderer once the scene has been left untouched for a while.
 */
function schedulePause() {
  clearTimeout(pauseTimer);
  pauseTimer = setTimeout(() => ui.renderer.pause(), pauseAfter);
}

/**
 * Start the path tracer on the current canvas.
 */
function startPathTracer() {
  const rect = backgroundElement.getBoundingClientRect();
  const config = {
    zoom: sceneExtent(rect).zoom,
    fov,
    lightPosition: sceneLightPosition(rect),
    lightSize,
    lightVal,
  };

  ui = makePathTracer(backgroundCanvas, makeScene(backgroundElement, raisedElements), config, false);
  schedulePause();
}

/**
 * Release the WebGL context of a canvas that is about to be dropped: browsers only allow
 * a handful of live contexts, and a lost one is reclaimed right away.
 * @param {HTMLCanvasElement} canvas
 */
function releaseContext(canvas) {
  for (const type of ['webgl2', 'webgl', 'experimental-webgl']) {
    // returns the existing context, or null if the canvas was not initialized with that type
    const gl = canvas.getContext(type);
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/**
 * Restart the path tracer on a brand new canvas.
 * The renderer bakes the size of the drawing buffer into its shaders and its accumulation
 * textures, and the WebGL viewport of a context is fixed when the context is created, so a
 * canvas whose size changed cannot be reused.
 */
function restartPathTracer() {
  const previousCanvas = backgroundCanvas;

  backgroundCanvas = document.createElement('canvas');
  styleCanvas(backgroundCanvas, backgroundElement, true);
  // keep the visibility of the canvas being replaced, to avoid flashing the effect back on
  backgroundCanvas.style.opacity = previousCanvas.style.opacity;
  backgroundElement.appendChild(backgroundCanvas);

  startPathTracer();
  if (!enabled) {
    ui.renderer.pause();
  }

  // drop the canvas being replaced only once the new one has had a frame to render into,
  // so that the swap never shows an empty canvas
  window.requestAnimationFrame(() => {
    releaseContext(previousCanvas);
    previousCanvas.remove();
  });
}

/**
 * Rebuild and render the scene, for example after the page was resized.
 */
function reset() {
  const { width, height } = canvasSize(backgroundElement.getBoundingClientRect());
  if (width !== backgroundCanvas.width || height !== backgroundCanvas.height) {
    restartPathTracer();
    return;
  }

  ui.setObjects(makeScene(backgroundElement, raisedElements));
  if (enabled) {
    ui.renderer.resume();
  }
  styleCanvas(backgroundCanvas, backgroundElement, true);
  schedulePause();
}

/**
 * Rebuild the scene when the background element or any raised element is resized.
 * Rebuilding is immediate, so that the effect follows the layout: a ResizeObserver already
 * reports at most once per animation frame, however many changes went into that frame.
 */
function observeResize() {
  const resizeObserver = new ResizeObserver(reset);
  resizeObserver.observe(backgroundElement);
  for (const element of raisedElements) {
    resizeObserver.observe(element);
  }
}

/**
 * Move the light under the cursor when clicking on the background element.
 */
function enableMoveLightOnClick() {
  backgroundElement.addEventListener('click', (event) => {
    // ignore links, and clicks that only end a text selection
    if (event.target.tagName === 'A' || window.getSelection().toString()) {
      return;
    }

    // get click coordinates, normalized between -1 and 1
    const rect = backgroundElement.getBoundingClientRect();
    const x = (2 * (event.clientX - rect.left)) / rect.width - 1;
    const y = 1 - (2 * (event.clientY - rect.top)) / rect.height;

    // stored normalized, so that the light stays under the cursor when the page is resized
    lightPosition = [x, y, lightElevation];
    ui.setLightPosition(sceneLightPosition(rect));
    reset();
  });
}

/**
 * Reload the page when switching between light and dark mode:
 * the light intensity is picked once, when the effect starts.
 * @param {MediaQueryList} [darkModeQuery]
 */
function observeColorScheme(darkModeQuery) {
  darkModeQuery?.addEventListener('change', () => window.location.reload());
}

/**
 * If the current device supports the Compute Pressure API, use it to disable the effect
 * under 'critical' and 'serious' pressure.
 */
function observePressure() {
  if (!('PressureObserver' in window)) {
    return;
  }

  const observer = new PressureObserver((records) => {
    const state = records.at(-1)?.state;
    if (state === 'critical' || state === 'serious') {
      console.log(`RTX automatically turned off due to ${state} pressure on the CPU.`);
      off();
    }
  });
  observer.observe('cpu');
}

/**
 * Set up the effect: pick the background and raised elements, then start the path tracer.
 * @param {object} [options]
 * @param {HTMLElement} [options.background] element to apply the effect to, defaults to the entire body.
 * @param {HTMLElement[]} [options.raised] elevated elements, defaults to descendants of the background element with box shadow.
 * @param {boolean} [options.disableIfDarkMode] if true, will not apply the effect if the user has dark mode enabled, which dims the light of rtx-on. Defaults to false.
 * @param {boolean} [options.forceLightMode] if true, the effect will always apply at light mode. Defaults to false. Set to true if your website doesn't implement dark mode.
 * @param {boolean} [options.moveLightOnClick] Set to true to move the light under the cursor when clicking the background element. Default to false.
 * @returns {boolean} whether the effect was set up
 */
function initRTX({ background, raised, disableIfDarkMode = false, forceLightMode = false, moveLightOnClick = false } = {}) {
  // Check dark mode
  const darkModeQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
  const darkMode = darkModeQuery?.matches ?? false;

  if (darkMode && disableIfDarkMode) {
    console.warn('Not applying RTX, user has dark mode enabled.');
    return false;
  }
  lightVal = darkMode && !forceLightMode ? lightValDarkMode : lightValLightMode;

  if (background) {
    backgroundElement = background;
  } else {
    // select the <html> element.
    backgroundElement = document.documentElement;
    // The <html> element might be smaller than the viewport. So we make sure it is at least as big as the viewport.
    backgroundElement.style.minHeight = '100vh';
    // if <body> has a background color, set it on <html> too
    const bodyBackgroundColor = window.getComputedStyle(document.body).backgroundColor;
    if (bodyBackgroundColor !== transparent) {
      backgroundElement.style.backgroundColor = bodyBackgroundColor;
    }
  }

  raisedElements = raised ?? getBoxShadowDescendants(backgroundElement);

  // The canvas can be of any size, but the height of the raised elements and the elevation of
  // the light are fixed in scene units, and the scene shrinks along the smallest side of the
  // background element: extreme aspect ratios would make the elements look like towers.
  // So if height is more than 3x width or width is more than 3x height, skip
  const { width, height } = backgroundElement.getBoundingClientRect();
  if (height > width * 3 || width > height * 3) {
    console.warn(`Not applying RTX, background element is too wide or too tall. height: ${height}, width: ${width}`);
    return false;
  }

  // set position to relative in order to attach the canvas with position absolute
  backgroundElement.style.position = 'relative';

  backgroundCanvas = document.createElement('canvas');
  styleCanvas(backgroundCanvas, backgroundElement);
  backgroundElement.appendChild(backgroundCanvas);

  startPathTracer();
  backgroundCanvas.style.opacity = '1';

  observeResize();
  if (moveLightOnClick) {
    enableMoveLightOnClick();
  }
  observeColorScheme(darkModeQuery);
  observePressure();

  initialized = true;
  return true;
}

/**
 * Turn on the ray traced shadow effect.
 * Removes any existing box shadow effect.
 * @param {object} [options] see initRTX(), only used the first time the effect is turned on.
 */
function on(options) {
  if (!initialized) {
    if (!initRTX(options)) {
      return;
    }
  } else {
    // unhide canvas
    ui.renderer.resume();
    backgroundCanvas.style.opacity = '1';
  }
  enabled = true;

  // remove drop shadow and background color from elements, store them in data attributes
  for (const element of [...raisedElements, backgroundElement]) {
    removeStyle(element);
  }
}

/**
 * Turn off the ray traced shadow effect.
 * Restores any existing box shadow effect.
 */
function off() {
  if (!initialized) {
    return;
  }

  enabled = false;

  // hide canvas
  backgroundCanvas.style.opacity = '0';

  // restore original styles
  for (const element of [...raisedElements, backgroundElement]) {
    restoreStyle(element);
  }

  ui.renderer.pause();
}

/**
 * Displays an "RTX OFF / ON" button on the page.
 * Mainly for fun.
 * @param {object} [options] see initRTX(), passed to on() when toggling the effect back on.
 */
function button(options) {
  // The checkbox itself is hidden, its label is the visible button.
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = 'rtxCheckbox';
  checkbox.checked = true;
  checkbox.style.display = 'none';

  const label = document.createElement('label');
  label.htmlFor = checkbox.id;
  label.id = 'rtxLabel';
  Object.assign(label.style, {
    fontFamily: 'Arial, sans-serif',
    fontSize: '16px',
    padding: '15px 32px',
    textAlign: 'center',
    display: 'inline-block',
    cursor: 'pointer',
    // Set a fixed width and position the label at the bottom right
    width: '100px',
    position: 'fixed',
    bottom: '20px',
    right: '0',
  });

  const render = (isOn) => {
    label.innerHTML = `RTX <strong>${isOn ? 'ON' : 'OFF'}</strong>`;
    label.style.backgroundColor = isOn ? rtxGreen : 'black';
    label.style.color = isOn ? 'black' : 'white';
  };
  render(checkbox.checked);

  // Toggle the RTX state when the checkbox changes
  checkbox.addEventListener('change', () => {
    render(checkbox.checked);
    if (checkbox.checked) {
      on(options);
    } else {
      off();
    }
    console.log(`RTX is ${checkbox.checked ? 'on' : 'off'}.`);
  });

  document.body.append(checkbox, label);
}

export { on, off, button };
