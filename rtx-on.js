import {makePathTracer, Cube} from 'webgl-path-tracing';
import { Vector } from 'sylvester';

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

function makeScene(element, elements) {
	const zBase = -1;
  var objects = [];
  let nextObjectId = 0;

	// background element
	objects.push(new Cube(Vector.create([-1, -1, zBase]), Vector.create([1, 1, zBase - 1]), nextObjectId++));

	for (let el = 0; el < elements.length; el++) {
		let rect = elements[el].getBoundingClientRect();
		// ignore elements that have no height or width
		if(rect.height === 0 || rect.width === 0) continue;

		// FIXME: handle scroll position
		let minCorner = Vector.create([
			2 * rect.left / (element.clientWidth) - 1,
			-1 * 2 * rect.top / (element.clientHeight) + 1,
			zBase,
		]);

		let maxCorner = Vector.create([
			2 * (rect.left + rect.width) / (element.clientWidth) - 1,
			-1 * 2 * (rect.top + rect.height) / (element.clientHeight) + 1,
			zHeight + zBase,
		]);

		objects.push(new Cube(minCorner, maxCorner, nextObjectId++));
	}

  return objects;
}

/**
 * 
 * @param {HTMLElement} background : element to apply the effect to, defaults to the entire body.
 * @param {HTMLElement} raised[]: elevated elements, defaults to children of the background element if one is passed or to children of the body if none.
 */
function rtxOn({background, raised} = {}) {
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
		} else {
			background = document.body;
		}
	}
	

	// remove box shadow on all elements
	for(let el of elements) {
		el.style.boxShadow = 'none';
	}

	// canvas must be square and of power of two
	// use the element largest width / height and round it up to the next power of two
	let size = closestPowerOfTwo(Math.max(background.clientWidth, background.clientHeight));

	const backgroundCanvas = document.createElement('canvas');
	backgroundCanvas.inert = true;
	backgroundCanvas.width = size;
	backgroundCanvas.height = size;
	// TODO: stretch background
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
		lightPosition: [0.8, 0.8, -0.5],
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

export {rtxOn};
