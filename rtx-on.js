import {makePathTracer, Cube} from 'webgl-path-tracing';
import { Vector } from 'sylvester';

const zHeight = 0.1;

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

	const canvas = document.createElement('canvas');
	canvas.width = element.clientWidth;
	canvas.height = element.clientHeight;
	canvas.style.position = 'absolute';
	canvas.style.top = '0';
	canvas.style.left = '0';
	canvas.style.zIndex = '-1';
	element.appendChild(canvas);

	const ui = makePathTracer(canvas, makeScene(element, elements));

}

export {rtxOn};
