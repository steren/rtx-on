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
  var objects = [];
  let nextObjectId = 0;

	for (let el = 0; el < elements.length; el++) {
		let rect = elements[el].getBoundingClientRect();
		// ignore elements that have no height or width
		if(rect.height === 0 || rect.width === 0) continue;

		// FIXME: handle scroll position
		let minCorner = Vector.create([
			2 * rect.left / (element.clientWidth) - 1,
			-1 * 2 * rect.top / (element.clientHeight) + 1,
			-1,
		]);

		let maxCorner = Vector.create([
			2 * (rect.left + rect.width) / (element.clientWidth) - 1,
			-1 * 2 * (rect.top + rect.height) / (element.clientHeight) + 1,
			zHeight -1,
		]);

		objects.push(new Cube(minCorner, maxCorner, nextObjectId++));
	}

  return objects;
}

/**
 * 
 * @param {String} selector: CSS selector for elevated elements, defaults to children of the passed element.
 * @param {String} element : element to apply the effect to, defaults to the entire body.
 */
function rtxOn(selector, element) {
	if(!element) element = document.body;

	let elements;
	if(selector) {
		elements = element.querySelectorAll(selector);
	} else {
		elements = element.children;
	}

	// canvas must be square and of power of two
	// use the element largest width / height and round it up to the next power of two
	let size = closestPowerOfTwo(Math.max(element.clientWidth, element.clientHeight));

	const backgroundCanvas = document.createElement('canvas');
	backgroundCanvas.width = size;
	backgroundCanvas.height = size;
	// TODO: stretch background
	backgroundCanvas.style.position = 'absolute';
	backgroundCanvas.style.top = '0';
	backgroundCanvas.style.left = '0';
	backgroundCanvas.style.width = `${element.clientWidth}px`;
	backgroundCanvas.style.height = `${element.clientHeight}px`;
	backgroundCanvas.style.zIndex = '-1';
	element.appendChild(backgroundCanvas);

	const ui = makePathTracer(backgroundCanvas, makeScene(element, elements), {}, false);

	// copy 

}

export {rtxOn};
