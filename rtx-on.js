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
 * @param {String} selector: CSS selector for elevated elements, defaults to children of the passed element.
 * @param {String} backgroundElement : element to apply the effect to, defaults to the entire body.
 */
function rtxOn(selector, backgroundElement) {
	if(!backgroundElement) backgroundElement = document.body;

	let elements;
	if(selector) {
		elements = backgroundElement.querySelectorAll(selector);
	} else {
		elements = backgroundElement.children;
	}

	// canvas must be square and of power of two
	// use the element largest width / height and round it up to the next power of two
	let size = closestPowerOfTwo(Math.max(backgroundElement.clientWidth, backgroundElement.clientHeight));

	const backgroundCanvas = document.createElement('canvas');
	backgroundCanvas.inert = true;
	backgroundCanvas.width = size;
	backgroundCanvas.height = size;
	// TODO: stretch background
	backgroundCanvas.style.position = 'absolute';
	backgroundCanvas.style.top = '0';
	backgroundCanvas.style.left = '0';
	backgroundCanvas.style.width = `${backgroundElement.clientWidth}px`;
	backgroundCanvas.style.height = `${backgroundElement.clientHeight}px`;
	backgroundCanvas.style.zIndex = '-1';
	backgroundElement.appendChild(backgroundCanvas);

	const config = {
		zoom: 76,
		fov: 1.5,
	}

	const ui = makePathTracer(backgroundCanvas, makeScene(backgroundElement, elements), config, false);

	// listen for resize on the base element or any scene element
	const resizeObserver = new ResizeObserver(() => {
			ui.setObjects(makeScene(backgroundElement, elements));
			backgroundCanvas.style.width = `${backgroundElement.clientWidth}px`;
			backgroundCanvas.style.height = `${backgroundElement.clientHeight}px`;
			// TODO: if element changes size, we could create a bigger / smaller canvas.
	});
	resizeObserver.observe(backgroundElement);
	for(let el of elements) {
		resizeObserver.observe(el);
	}
}

export {rtxOn};
