let scene, camera, renderer, controls;
let mesh, wireframeMesh;
let ambientLight, directionalLight;
let axesHelper, gridHelper;
let normalsHelper;

// Configuration
const config = {
    showWireframe: false,
    showAxes: true,
    showGrid: true,
    showNormals: false,
    meshColor: '#4CAF50',
    opacity: 1.0,
    rotation: { x: 0, y: 0, z: 0 }
};

async function init() {
    // Create scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);
    
    // Create camera
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 10000);
    camera.position.set(100, 100, 100);
    
    // Create renderer
    const viewer = document.getElementById('viewer');
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(viewer.clientWidth, viewer.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    viewer.appendChild(renderer.domElement);
    
    // Create controls
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    
    // Create lighting
    ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambientLight);
    
    directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(50, 100, 50);
    directionalLight.castShadow = true;
    directionalLight.shadow.camera.near = 0.1;
    directionalLight.shadow.camera.far = 1000;
    directionalLight.shadow.camera.left = -200;
    directionalLight.shadow.camera.right = 200;
    directionalLight.shadow.camera.top = 200;
    directionalLight.shadow.camera.bottom = -200;
    scene.add(directionalLight);
    
    // Create helpers
    axesHelper = new THREE.AxesHelper(50);
    scene.add(axesHelper);
    
    gridHelper = new THREE.GridHelper(500, 50, 0x444444, 0x222222);
    scene.add(gridHelper);

    // Load the OBJ file (skip auto-fetch when opened via file://)
    if (window.location && window.location.protocol !== 'file:') {
        await loadOBJFile();
    } else {
        const loadingEl = document.getElementById('loading');
        if (loadingEl) {
            loadingEl.textContent = 'Select an OBJ file to load...';
        }
    }

    // File input handler
    const objFileInput = document.getElementById('objFileInput');
    if (objFileInput) {
        objFileInput.addEventListener('change', handleOBJFileSelection);
    }
    
    // Start animation loop
    animate();
    
    // Handle window resize
    window.addEventListener('resize', onWindowResize);
    
    // Hide loading message
    if (window.location && window.location.protocol !== 'file:') {
        document.getElementById('loading').style.display = 'none';
    }
}

async function loadOBJFile() {
    try {
        // Fetch the OBJ file
        const response = await fetch('boundary.obj');
        const objText = await response.text();

        loadOBJText(objText);
        
    } catch (error) {
        console.error('Error loading OBJ file:', error);
        document.getElementById('loading').textContent = 'Error loading mesh file';
    }
}

function loadOBJText(objText) {
    // Remove previous mesh objects
    if (normalsHelper) {
        scene.remove(normalsHelper);
        normalsHelper = null;
    }
    if (mesh) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
        mesh = null;
    }
    if (wireframeMesh) {
        scene.remove(wireframeMesh);
        wireframeMesh.geometry.dispose();
        wireframeMesh.material.dispose();
        wireframeMesh = null;
    }

    // Parse OBJ data
    const objData = OBJParser.parseOBJ(objText);
    const geometry = OBJParser.createGeometry(objData);

    // Get geometry info
    const info = OBJParser.getGeometryInfo(geometry);
    updateInfoDisplay(info);

    // Create material
    const material = new THREE.MeshPhongMaterial({
        color: config.meshColor,
        opacity: config.opacity,
        transparent: config.opacity < 1.0,
        side: THREE.DoubleSide
    });

    // Create mesh
    mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    mesh.rotation.set(config.rotation.x, config.rotation.y, config.rotation.z);
    scene.add(mesh);

    // Create wireframe version
    const wireframeMaterial = new THREE.MeshBasicMaterial({
        color: 0x00ff00,
        wireframe: true,
        transparent: true,
        opacity: 0.3
    });
    wireframeMesh = new THREE.Mesh(geometry.clone(), wireframeMaterial);
    wireframeMesh.rotation.set(config.rotation.x, config.rotation.y, config.rotation.z);
    wireframeMesh.visible = config.showWireframe;
    scene.add(wireframeMesh);

    // Position camera to fit the mesh
    fitCameraToMesh(info);

    // Create normals helper if needed
    if (config.showNormals) {
        updateNormalsHelper();
    }
}

function handleOBJFileSelection(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
        const text = typeof reader.result === 'string' ? reader.result : '';
        if (text) {
            loadOBJText(text);
        }
    };
    reader.onerror = () => {
        console.error('Error reading file:', reader.error);
    };
    reader.readAsText(file);
}

function updateInfoDisplay(info) {
    document.getElementById('vertexCount').textContent = info.vertices;
    document.getElementById('faceCount').textContent = info.faces;
    
    const bounds = info.bounds;
    const boundsText = `Size: ${bounds.size.x.toFixed(1)} × ${bounds.size.y.toFixed(1)} × ${bounds.size.z.toFixed(1)}`;
    document.getElementById('bounds').textContent = boundsText;
}

function fitCameraToMesh(info) {
    const center = info.bounds.center;
    const size = Math.max(info.bounds.size.x, info.bounds.size.y, info.bounds.size.z);
    const distance = size * 2;
    
    camera.position.set(center.x + distance, center.y + distance, center.z + distance);
    controls.target.copy(center);
    controls.update();
}

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

function onWindowResize() {
    const viewer = document.getElementById('viewer');
    camera.aspect = viewer.clientWidth / viewer.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(viewer.clientWidth, viewer.clientHeight);
}

// Control functions
function resetCamera() {
    if (mesh) {
        const geometry = mesh.geometry;
        geometry.computeBoundingBox();
        const info = OBJParser.getGeometryInfo(geometry);
        fitCameraToMesh(info);
    }
}

function toggleWireframe() {
    config.showWireframe = !config.showWireframe;
    if (wireframeMesh) {
        wireframeMesh.visible = config.showWireframe;
    }
}

function updateMeshColor() {
    const color = document.getElementById('meshColor').value;
    config.meshColor = color;
    if (mesh) {
        mesh.material.color.set(color);
    }
}

function updateOpacity() {
    const opacity = parseFloat(document.getElementById('opacity').value);
    config.opacity = opacity;
    document.getElementById('opacityValue').textContent = opacity.toFixed(1);
    
    if (mesh) {
        mesh.material.opacity = opacity;
        mesh.material.transparent = opacity < 1.0;
    }
}

function updateLighting() {
    const ambientIntensity = parseFloat(document.getElementById('ambientLight').value);
    const directionalIntensity = parseFloat(document.getElementById('directionalLight').value);
    
    document.getElementById('ambientValue').textContent = ambientIntensity.toFixed(1);
    document.getElementById('directionalValue').textContent = directionalIntensity.toFixed(1);
    
    if (ambientLight) {
        ambientLight.intensity = ambientIntensity;
    }
    if (directionalLight) {
        directionalLight.intensity = directionalIntensity;
    }
}

function toggleAxes() {
    config.showAxes = !config.showAxes;
    if (axesHelper) {
        axesHelper.visible = config.showAxes;
    }
}

function toggleGrid() {
    config.showGrid = !config.showGrid;
    if (gridHelper) {
        gridHelper.visible = config.showGrid;
    }
}

function toggleNormals() {
    config.showNormals = !config.showNormals;
    updateNormalsHelper();
}

function updateNormalsHelper() {
    if (normalsHelper) {
        scene.remove(normalsHelper);
        normalsHelper = null;
    }
    
    if (config.showNormals && mesh) {
        normalsHelper = new THREE.VertexNormalsHelper(mesh, 10, 0xff0000);
        scene.add(normalsHelper);
    }
}

// Rotation control functions
function alignToX() {
    setRotation(0, 0, -Math.PI / 2);
}

function alignToY() {
    setRotation(-Math.PI / 2, 0, 0);
}

function alignToZ() {
    setRotation(0, 0, 0);
}

function resetRotation() {
    setRotation(-Math.PI / 2, 0, 0); // Default Y-up alignment
}

function setRotation(x, y, z) {
    config.rotation.x = x;
    config.rotation.y = y;
    config.rotation.z = z;
    
    if (mesh) {
        mesh.rotation.set(x, y, z);
    }
    if (wireframeMesh) {
        wireframeMesh.rotation.set(x, y, z);
    }
    
    // Update UI sliders
    document.getElementById('rotationX').value = THREE.MathUtils.radToDeg(x);
    document.getElementById('rotationY').value = THREE.MathUtils.radToDeg(y);
    document.getElementById('rotationZ').value = THREE.MathUtils.radToDeg(z);
    
    document.getElementById('rotationXValue').textContent = Math.round(THREE.MathUtils.radToDeg(x)) + '°';
    document.getElementById('rotationYValue').textContent = Math.round(THREE.MathUtils.radToDeg(y)) + '°';
    document.getElementById('rotationZValue').textContent = Math.round(THREE.MathUtils.radToDeg(z)) + '°';
    
    // Update normals helper if visible
    if (config.showNormals) {
        updateNormalsHelper();
    }
}

function updateRotation() {
    const rotX = THREE.MathUtils.degToRad(parseFloat(document.getElementById('rotationX').value));
    const rotY = THREE.MathUtils.degToRad(parseFloat(document.getElementById('rotationY').value));
    const rotZ = THREE.MathUtils.degToRad(parseFloat(document.getElementById('rotationZ').value));
    
    setRotation(rotX, rotY, rotZ);
}

function exportScene() {
    renderer.render(scene, camera);
    const dataURL = renderer.domElement.toDataURL('image/png');
    
    const link = document.createElement('a');
    link.download = 'mesh-visualization.png';
    link.href = dataURL;
    link.click();
}

// Initialize the viewer when the page loads
window.addEventListener('load', init);
