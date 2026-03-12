class OBJParser {
    static parseOBJ(text) {
        const vertices = [];
        const faces = [];
        
        const lines = text.split('\n');
        
        for (const line of lines) {
            const lineTrimmed = line.trim();
            if (!lineTrimmed || lineTrimmed.startsWith('#')) continue;
            
            const parts = lineTrimmed.split(/\s+/);
            const type = parts[0];
            
            switch (type) {
                case 'v':
                    vertices.push(
                        parseFloat(parts[1]),
                        parseFloat(parts[2]),
                        parseFloat(parts[3])
                    );
                    break;
                    
                case 'f':
                    const face = [];
                    for (let i = 1; i < parts.length; i++) {
                        const vertexIndex = parseInt(parts[i].split('/')[0]) - 1;
                        face.push(vertexIndex);
                    }
                    
                    // Triangulate face if it has more than 3 vertices
                    for (let i = 1; i < face.length - 1; i++) {
                        faces.push(face[0], face[i], face[i + 1]);
                    }
                    break;
            }
        }
        
        return { vertices, faces };
    }
    
    static createGeometry(data) {
        const geometry = new THREE.BufferGeometry();
        
        // Convert to Float32Array for Three.js
        const vertices = new Float32Array(data.vertices);
        const indices = new Uint32Array(data.faces);
        
        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        
        // Compute normals for proper lighting
        geometry.computeVertexNormals();
        
        // Compute bounding box for camera positioning
        geometry.computeBoundingBox();
        
        return geometry;
    }
    
    static getGeometryInfo(geometry) {
        const vertices = geometry.attributes.position.count;
        const faces = geometry.index.count / 3;
        const boundingBox = geometry.boundingBox;
        
        return {
            vertices,
            faces,
            bounds: {
                min: boundingBox.min,
                max: boundingBox.max,
                size: boundingBox.max.clone().sub(boundingBox.min),
                center: boundingBox.getCenter(new THREE.Vector3())
            }
        };
    }
}
