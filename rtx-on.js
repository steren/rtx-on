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

	for (let el = 0; el < elements.length; el++) {
		let rect = elements[el].getBoundingClientRect();
		let x = rect.left + (rect.width / 2);
		let y = rect.top + (rect.height / 2);
		// ignore elements that have no height or width
		if(rect.height === 0 || rect.width === 0) continue;
		console.log(x, y);
	}

  // const canvas = document.createElement('canvas');
  // element.style.background = `url(${canvas.toDataURL()})`;
  // element.style.backgroundSize = 'cover';
    
  // function animate() {
  //   requestAnimationFrame(animate);
  //   // Update the background with the rendered canvas
  //   element.style.backgroundImage = `url(${canvas.toDataURL()})`;
  // }

  // animate();
}

export {rtxOn};