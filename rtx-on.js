import * as THREE from 'three';

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

  const canvas = document.createElement('canvas');
  element.style.background = `url(${canvas.toDataURL()})`;
  element.style.backgroundSize = 'cover';

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.z = 5;

  // TODO: replace with boxes for each elements
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
  const cube = new THREE.Mesh(geometry, material);
  scene.add(cube);

  function animate() {
    requestAnimationFrame(animate);

    // Update the cube's rotation
    cube.rotation.x += 0.01;
    cube.rotation.y += 0.01;

    // Render the scene
    renderer.render(scene, camera);

    // Update the background with the rendered canvas
    element.style.backgroundImage = `url(${canvas.toDataURL()})`;
  }

  animate();
}

export {rtxOn};