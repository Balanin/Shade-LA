# OBJ Mesh Visualizer

A web-based 3D mesh viewer for OBJ files built with Three.js. This project provides an interactive interface to visualize and analyze 3D mesh geometry.

## Features

- **Interactive 3D Visualization**: Rotate, zoom, and pan around the mesh using mouse controls
- **Material Controls**: Adjust mesh color, opacity, and wireframe display
- **Lighting Controls**: Fine-tune ambient and directional lighting
- **Display Options**: Toggle axes, grid, and vertex normals
- **Mesh Information**: Display vertex count, face count, and bounding box dimensions
- **Export Functionality**: Save the current view as a PNG image

## Usage

1. Open `index.html` in a web browser
2. The viewer will automatically load the boundary.obj file
3. Use mouse controls to navigate:
   - **Left Click + Drag**: Rotate the view
   - **Right Click + Drag**: Pan the view
   - **Scroll**: Zoom in/out
4. Adjust settings using the control panel on the right

## File Structure

```
obj_visualizer/
├── index.html          # Main HTML file with UI layout
├── obj-parser.js       # Custom OBJ file parser
├── viewer.js          # Main Three.js viewer logic
├── README.md          # This file
└── boundary.obj       # The mesh file (referenced from original location)
```

## Technical Details

### OBJ Parser
The custom OBJ parser handles:
- Vertex data (v x y z)
- Face data (f v1/vt1/vn1 v2/vt2/vn2 v3/vt3/vn3)
- Automatic triangulation of faces with more than 3 vertices
- Normal computation for proper lighting

### Three.js Integration
- Uses BufferGeometry for efficient rendering
- Phong material for realistic lighting
- OrbitControls for smooth camera navigation
- Shadow mapping for depth perception

## Browser Compatibility

This viewer requires a modern web browser with WebGL support:
- Chrome 60+
- Firefox 55+
- Safari 12+
- Edge 79+

## Customization

### Loading Different OBJ Files
To load a different OBJ file, modify the file path in `viewer.js`:

```javascript
const response = await fetch('path/to/your/mesh.obj');
```

### Adjusting Initial Camera Position
The camera automatically positions itself based on the mesh bounds. To override this, modify the `fitCameraToMesh` function in `viewer.js`.

### Adding New Controls
Add new control elements to `index.html` and implement corresponding functions in `viewer.js`.

## Dependencies

- Three.js r128 (loaded from CDN)
- OrbitControls (Three.js extension)
- OBJLoader (Three.js extension - for reference, custom parser used)

## Performance Notes

- Large meshes (>100k vertices) may impact performance
- Wireframe mode adds additional geometry overhead
- Normal visualization can be expensive for complex meshes
