import {makePathTracer, Cube} from 'webgl-path-tracing';
import { Vector } from 'sylvester';

// Height of the elements
const zHeight = 0.1;

function closestPowerOfTwo(num) {
  // If num is already a power of two, return num
  if ((num & (num - 1)) === 0) {
    return num;
  }

  // Find the nearest power of two greater than num
  let power = 1;
  while (power < num) {
    power *= 2;
  }

  return power;
}

/**
 * Extract background color (stored as data attribute) of element as RGB array.
 * Only supports rgb() syntax
 * If cannot extract colors, will return white.
 * @param {HTMLElement} element 
 * @returns 
 */
function extractRGBColor(element) {
	const color = element.dataset.backgroundColor || window.getComputedStyle(element).backgroundColor;
	if(color.startsWith('rgb')) {
		const rgb = color.match(/(\d+)/g);
		return [parseInt(rgb[0]) / 255, parseInt(rgb[1]) / 255, parseInt(rgb[2]) / 255];
	} else {
		console.error(`Unsupported color format. Only rgb() is supported. returning white. Received ${color}.`);
		return [1, 1, 1];
	}
}

// Remove background color and box shadow from element
function removeStyle(element) {
	
	// store original box shadow in a data attribute
	element.dataset.boxShadow = window.getComputedStyle(element).boxShadow;
	element.style.boxShadow = 'none';

	// store original background color in a data attribute
	element.dataset.backgroundColor = window.getComputedStyle(element).backgroundColor;
	element.style.backgroundColor = 'transparent';

	// if element has white background,
	// set mix-blend-mode: multiply so that any white children blends nicely with the (now potentially gray) background
	// TODO: Should we do that more often?
	if(element.dataset.backgroundColor === 'rgb(255, 255, 255)') {
		element.style.mixBlendMode = 'multiply';
	}
}

function makeScene(background, elements) {
	const zBase = 0; // -1 is room wall.
  var objects = [];
  let nextObjectId = 0;

	// background element
	objects.push(new Cube(Vector.create([-1, -1, zBase - 1 ]), Vector.create([1, 1, zBase]), nextObjectId++, Vector.create(extractRGBColor(background))));

	for (let el = 0; el < elements.length; el++) {
		let rect = elements[el].getBoundingClientRect();
		// ignore elements that have no height or width
		if(rect.height === 0 || rect.width === 0) continue;

		// TODO: should we also handle scroll position?
		let minCorner = Vector.create([
			2 * rect.left / (background.clientWidth) - 1,
			-1 * (2 * (rect.top + rect.height) / (background.clientHeight) - 1),

			zBase,
		]);

		let maxCorner = Vector.create([
			2 * (rect.left + rect.width) / (background.clientWidth) - 1,
			-1 * (2 * rect.top / (background.clientHeight) - 1),
			zHeight + zBase,
		]);

		objects.push(new Cube(minCorner, maxCorner, nextObjectId++, Vector.create(extractRGBColor(elements[el]))));
	}

  return objects;
}

/**
 * 
 * @param {HTMLElement} background : element to apply the effect to, defaults to the entire body.
 * @param {HTMLElement} raised[]: elevated elements, defaults to children of the background element if one is passed or to children of the body if none.
 */
function on({background, raised} = {}) {
	let elements;
	if(raised) {
		elements = raised;
	} else {
		if(background) {
			elements = background.children;
		} else {
			elements = document.body.children;
		}
	}

	if(!background) {
		// use <body> if bigger than viewport. Otherwise, use <html>, which is equal to viewport height
		if(document.documentElement.clientHeight > document.body.clientHeight) {
			background = document.documentElement;
			// if body has a background color, set it on body too
			if(window.getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)') {
				background.style.backgroundColor = window.getComputedStyle(document.body).backgroundColor;
			}

		} else {
			background = document.body;
			// if html has a background color, set it on body too
			if(window.getComputedStyle(document.documentElement).backgroundColor !== 'rgba(0, 0, 0, 0)') {
				background.style.backgroundColor = window.getComputedStyle(document.documentElement).backgroundColor;
			}
		}

	}

	// remove drop shadow and background color from elements, store them in data attributes
	[...elements, background].map(removeStyle);

	// canvas must be square and of power of two
	// use the element largest width / height and round it up to the next power of two
	let size = closestPowerOfTwo(Math.max(background.clientWidth, background.clientHeight));

	const backgroundCanvas = document.createElement('canvas');
	backgroundCanvas.inert = true;
	backgroundCanvas.width = size;
	backgroundCanvas.height = size;
	backgroundCanvas.style.position = 'absolute';
	backgroundCanvas.style.top = '0';
	backgroundCanvas.style.left = '0';
	backgroundCanvas.style.width = `${background.clientWidth}px`;
	backgroundCanvas.style.height = `${background.clientHeight}px`;
	backgroundCanvas.style.zIndex = '-1';
	background.appendChild(backgroundCanvas);

	const config = {
		zoom: 76,
		fov: 1.5,
		lightPosition: [0.8, 0.8, 0.8],
	}

	const ui = makePathTracer(backgroundCanvas, makeScene(background, elements), config, false);

	// listen for resize on the base element or any scene element
	const resizeObserver = new ResizeObserver(() => {
			ui.setObjects(makeScene(background, elements));
			backgroundCanvas.style.width = `${background.clientWidth}px`;
			backgroundCanvas.style.height = `${background.clientHeight}px`;
			// TODO: if element changes size, we could create a bigger / smaller canvas.
	});
	resizeObserver.observe(background);
	for(let el of elements) {
		resizeObserver.observe(el);
	}
}

export {on};
